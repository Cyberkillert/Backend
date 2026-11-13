'use strict';
const router = require('express').Router();
const {db, FieldValue} = require('../config/firebase');
const { requireDelivery } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

router.get('/available', requireDelivery, async (req,res) => {
  try {
    const pins = req.partner.activePincodes||[];
    if (!pins.length) return res.json([]);
    const snap = await db.collection('orders').where('status','==','packed').where('pinCode','in',pins.slice(0,10)).orderBy('createdAt').limit(20).get();
    res.json(snap.docs.filter(d=>!d.data().deliveryPartnerId).map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed to load orders' }); }
});

router.get('/my-orders', requireDelivery, async (req,res) => {
  try {
    const snap = await db.collection('orders').where('deliveryPartnerId','==',req.uid).orderBy('createdAt','desc').limit(50).get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed to load orders' }); }
});

router.post('/pickup/:orderId', requireDelivery, async (req,res) => {
  try {
    const ref = db.collection('orders').doc(req.params.orderId);
    await db.runTransaction(async t => {
      const doc = await t.get(ref);
      if (!doc.exists) throw new Error('Order not found');
      if (doc.data().deliveryPartnerId) throw new Error('Already claimed');
      if (doc.data().status!=='packed') throw new Error('Order not ready');
      t.update(ref,{ deliveryPartnerId:req.uid, deliveryPartnerName:req.partner.name||'', deliveryPartnerPhone:req.partner.phone||'', status:'shipped', updatedAt:FieldValue.serverTimestamp() });
    });
    await auditLog(req.uid,'order_pickup',{ orderId:req.params.orderId });
    res.json({ success:true });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

router.patch('/status/:orderId', requireDelivery, async (req,res) => {
  try {
    const { status } = req.body;
    if (!['out_for_delivery'].includes(status)) return res.status(400).json({ error:'Invalid status' });
    const ref = db.collection('orders').doc(req.params.orderId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error:'Not found' });
    if (doc.data().deliveryPartnerId!==req.uid) return res.status(403).json({ error:'Forbidden' });
    const otp = doc.data().deliveryOtp || String(Math.floor(100000+Math.random()*900000));
    await ref.update({ status, deliveryOtp:otp, otpVerified:false, updatedAt:FieldValue.serverTimestamp() });
    if (doc.data().userId) {
      await db.collection('notifications').add({ targetUserId:doc.data().userId, title:'🚚 Out for Delivery!', message:`Your order #${doc.data().orderId} is out for delivery. OTP: ${otp}`, type:'delivery', active:true, orderId:req.params.orderId, createdAt:FieldValue.serverTimestamp() });
    }
    res.json({ success:true, otp });
  } catch(e) { res.status(500).json({ error:'Failed to update status' }); }
});

router.post('/verify-otp/:orderId', requireDelivery, async (req,res) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error:'OTP required' });
    const ref = db.collection('orders').doc(req.params.orderId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error:'Not found' });
    const data = doc.data();
    if (data.deliveryPartnerId!==req.uid) return res.status(403).json({ error:'Forbidden' });
    if (String(otp).trim()!==String(data.deliveryOtp).trim()) return res.status(400).json({ error:'Incorrect OTP' });
    await ref.update({ status:'delivered', otpVerified:true, deliveredAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp() });
    // Decrement stock
    const batch = db.batch();
    for (const item of data.items||[]) {
      if (!item.productId) continue;
      batch.update(db.collection('products').doc(item.productId),{ stock:FieldValue.increment(-(item.qty||1)) });
    }
    await batch.commit();
    if (data.userId) {
      await db.collection('notifications').add({ targetUserId:data.userId, title:'🎉 Order Delivered!', message:`Your order #${data.orderId} has been delivered!`, type:'delivery', active:true, orderId:req.params.orderId, createdAt:FieldValue.serverTimestamp() });
    }
    await auditLog(req.uid,'order_delivered',{ orderId:req.params.orderId });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Failed to verify OTP' }); }
});

module.exports = router;
