'use strict';
const router = require('express').Router();
const {db, FieldValue} = require('../config/firebase');
const { requireUser, requireSeller } = require('../middleware/auth');
const { validate, Schemas } = require('../middleware/validate');
const { auditLog } = require('../middleware/audit');

// POST /api/orders — server-side pricing, never trusts client
router.post('/', requireUser, validate(Schemas.orderCreate||{}), async (req,res) => {
  try {
    const { items, address, payment, couponCode } = req.body;
    // Load product prices server-side
    const ids = [...new Set(items.map(i=>i.productId))];
    const pdocs = await Promise.all(ids.map(id=>db.collection('products').doc(id).get()));
    const pmap = {}; pdocs.forEach(d=>{ if(d.exists) pmap[d.id]=d.data(); });
    // Validate each item
    for (const item of items) {
      const p = pmap[item.productId];
      if (!p||p.status!=='active') return res.status(400).json({ error:`Product ${item.productId} unavailable` });
      if (p.stock<item.qty) return res.status(400).json({ error:`Insufficient stock for "${p.name}"` });
      if (p.variants?.length&&(item.size||item.color)) {
        const v = p.variants.find(v=>(!item.size||v.size===item.size)&&(!item.color||v.color===item.color));
        if (!v||v.stock<item.qty) return res.status(400).json({ error:`Variant out of stock for "${p.name}"` });
      }
    }
    // Build order items with server prices
    const orderItems = items.map(item => {
      const p = pmap[item.productId];
      return { productId:item.productId, name:p.name, price:p.price, qty:item.qty,
        image:p.images?.[0]||'', size:item.size||'', color:item.color||'',
        sellerId:p.sellerId||'', sellerName:p.sellerName||'',
        deliveryFee:p.deliveryFee||0, freeDeliveryAbove:p.freeDeliveryAbove||0,
        deliveryMinutes:p.deliveryMinutes||0, variants:p.variants||[],
        sizes:p.sizes||[], colors:p.colors||[] };
    });
    const subtotal = orderItems.reduce((s,i)=>s+i.price*i.qty, 0);
    // Delivery fee — per seller group
    const sgroups = {};
    orderItems.forEach(i=>{ if(!sgroups[i.sellerId]) sgroups[i.sellerId]={items:[],fee:i.deliveryFee,freeAbove:i.freeDeliveryAbove}; sgroups[i.sellerId].items.push(i); });
    let deliveryFee = 0;
    Object.values(sgroups).forEach(g=>{ const t=g.items.reduce((s,i)=>s+i.price*i.qty,0); if(!g.freeAbove||t<g.freeAbove) deliveryFee+=g.fee; });
    // Coupon
    let couponDiscount=0, appliedCouponId=null;
    if (couponCode) {
      const csnap = await db.collection('coupons').where('code','==',couponCode.toUpperCase()).where('active','==',true).limit(1).get();
      if (!csnap.empty) {
        const c = csnap.docs[0].data();
        if (!c.expiresAt||c.expiresAt.toDate()>new Date()) {
          if (!c.minOrder||subtotal>=c.minOrder) {
            couponDiscount = c.discountType==='percent' ? Math.min(subtotal*c.discountValue/100, c.maxDiscount||Infinity) : c.discountValue;
            couponDiscount = Math.min(couponDiscount, subtotal);
            appliedCouponId = csnap.docs[0].id;
          }
        }
      }
    }
    const total = Math.max(0, subtotal+deliveryFee-couponDiscount);
    const otp   = String(Math.floor(100000+Math.random()*900000));
    const orderId = Date.now().toString(36).toUpperCase();
    const pinCode = address.pincode||'';
    const order = { orderId, userId:req.uid, userEmail:req.email, items:orderItems, address, pinCode,
      payment, subtotal, deliveryFee, couponCode:appliedCouponId?couponCode.toUpperCase():null,
      couponDiscount, total, deliveryOtp:otp, otpVerified:false, deliveryPartnerId:null,
      status:'pending', createdAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp() };
    const ref = await db.collection('orders').add(order);
    if (appliedCouponId) await db.collection('couponClaims').add({ couponId:appliedCouponId, userId:req.uid, orderId:ref.id, createdAt:FieldValue.serverTimestamp() });
    // Notify sellers
    const sids = [...new Set(orderItems.map(i=>i.sellerId).filter(Boolean))];
    await Promise.all(sids.map(sid=>db.collection('notifications').add({ targetUserId:sid, title:'🛒 New Order!', message:`Order #${orderId} — ₹${total}`, type:'order', active:true, orderId:ref.id, createdAt:FieldValue.serverTimestamp() }).catch(()=>{})));
    res.status(201).json({ id:ref.id, orderId, total, deliveryFee, couponDiscount });
  } catch(e) { console.error('Order error:',e); res.status(500).json({ error:'Failed to place order' }); }
});

