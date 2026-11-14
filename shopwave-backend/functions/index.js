'use strict';
/* Cloud Function sender (needs the Firebase Blaze plan). Deploy:  cd functions && npm i && firebase deploy --only functions
   Use this OR the backend watcher, not both. */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const { createSender } = require('./push-core');
admin.initializeApp();
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const sender = createSender({ db, messaging: admin.messaging(), FieldValue: admin.firestore.FieldValue });

exports.pushOnNotification = onDocumentCreated('notifications/{id}', async event => {
  const snap = event.data;
  if (!snap) return;
  const res = await sender.handle(event.params.id, snap.data());
  console.log('push', event.params.id, JSON.stringify(res));
});
