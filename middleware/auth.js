'use strict';
const { auth, db } = require('../config/firebase');

async function verifyToken(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const d = await auth.verifyIdToken(h.split('Bearer ')[1], true);
    req.uid = d.uid; req.email = d.email || '';
    next();
  } catch (e) {
    return res.status(401).json({ error: e.code === 'auth/id-token-revoked' ? 'Token revoked' : 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  await verifyToken(req, res, async () => {
    const [a, u] = await Promise.all([db.collection('admins').doc(req.uid).get(), db.collection('users').doc(req.uid).get()]);
    if (!a.exists && u.data()?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.role = 'admin'; next();
  });
}

async function requireSeller(req, res, next) {
  await verifyToken(req, res, async () => {
    const snap = await db.collection('sellers').where('userId','==',req.uid).where('status','==','approved').limit(1).get();
    if (snap.empty) return res.status(403).json({ error: 'Approved seller account required' });
    req.seller = { id: snap.docs[0].id, ...snap.docs[0].data() }; req.role = 'seller'; next();
  });
}

async function requireDelivery(req, res, next) {
  await verifyToken(req, res, async () => {
    const snap = await db.collection('deliveryPartners').where('userId','==',req.uid).where('status','==','approved').limit(1).get();
    if (snap.empty) return res.status(403).json({ error: 'Approved delivery partner required' });
    req.partner = { id: snap.docs[0].id, ...snap.docs[0].data() }; req.role = 'delivery'; next();
  });
}

const requireUser = verifyToken;
module.exports = { verifyToken, requireAdmin, requireSeller, requireDelivery, requireUser };
