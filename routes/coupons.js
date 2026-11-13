'use strict';
const router = require('express').Router();
const { db, admin } = require('../config/firebase');
const { requireUser, requireSeller, requireAdmin } = require('../middleware/auth');
const { validate, Schemas } = require('../middleware/validate');

router.post('/validate', requireUser, validate(Schemas.couponValidate||{}), async (req,res) => {
  try {
    const { code, items } = req.body;
    const ids = [...new Set(items.map(i=>i.productId))];
    const pdocs = await Promise.all(ids.map(id=>db.collection('products').doc(id).get()));
    const pmap = {}; pdocs.forEach(d=>{ if(d.exists) pmap[d.id]=d.data().price; });
    const cartTotal = items.reduce((s,i)=>s+(pmap[i.productId]||0)*i.qty, 0);
    if (cartTotal<=0) return res.status(400).json({ error:'Invalid cart' });
    const [gs,ss] = await Promise.all([
      db.collection('coupons').where('code','==',code.toUpperCase()).where('type','==','global').where('active','==',true).limit(1).get(),
      db.collection('coupons').where('code','==',code.toUpperCase()).where('type','==','seller').where('active','==',true).limit(1).get(),
    ]);
    const matches = [...gs.docs,...ss.docs];
    if (!matches.length) return res.status(404).json({ error:'Invalid coupon code' });
    const c = { id:matches[0].id,...matches[0].data() };
    if (c.expiresAt&&c.expiresAt.toDate()<new Date()) return res.status(400).json({ error:'Coupon expired' });
    if (c.minOrder&&cartTotal<c.minOrder) return res.status(400).json({ error:`Minimum order ₹${c.minOrder} required` });
    if (c.maxClaims) { const cs=await db.collection('couponClaims').where('couponId','==',c.id).get(); if(cs.size>=c.maxClaims) return res.status(400).json({ error:'Coupon limit reached' }); }
    if (c.maxPerUser) { const us=await db.collection('couponClaims').where('couponId','==',c.id).where('userId','==',req.uid).get(); if(us.size>=c.maxPerUser) return res.status(400).json({ error:'Already used this coupon' }); }
    let discount = c.discountType==='percent' ? Math.min(cartTotal*c.discountValue/100, c.maxDiscount||Infinity) : c.discountValue;
    discount = Math.round(Math.min(discount,cartTotal)*100)/100;
    res.json({ valid:true, couponId:c.id, code:c.code, discount, description:c.description||'' });
  } catch(e) { res.status(500).json({ error:'Coupon validation failed' }); }
});

router.post('/', requireAdmin, validate(Schemas.couponCreate||{}), async (req,res) => {
  try {
    const ex = await db.collection('coupons').where('code','==',req.body.code).limit(1).get();
    if (!ex.empty) return res.status(409).json({ error:'Code already exists' });
    const ref = await db.collection('coupons').add({ ...req.body, type:'global', active:true, createdBy:req.uid, createdAt:admin.firestore.FieldValue.serverTimestamp() });
    res.status(201).json({ id:ref.id });
  } catch(e) { res.status(500).json({ error:'Failed to create coupon' }); }
});

router.post('/seller', requireSeller, validate(Schemas.couponCreate||{}), async (req,res) => {
  try {
    const ex = await db.collection('coupons').where('code','==',req.body.code).limit(1).get();
    if (!ex.empty) return res.status(409).json({ error:'Code already exists' });
    const ref = await db.collection('coupons').add({ ...req.body, type:'seller', sellerId:req.uid, active:true, createdAt:admin.firestore.FieldValue.serverTimestamp() });
    res.status(201).json({ id:ref.id });
  } catch(e) { res.status(500).json({ error:'Failed to create coupon' }); }
});

module.exports = router;
