'use strict';
/* Order lifecycle — server copy of the rules in the frontend's shared/js/orders.js.
   pending → accepted → packed → shipped → out_for_delivery → delivered
   Stock is reserved when the seller ACCEPTS and restored on cancel / return.
   The delivery code is stored as a salted SHA-256 hash; the plain code lives in orders/{id}/secrets/otp. */
const crypto = require('crypto');
const { db, admin } = require('../config/firebase');
const FV = admin.firestore.FieldValue, Timestamp = admin.firestore.Timestamp;

const FLOW = {
  pending: ['accepted', 'cancelled'],
  accepted: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery', 'packed', 'cancelled'],
  out_for_delivery: ['delivered', 'returned', 'cancelled'],
};
const TERMINAL = ['delivered', 'cancelled', 'returned'];
const MAX_ACTIVE_PER_PARTNER = 5, OTP_MAX_TRIES = 5;

const otpHash = (orderId, otp) => crypto.createHash('sha256').update(`sw1:${orderId}:${String(otp).trim()}`).digest('hex');
const newOtp = () => String(crypto.randomInt(100000, 1000000));
const chunk = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };
const history = (status, by, role, note) => FV.arrayUnion({ status, by: by || '', role: role || '', note: note || '', at: Timestamp.now() });

function next(status, actor) {
  const n = FLOW[status] || [];
  if (actor === 'admin') return n;
  if (actor === 'customer') return status === 'pending' ? ['cancelled'] : [];
  if (actor === 'seller') return ['pending', 'accepted'].includes(status) ? n.filter(s => ['accepted', 'packed', 'cancelled'].includes(s)) : [];
  if (actor === 'delivery') return ['packed', 'shipped', 'out_for_delivery'].includes(status) ? n.filter(s => s !== 'cancelled') : [];
  return [];
}

async function planStock(tx, items, sign) {
  const ids = [...new Set(items.map(i => i.productId).filter(Boolean))];
  const refs = ids.map(id => db.collection('products').doc(id));
  const snaps = await Promise.all(refs.map(r => tx.get(r)));
  const prod = {}; snaps.forEach((s, i) => { if (s.exists) prod[ids[i]] = { ref: refs[i], data: s.data() }; });
  const writes = {};
  for (const it of items) {
    const p = prod[it.productId]; if (!p) continue;
    const w = writes[it.productId] || (writes[it.productId] = { ref: p.ref, stock: p.data.stock || 0, variants: p.data.variants ? p.data.variants.map(v => ({ ...v })) : null, touched: false });
    const q = it.qty || 1;
    if (w.variants && w.variants.length && (it.size || it.color)) {
      const v = w.variants.find(v => (!it.size || v.size === it.size) && (!it.color || v.color === it.color));
      if (v) {
        if (sign < 0 && (v.stock || 0) < q) throw new Error(`Only ${v.stock || 0} left of "${it.name}"`);
        v.stock = (v.stock || 0) + sign * q; w.stock = w.variants.reduce((s, x) => s + (x.stock || 0), 0); w.touched = true; continue;
      }
    }
    if (sign < 0 && w.stock < q) throw new Error(`Only ${w.stock} left of "${it.name}"`);
    w.stock += sign * q; w.touched = true;
  }
  return () => Object.values(writes).filter(w => w.touched).forEach(w => tx.update(w.ref, w.variants ? { stock: w.stock, variants: w.variants } : { stock: w.stock }));
}

/* ctx: { actor, uid, note, extra, expectFrom } — the server may write stock for every actor. */
async function transition(orderId, to, ctx) {
  const ref = db.collection('orders').doc(orderId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref); if (!snap.exists) { const e = new Error('Order not found'); e.status = 404; throw e; }
    const o = { id: snap.id, ...snap.data() };
    const fail = (m, c) => { const e = new Error(m); e.status = c || 400; throw e; };
    if (ctx.expectFrom && !ctx.expectFrom.includes(o.status)) fail(`Order is already ${o.status}`, 409);
    if (!next(o.status, ctx.actor).includes(to)) fail(`Cannot move an order from ${o.status} to ${to}`);
    if (ctx.actor === 'customer' && o.userId !== ctx.uid) fail('Forbidden', 403);
    if (ctx.actor === 'seller' && o.sellerId !== ctx.uid && !(o.sellerIds || []).includes(ctx.uid)) fail('Forbidden', 403);
    if (ctx.actor === 'delivery' && o.deliveryPartnerId !== ctx.uid) fail('Forbidden', 403);
    const upd = { status: to, updatedAt: FV.serverTimestamp(), statusHistory: history(to, ctx.uid, ctx.actor, ctx.note), ...(ctx.extra || {}) };
    let apply = null;
    if (to === 'accepted') { apply = await planStock(tx, o.items || [], -1); upd.stockReserved = true; upd.stockRestored = false; upd.acceptedAt = FV.serverTimestamp(); }
    if (to === 'packed' && o.status === 'accepted') upd.packedAt = FV.serverTimestamp();
    if (to === 'packed' && o.status === 'shipped') { upd.deliveryPartnerId = null; upd.deliveryPartnerName = null; upd.deliveryPartnerPhone = null; upd.releasedBy = ctx.uid; }
    if (to === 'cancelled' || to === 'returned') {
      if (o.stockReserved && !o.stockRestored) { apply = await planStock(tx, o.items || [], +1); upd.stockRestored = true; upd.needsRestock = false; }
      if (to === 'cancelled') { upd.cancelledAt = FV.serverTimestamp(); upd.cancelledBy = ctx.actor; if (ctx.note) upd.cancelReason = ctx.note; }
      if (to === 'returned') { upd.returnedAt = FV.serverTimestamp(); if (ctx.note) upd.returnReason = ctx.note; }
    }
    if (to === 'delivered') upd.deliveredAt = FV.serverTimestamp();
    if (apply) apply();
    tx.update(ref, upd);
    return o;
  });
}

async function notify(userId, title, message, orderId, type, panel) {
  if (!userId) return;
  await db.collection('notifications').add({ target: 'specific', targetUserId: userId, title, message, orderId: orderId || null, type: type || 'order', panel: panel || 'user', active: true, sentBy: 'system', createdAt: FV.serverTimestamp() }).catch(() => {});
}

async function notifyZone(o, title, message) {
  if (!o.pinCode) return;
  await db.collection('notifications').add({ target: 'zone', pinCode: String(o.pinCode), title: title || 'Order ready for pickup', message: message || `Order #${o.orderId} is packed and waiting in ${o.pinCode}.`, orderId: o.id, type: 'delivery', panel: 'delivery', key: 'pk-' + o.id, active: true, sentBy: 'system', createdAt: FV.serverTimestamp() }).catch(() => {});
}

module.exports = { notifyZone, FLOW, TERMINAL, MAX_ACTIVE_PER_PARTNER, OTP_MAX_TRIES, otpHash, newOtp, chunk, history, next, transition, notify };
