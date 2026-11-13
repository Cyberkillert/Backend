'use strict';
const router = require('express').Router();
const { db, admin } = require('../config/firebase');
const { requireUser, requireSeller } = require('../middleware/auth');
const { validate, Schemas } = require('../middleware/validate');
const { auditLog } = require('../middleware/audit');
const L = require('../utils/lifecycle');
const FV = admin.firestore.FieldValue, Timestamp = admin.firestore.Timestamp;

// POST /api/orders — server-side pricing. A mixed cart becomes one order per seller.
router.post('/', requireUser, validate(Schemas.orderCreate || {}), async (req, res) => {
  try {
    const { items, address, payment, couponCode } = req.body;
    const ids = [...new Set(items.map(i => i.productId))];
    const pdocs = await Promise.all(ids.map(id => db.collection('products').doc(id).get()));
    const pmap = {}; pdocs.forEach(d => { if (d.exists) pmap[d.id] = d.data(); });

    const need = {};
    for (const item of items) {
      const p = pmap[item.productId];
      if (!p || p.status !== 'active') return res.status(400).json({ error: `Product ${item.productId} unavailable` });
      let have = p.stock || 0;
      if (p.variants?.length && (item.size || item.color)) {
        const v = p.variants.find(v => (!item.size || v.size === item.size) && (!item.color || v.color === item.color));
        if (!v) return res.status(400).json({ error: `Variant not available for "${p.name}"` });
        have = v.stock || 0;
      }
      const key = `${item.productId}|${item.size || ''}|${item.color || ''}`; need[key] = (need[key] || 0) + item.qty;
      if (have < need[key]) return res.status(400).json({ error: `Insufficient stock for "${p.name}"` });
    }
    const orderItems = items.map(item => {
      const p = pmap[item.productId];
      return { productId: item.productId, name: p.name, price: p.price, qty: item.qty, image: p.images?.[0] || '', size: item.size || '', color: item.color || '',
        sellerId: p.sellerId || '', sellerName: p.sellerName || '', deliveryFee: p.deliveryFee || 0, freeDeliveryAbove: p.freeDeliveryAbove || 0,
        deliveryMinutes: p.deliveryMinutes || 0, variants: p.variants || [], sizes: p.sizes || [], colors: p.colors || [] };
    });
    const groups = {}; orderItems.forEach(i => { (groups[i.sellerId] = groups[i.sellerId] || []).push(i); });
    const keys = Object.keys(groups);
    const subs = keys.map(k => groups[k].reduce((s, i) => s + i.price * i.qty, 0));
    const fees = keys.map((k, n) => { const g = groups[k]; const fee = g[0].deliveryFee, free = g[0].freeDeliveryAbove; return (!free || subs[n] < free) ? fee : 0; });
    const subtotal = subs.reduce((a, b) => a + b, 0);

    let couponDiscount = 0, appliedCouponId = null;
    if (couponCode) {
      const csnap = await db.collection('coupons').where('code', '==', couponCode.toUpperCase()).where('active', '==', true).limit(1).get();
      if (!csnap.empty) {
        const c = csnap.docs[0].data();
        if ((!c.expiresAt || c.expiresAt.toDate() > new Date()) && (!c.minOrder || subtotal >= c.minOrder)) {
          couponDiscount = c.discountType === 'percent' ? Math.min(subtotal * c.discountValue / 100, c.maxDiscount || Infinity) : c.discountValue;
          couponDiscount = Math.round(Math.min(couponDiscount, subtotal)); appliedCouponId = csnap.docs[0].id;
        }
      }
    }
    let defRate = 0; const sd = await db.collection('settings').doc('app').get(); if (sd.exists) defRate = sd.data().globalCommission || 0;
    const rates = await Promise.all(keys.map(async k => { if (!k) return defRate; const c = await db.collection('commissions').doc(k).get(); return c.exists ? (c.data().rate || 0) : defRate; }));

    const groupId = Date.now().toString(36).toUpperCase(), batch = db.batch(), out = []; let given = 0;
    keys.forEach((k, n) => {
      const share = n === keys.length - 1 ? couponDiscount - given : Math.round(couponDiscount * subs[n] / (subtotal || 1)); given += share;
      const ref = db.collection('orders').doc(), otp = L.newOtp(), total = Math.max(0, subs[n] + fees[n] - share);
      const orderId = groupId + (keys.length > 1 ? `-${n + 1}` : '');
      batch.set(ref, { orderId, groupId, groupCount: keys.length, userId: req.uid, userEmail: req.email, sellerId: k, sellerIds: k ? [k] : [],
        items: groups[k], address, pinCode: address.pincode || '', payment, subtotal: subs[n], deliveryFee: fees[n],
        couponCode: appliedCouponId ? couponCode.toUpperCase() : null, couponDiscount: share, total, commissionAmount: Math.round(subs[n] * rates[n] / 100),
        status: 'pending', otpHash: L.otpHash(ref.id, otp), otpVerified: false, otpAttempts: 0, deliveryPartnerId: null, stockReserved: false, stockRestored: false,
        statusHistory: [{ status: 'pending', by: req.uid, role: 'customer', note: 'Order placed', at: Timestamp.now() }],
        createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
      batch.set(ref.collection('secrets').doc('otp'), { otp, userId: req.uid });
      out.push({ id: ref.id, orderId, total, seller: k });
    });
    await batch.commit();
    if (appliedCouponId) await db.collection('couponClaims').add({ couponId: appliedCouponId, userId: req.uid, orderId: out[0].id, createdAt: FV.serverTimestamp() });
    await Promise.all(out.filter(o => o.seller).map(o => L.notify(o.seller, 'New order received', `Order #${o.orderId} is waiting. Accept it to reserve the stock.`, o.id, 'order')));
    res.status(201).json({ orders: out.map(({ seller, ...o }) => o), total: out.reduce((s, o) => s + o.total, 0), couponDiscount });
  } catch (e) { console.error('Order error:', e); res.status(500).json({ error: 'Failed to place order' }); }
});

router.get('/me', requireUser, async (req, res) => {
  try {
    const snap = await db.collection('orders').where('userId', '==', req.uid).orderBy('createdAt', 'desc').limit(50).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), otpHash: undefined })));
  } catch (e) { res.status(500).json({ error: 'Failed to load orders' }); }
});

