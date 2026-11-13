'use strict';
const router = require('express').Router();
const {db, auth, FieldValue} = require('../config/firebase');
const { validate, Schemas } = require('../middleware/validate');

router.post('/', validate(Schemas.reportCreate||{}), async (req,res) => {
  let uid='guest';
  try { const h=req.headers.authorization; if(h?.startsWith('Bearer ')) { const d=await auth.verifyIdToken(h.split('Bearer ')[1]); uid=d.uid; } } catch(_){}
  try {
    const ref = await db.collection('reports').add({ ...req.body, reportedBy:uid, status:'open', createdAt:FieldValue.serverTimestamp() });
    res.status(201).json({ success:true, id:ref.id });
  } catch(e) { res.status(500).json({ error:'Failed to submit report' }); }
});

module.exports = router;
