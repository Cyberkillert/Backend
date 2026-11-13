const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,'\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  })});
}
const db   = getFirestore();
const auth = getAuth();
module.exports = { db, auth, FieldValue };