router.get('/me', requireUser, async (req,res) => {
  try {
    const snap = await db.collection('orders').where('userId','==',req.uid).orderBy('createdAt','desc').limit(50).get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed to load orders' }); }
});

router.get('/seller/list', requireSeller, async (req,res) => {
  try {
    const snap = await db.collection('orders').orderBy('createdAt','desc').limit(200).get();
    const orders = snap.docs.map(d=>({id:d.id,...d.data()})).filter(o=>(o.items||[]).some(i=>i.sellerId===req.uid));
    res.json(orders);
  } catch(e) { res.status(500).json({ error:'Failed to load orders' }); }
});

router.get('/:id', requireUser, async (req,res) => {
  try {
    const doc = await db.collection('orders').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error:'Order not found' });
    if (doc.data().userId!==req.uid) return res.status(403).json({ error:'Forbidden' });
    res.json({ id:doc.id,...doc.data() });
  } catch(e) { res.status(500).json({ error:'Failed to load order' }); }
});

router.post('/:id/cancel', requireUser, validate(Schemas.orderCancel||{}), async (req,res) => {
  try {
    const ref = db.collection('orders').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error:'Not found' });
    const data = doc.data();
    if (data.userId!==req.uid) return res.status(403).json({ error:'Forbidden' });
    if (data.status!=='pending') return res.status(400).json({ error:`Cannot cancel: status is ${data.status}` });
    await ref.update({ status:'cancelled', cancelReason:req.body.reason, cancelledBy:'user', cancelledAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp() });
    // Restore stock
    const batch = db.batch();
    (data.items||[]).forEach(i=>{ if(i.productId) batch.update(db.collection('products').doc(i.productId),{ stock:FieldValue.increment(i.qty||1) }); });
    await batch.commit();
    await auditLog(req.uid,'order_cancel',{ orderId:req.params.id });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Failed to cancel order' }); }
});

router.patch('/:id/status', requireSeller, validate(Schemas.orderStatus||{}), async (req,res) => {
  try {
    const { status, reason } = req.body;
    const ref = db.collection('orders').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error:'Not found' });
    const data = doc.data();
    if (!(data.items||[]).some(i=>i.sellerId===req.uid)) return res.status(403).json({ error:'Forbidden' });
    const transitions = { pending:['accepted','cancelled'], accepted:['packed','cancelled'], packed:[] };
    if (!(transitions[data.status]||[]).includes(status)) return res.status(400).json({ error:`Cannot transition from ${data.status} to ${status}` });
    const update = { status, updatedAt:FieldValue.serverTimestamp() };
    if (status==='cancelled') { update.cancelReason=reason||'Cancelled by seller'; update.cancelledBy='seller'; }
    await ref.update(update);
    if (data.userId) {
      const msgs = { accepted:{t:'✅ Order Accepted',m:`Your order #${data.orderId} was accepted.`}, packed:{t:'📦 Order Packed',m:`Your order #${data.orderId} is packed and awaiting pickup.`}, cancelled:{t:'❌ Order Cancelled',m:`Your order #${data.orderId} was cancelled. Reason: ${reason||'N/A'}`} };
      const n = msgs[status];
      if (n) await db.collection('notifications').add({ targetUserId:data.userId, title:n.t, message:n.m, type:'order', active:true, orderId:req.params.id, createdAt:FieldValue.serverTimestamp() });
    }
    await auditLog(req.uid,`order_${status}`,{ orderId:req.params.id });
    res.json({ success:true, status });
  } catch(e) { res.status(500).json({ error:'Failed to update order status' }); }
});

module.exports = router;
