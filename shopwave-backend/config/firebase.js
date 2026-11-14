const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,'\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  })});
}
const db   = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });   // never fail a write because one optional field is undefined
const auth = admin.auth();
module.exports = { admin, db, auth };
