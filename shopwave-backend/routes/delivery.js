'use strict';
const router = require('express').Router();
const { db, admin } = require('../config/firebase');
const { requireDelivery } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const L = require('../utils/lifecycle');
const FV = admin.firestore.FieldValue, Timestamp = admin.firestore.Timestamp;
const strip = o => ({ ...o, otpHash: undefined, deliveryOtp: undefined });

router.get('/available', requireDelivery, async (req, res) => {
  try {
    const pins = req.partner.activePincodes || [];
    if (!pins.length || !req.partner.isOnline) return res.json([]);
    const snaps = await Promise.all(L.chunk(pins, 10).map(c => db.collection('orders').where('status', '==', 'packed').where('pinCode', 'in', c).get()));
    const seen = new Map(); snaps.forEach(s => s.docs.forEach(d => { if (!d.data().deliveryPartnerId) seen.set(d.id, { id: d.id, ...d.data() }); }));
    // Before pickup the partner only needs the area, not the customer's phone or street.
    res.json([...seen.values()].map(o => strip({ ...o, address: { city: o.address?.city, pincode: o.address?.pincode } })));
  } catch (e) { res.status(500).json({ error: 'Failed to load orders' }); }
});

router.get('/my-orders', requireDelivery, async (req, res) => {
  try {
    const snap = await db.collection('orders').where('deliveryPartnerId', '==', req.uid).orderBy('createdAt', 'desc').limit(100).get();
    res.json(snap.docs.map(d => strip({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: 'Failed to load orders' }); }
});

router.post('/pickup/:orderId', requireDelivery, async (req, res) => {
  try {
    const active = await db.collection('orders').where('deliveryPartnerId', '==', req.uid).where('status', 'in', ['shipped', 'out_for_delivery']).get();
    if (active.size >= L.MAX_ACTIVE_PER_PARTNER) return res.status(400).json({ error: `You already carry ${active.size} orders` });
    const ref = db.collection('orders').doc(req.params.orderId);
    const o = await db.runTransaction(async t => {
      const doc = await t.get(ref);
      if (!doc.exists) throw new Error('Order not found');
      const d = doc.data();
      if (d.deliveryPartnerId) throw new Error('Already claimed');
      if (d.status !== 'packed') throw new Error('Order not ready');
      if (!(req.partner.activePincodes || []).includes(d.pinCode)) throw new Error('Outside your delivery zone');
      t.update(ref, { deliveryPartnerId: req.uid, deliveryPartnerName: req.partner.name || '', deliveryPartnerPhone: req.partner.phone || '', status: 'shipped', pickedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(), statusHistory: L.history('shipped', req.uid, 'delivery', 'Picked up') });
      return { id: doc.id, ...d };
    });
    L.notify(o.userId, 'Order picked up', `Your order #${o.orderId} was picked up by ${req.partner.name || 'your delivery partner'}.`, o.id, 'delivery');
    await auditLog(req.uid, 'order_pickup', { orderId: req.params.orderId });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// out_for_delivery | packed (hand back) | returned (could not deliver, needs reason)
router.patch('/status/:orderId', requireDelivery, async (req, res) => {
  try {
    const { status, reason } = req.body;
    if (!['out_for_delivery', 'packed', 'returned'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (status !== 'out_for_delivery' && !reason) return res.status(400).json({ error: 'A reason is required' });
    const o = await L.transition(req.params.orderId, status, { actor: 'delivery', uid: req.uid, note: reason || '', extra: status === 'out_for_delivery' ? { otpAttempts: 0 } : {} });
    if (status === 'out_for_delivery') L.notify(o.userId, 'Out for delivery', `Order #${o.orderId} is on its way. Keep your delivery code ready.`, o.id, 'delivery');
    if (status === 'packed') await L.notifyZone(o, 'Order back in the pickup pool', `Order #${o.orderId} was handed back and is ready again in ${o.pinCode}.`);
    if (status === 'returned') { L.notify(o.userId, 'Delivery attempt failed', `We could not deliver order #${o.orderId}. Reason: ${reason}`, o.id, 'delivery'); L.notify(o.sellerId, 'Order returned', `Order #${o.orderId} came back (${reason}). Stock restored.`, o.id, 'delivery', 'seller'); }
    await auditLog(req.uid, `delivery_${status}`, { orderId: req.params.orderId });
    res.json({ success: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed to update status' }); }
});

// The one place the delivery code is checked on a server: attempts are counted and the code is never sent to the partner.
router.post('/verify-otp/:orderId', requireDelivery, async (req, res) => {
  try {
    const otp = String(req.body.otp || '').trim();
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Enter the 6-digit code' });
    const ref = db.collection('orders').doc(req.params.orderId), doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const d = doc.data();
    if (d.deliveryPartnerId !== req.uid) return res.status(403).json({ error: 'Forbidden' });
    if (d.status !== 'out_for_delivery') return res.status(400).json({ error: 'Mark the order out for delivery first' });
    if ((d.otpAttempts || 0) >= L.OTP_MAX_TRIES) return res.status(423).json({ error: 'Too many wrong codes. Contact support.' });
    if (L.otpHash(doc.id, otp) !== d.otpHash) {
      await ref.update({ otpAttempts: FV.increment(1) });
      return res.status(400).json({ error: 'Incorrect code', attemptsLeft: Math.max(0, L.OTP_MAX_TRIES - (d.otpAttempts || 0) - 1) });
    }
    const cod = /cod|cash/i.test(String(d.payment || ''));
    const o = await L.transition(doc.id, 'delivered', { actor: 'delivery', uid: req.uid, note: 'OTP verified', extra: { otpVerified: true, otpAttempts: 0, ...(cod ? { codCollected: true, codAmount: d.total, codSettled: false } : {}) } });
    L.notify(o.userId, 'Order delivered', `Your order #${o.orderId} has been delivered.`, o.id, 'delivery');
    L.notify(o.sellerId, 'Order delivered', `Order #${o.orderId} was delivered.`, o.id, 'delivery', 'seller');
    await auditLog(req.uid, 'order_delivered', { orderId: req.params.orderId });
    res.json({ success: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed to verify code' }); }
});

module.exports = router;
