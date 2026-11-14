'use strict';
/* Runs inside the Express backend: watches new notifications and pushes them via FCM.
   Turn off with PUSH_WATCHER=off (for example when you deploy the Cloud Function instead). */
const { db, admin } = require('../config/firebase');
const { createSender } = require('./push-core');

function start() {
  if (process.env.PUSH_WATCHER === 'off') { console.log('[push] watcher disabled (PUSH_WATCHER=off)'); return null; }
  const sender = createSender({ db, messaging: admin.messaging(), FieldValue: admin.firestore.FieldValue });
  const since = admin.firestore.Timestamp.now();
  const unsub = db.collection('notifications').where('createdAt', '>', since).onSnapshot(snap => {
    snap.docChanges().forEach(c => {
      if (c.type !== 'added') return;
      sender.handle(c.doc.id, c.doc.data()).then(r => console.log('[push]', c.doc.id, JSON.stringify(r))).catch(e => console.error('[push] failed', c.doc.id, e.message));
    });
  }, e => console.error('[push] listener error:', e.message));
  console.log('[push] watching notifications for web push');
  return unsub;
}
module.exports = { start };
