'use strict';
const router = require('express').Router();
const {db, auth, FieldValue} = require('../config/firebase');
const { requireUser } = require('../middleware/auth');
const { validate, Schemas } = require('../middleware/validate');

router.get('/:productId', async (req,res) => {
  try {
    const snap = await db.collection('products').doc(req.params.productId).collection('reviews').orderBy('createdAt','desc').limit(50).get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed to load reviews' }); }
});

router.post('/:productId', requireUser, validate(Schemas.reviewCreate||{}), async (req,res) => {
  try {
    const pRef = db.collection('products').doc(req.params.productId);
    const ex = await pRef.collection('reviews').where('userId','==',req.uid).limit(1).get();
    if (!ex.empty) return res.status(409).json({ error:'Already reviewed this product' });
    const oSnap = await db.collection('orders').where('userId','==',req.uid).where('status','==','delivered').get();
    const verified = oSnap.docs.some(d=>(d.data().items||[]).some(i=>i.productId===req.params.productId));
    const fu = await auth.getUser(req.uid);
    await pRef.collection('reviews').add({ ...req.body, userId:req.uid, userName:fu.displayName||'User', userPhoto:fu.photoURL||'', verified, helpfulCount:0, createdAt:FieldValue.serverTimestamp() });
    const all = await pRef.collection('reviews').get();
    const ratings = all.docs.map(d=>d.data().rating||0);
    const avg = ratings.length ? ratings.reduce((a,b)=>a+b,0)/ratings.length : 0;
    await pRef.set({ rating:Math.round(avg*10)/10, reviews:ratings.length },{ merge:true });
    res.status(201).json({ success:true });
  } catch(e) { res.status(500).json({ error:'Failed to submit review' }); }
});

module.exports = router;
