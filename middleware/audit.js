'use strict';
const { db, FieldValue } = require('../config/firebase');
async function auditLog(uid, action, details = {}) {
  try {
    await db.collection('audit_logs').add({ uid, action, details, timestamp: new Date().toISOString(), createdAt: FieldValue.serverTimestamp() });
  } catch (e) { console.error('Audit log failed:', e.message); }
}
module.exports = { auditLog };
