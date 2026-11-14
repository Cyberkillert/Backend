'use strict';
const router = require('express').Router();
const { db, admin } = require('../config/firebase');
const { requireAdmin } = require('../middleware/auth');
const { validate, Schemas } = require('../middleware/validate');
const { auditLog } = require('../middleware/audit');

router.use(requireAdmin);

router.get('/dashboard', async (req,res) => {
  try {
    const [s,p,o,u,r] = await Promise.all([
      db.collection('sellers').where('status','==','active').get(),
      db.collection('products').where('status','==','active').get(),
      db.collection('orders').get(),
      db.collection('users').get(),
      db.collection('reports').where('status','==','open').get(),
    ]);
    const delivered = o.docs.filter(d=>d.data().status==='delivered');
    res.json({ sellers:s.size, products:p.size, orders:o.size, users:u.size, openReports:r.size,
      totalRevenue:delivered.reduce((s,d)=>s+(d.data().total||0),0),
      deliveredOrders:delivered.length });
  } catch(e) { res.status(500).json({ error:'Failed to load dashboard' }); }
});

router.get('/sellers', async (req,res) => {
  try {
    const { status } = req.query;
    let q = db.collection('sellers').orderBy('createdAt','desc');
    if (status) q = db.collection('sellers').where('status','==',status).orderBy('createdAt','desc');
    const snap = await q.get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

router.patch('/sellers/:id', validate(Schemas.sellerStatus||{}), async (req,res) => {
  try {
    const sref = db.collection('sellers').doc(req.params.id), sdoc = await sref.get();
    if (!sdoc.exists) return res.status(404).json({ error:'Not found' });
    await sref.update({ status:req.body.status, ...(req.body.reason?{rejectionReason:req.body.reason}:{}), updatedAt:admin.firestore.FieldValue.serverTimestamp() });
    const uref = db.collection('users').doc(sdoc.data().userId), u = await uref.get();
    if (u.exists && u.data().role!=='admin') await uref.update({ role: req.body.status==='approved' ? 'seller' : 'user' });
    await auditLog(req.uid,`seller_${req.body.status}`,{ sellerId:req.params.id });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

router.get('/orders', async (req,res) => {
  try {
    const { status, limit=100 } = req.query;
    let q = db.collection('orders').orderBy('createdAt','desc').limit(Math.min(Number(limit),200));
    if (status) q = db.collection('orders').where('status','==',status).orderBy('createdAt','desc').limit(Math.min(Number(limit),200));
    const snap = await q.get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

router.patch('/orders/:id/status', async (req,res) => {
  try {
    const { status, reason } = req.body;
    const L = require('../utils/lifecycle');
    if (!Object.keys(L.FLOW).concat(L.TERMINAL).includes(status)) return res.status(400).json({ error:'Invalid status' });
    if (['cancelled','returned','delivered'].includes(status) && !reason) return res.status(400).json({ error:'A reason is required' });
    const extra = status==='delivered' ? { forceDelivered:true, otpVerified:false } : {};
    const o = await L.transition(req.params.id, status, { actor:'admin', uid:req.uid, note:reason||'', extra });
    if (o.status==='shipped' && status==='packed') await L.notifyZone(o,'Order back in the pickup pool',`Order #${o.orderId} is ready again in ${o.pinCode}.`);
    if (status==='cancelled') await L.notify(o.userId,'Order cancelled',`Your order #${o.orderId} was cancelled. ${reason}`,o.id,'order');
    await auditLog(req.uid,'admin_order_status',{ orderId:req.params.id, from:o.status, status, reason:reason||'' });
    res.json({ success:true });
  } catch(e) { res.status(e.status||500).json({ error:e.status?e.message:'Failed' }); }
});

router.get('/reports', async (req,res) => {
  try {
    const { status } = req.query;
    let q = db.collection('reports').orderBy('createdAt','desc').limit(200);
    if (status) q = db.collection('reports').where('status','==',status).orderBy('createdAt','desc');
    const snap = await q.get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

router.patch('/reports/:id', async (req,res) => {
  try {
    await db.collection('reports').doc(req.params.id).update({ status:'resolved', resolvedAt:admin.firestore.FieldValue.serverTimestamp(), resolvedBy:req.uid });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

router.delete('/reports/:id', async (req,res) => {
  try {
    await db.collection('reports').doc(req.params.id).delete();
    await auditLog(req.uid,'report_delete',{ reportId:req.params.id });
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

router.get('/users', async (req,res) => {
  try {
    const snap = await db.collection('users').orderBy('createdAt','desc').limit(200).get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

router.post('/notifications', validate(Schemas.notification||{}), async (req,res) => {
  try {
    await db.collection('notifications').add({ ...req.body, active:true, createdAt:admin.firestore.FieldValue.serverTimestamp() });
    res.status(201).json({ success:true });
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

router.get('/analytics', async (req,res) => {
  try {
    const snap = await db.collection('orders').where('status','==','delivered').get();
    const orders = snap.docs.map(d=>d.data());
    const revenue = orders.reduce((s,o)=>s+(o.total||0),0);
    const bySeller = {};
    orders.forEach(o=>(o.items||[]).forEach(i=>{ const sid=i.sellerId||'?'; if(!bySeller[sid]) bySeller[sid]={sellerId:sid,sellerName:i.sellerName,revenue:0,orders:0}; bySeller[sid].revenue+=i.price*i.qty; bySeller[sid].orders++; }));
    res.json({ totalRevenue:revenue, deliveredOrders:orders.length, bySeller:Object.values(bySeller).sort((a,b)=>b.revenue-a.revenue).slice(0,20) });
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

router.get('/audit-logs', async (req,res) => {
  try {
    const snap = await db.collection('audit_logs').orderBy('createdAt','desc').limit(100).get();
    res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
  } catch(e) { res.status(500).json({ error:'Failed' }); }
});

module.exports = router;
