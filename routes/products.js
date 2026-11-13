'use strict';
const router = require('express').Router();
const {db, FieldValue} = require('../config/firebase');
const { verifyToken, requireSeller } = require('../middleware/auth');
const { validate, Schemas } = require('../middleware/validate');

router.get('/', async (req,res) => {
  try {
    const { category, search, limit=20, minPrice, maxPrice } = req.query;
    let q = db.collection('products').where('status','==','active');
    if (category) q = q.where('category','==',category);
    q = q.orderBy('createdAt','desc').limit(Math.min(Number(limit)||20,100));
    const snap = await q.get();
    let products = snap.docs.map(d=>({id:d.id,...d.data()}));
    if (search) { const s=search.toLowerCase(); products=products.filter(p=>p.name?.toLowerCase().includes(s)||p.description?.toLowerCase().includes(s)); }
    if (minPrice!=null) products=products.filter(p=>p.price>=Number(minPrice));
    if (maxPrice!=null) products=products.filter(p=>p.price<=Number(maxPrice));
    res.json(products);
  } catch(e) { res.status(500).json({ error:'Failed to load products' }); }
});

router.get('/seller/list', requireSeller, async (req,res) => {
  try {
    const snap = await db.collection('products').where('sellerId','==',req.uid).where('status','!=','deleted').orderBy('status').orderBy('createdAt','desc').limit(200).get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed to load products' }); }
});

router.get('/:id', async (req,res) => {
  try {
    const doc = await db.collection('products').doc(req.params.id).get();
    if (!doc.exists||doc.data().status==='deleted') return res.status(404).json({ error:'Not found' });
    doc.ref.update({ views: FieldValue.increment(1) }).catch(()=>{});
    res.json({ id:doc.id,...doc.data() });
  } catch(e) { res.status(500).json({ error:'Failed to load product' }); }
});

router.post('/', requireSeller, validate(Schemas.productCreate||{}), async (req,res) => {
  try {
    const b = req.body;
    const stock = b.variants?.length ? b.variants.reduce((s,v)=>s+v.stock,0) : (b.stock||0);
    const ref = await db.collection('products').add({ ...b, stock, sellerId:req.uid, sellerName:req.seller?.storeName||'', status:'active', rating:0, reviews:0, views:0, createdAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp() });
    res.status(201).json({ id:ref.id });
  } catch(e) { res.status(500).json({ error:'Failed to create product' }); }
});

router.patch('/:id', requireSeller, validate(Schemas.productUpdate||{}), async (req,res) => {
  try {
    const ref = db.collection('products').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error:'Not found' });
    if (doc.data().sellerId!==req.uid) return res.status(403).json({ error:'Forbidden' });
    const updates = { ...req.body, sellerId:doc.data().sellerId, updatedAt:FieldValue.serverTimestamp() };
    if (updates.variants?.length) updates.stock = updates.variants.reduce((s,v)=>s+v.stock,0);
    await ref.update(updates);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Failed to update product' }); }
});

router.delete('/:id', requireSeller, async (req,res) => {
  try {
    const ref = db.collection('products').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error:'Not found' });
    if (doc.data().sellerId!==req.uid) return res.status(403).json({ error:'Forbidden' });
    await ref.update({ status:'deleted', updatedAt:FieldValue.serverTimestamp() });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Failed to delete product' }); }
});

module.exports = router;
