'use strict';
const { db } = require('../config/firebase');
async function auditLog(uid, action, details = {}) {
  try {
    await db.collection('audit_logs').add({ uid, action, details, timestamp: new Date().toISOString(), createdAt: require('firebase-admin').firestore.FieldValue.serverTimestamp() });
  } catch (e) { console.error('Audit log failed:', e.message); }
}
module.exports = { auditLog };