router.get('/seller/list', requireSeller, async (req, res) => {
  try {
    const snap = await db.collection('orders').where('sellerId', '==', req.uid).orderBy('createdAt', 'desc').limit(200).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), otpHash: undefined })));
  } catch (e) { res.status(500).json({ error: 'Failed to load orders' }); }
});

router.get('/:id', requireUser, async (req, res) => {
  try {
    const doc = await db.collection('orders').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Order not found' });
    if (doc.data().userId !== req.uid) return res.status(403).json({ error: 'Forbidden' });
    const sec = await doc.ref.collection('secrets').doc('otp').get();
    res.json({ id: doc.id, ...doc.data(), otpHash: undefined, deliveryOtp: sec.exists ? sec.data().otp : undefined });
  } catch (e) { res.status(500).json({ error: 'Failed to load order' }); }
});

router.post('/:id/cancel', requireUser, validate(Schemas.orderCancel || {}), async (req, res) => {
  try {
    const o = await L.transition(req.params.id, 'cancelled', { actor: 'customer', uid: req.uid, note: req.body.reason, expectFrom: ['pending'] });
    L.notify(o.sellerId, 'Order cancelled by customer', `Order #${o.orderId} was cancelled. Reason: ${req.body.reason}`, o.id, 'order');
    await auditLog(req.uid, 'order_cancel', { orderId: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed to cancel order' }); }
});

router.patch('/:id/status', requireSeller, validate(Schemas.orderStatus || {}), async (req, res) => {
  try {
    const { status, reason } = req.body;
    const o = await L.transition(req.params.id, status, { actor: 'seller', uid: req.uid, note: status === 'cancelled' ? (reason || 'Cancelled by seller') : '' });
    const msg = { accepted: ['Order accepted', `Your order #${o.orderId} was accepted.`], packed: ['Order packed', `Your order #${o.orderId} is packed and waiting for a delivery partner.`], cancelled: ['Order cancelled by seller', `Your order #${o.orderId} was cancelled. Reason: ${reason || 'N/A'}`] }[status];
    if (msg) await L.notify(o.userId, msg[0], msg[1], o.id, 'order');
    await auditLog(req.uid, `order_${status}`, { orderId: req.params.id });
    res.json({ success: true, status });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed to update order status' }); }
});

module.exports = router;
