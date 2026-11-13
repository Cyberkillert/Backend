'use strict';
const router = require('express').Router();
const {db, auth, FieldValue} = require('../config/firebase');
const { requireUser } = require('../middleware/auth');
const { validate, Schemas } = require('../middleware/validate');

router.get('/me', requireUser, async (req,res) => {
  try {
    const [doc,fu] = await Promise.all([db.collection('users').doc(req.uid).get(), auth.getUser(req.uid)]);
    res.json({ uid:req.uid, email:fu.email, name:fu.displayName, photoURL:fu.photoURL, ...(doc.exists?doc.data():{}) });
  } catch(e) { res.status(500).json({ error:'Failed to load profile' }); }
});

router.get('/me/addresses', requireUser, async (req,res) => {
  try {
    const snap = await db.collection('users').doc(req.uid).collection('savedAddresses').orderBy('createdAt','asc').get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed to load addresses' }); }
});

router.post('/me/addresses', requireUser, validate(Schemas.addressCreate||{}), async (req,res) => {
  try {
    const ref = await db.collection('users').doc(req.uid).collection('savedAddresses').add({ ...req.body, createdAt:FieldValue.serverTimestamp() });
    res.status(201).json({ id:ref.id });
  } catch(e) { res.status(500).json({ error:'Failed to save address' }); }
});

router.delete('/me/addresses/:id', requireUser, async (req,res) => {
  try {
    await db.collection('users').doc(req.uid).collection('savedAddresses').doc(req.params.id).delete();
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Failed to delete address' }); }
});

router.get('/me/notifications', requireUser, async (req,res) => {
  try {
    const snap = await db.collection('notifications').where('targetUserId','==',req.uid).orderBy('createdAt','desc').limit(30).get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed to load notifications' }); }
});

module.exports = router;
