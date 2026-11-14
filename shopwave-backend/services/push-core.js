'use strict';
/* Sends one Firestore `notifications` doc as a web push. Used by BOTH senders (the Express watcher and the
   Cloud Function) — run only one of them. A claim on `pushedAt` guarantees a notification is pushed once
   even if both are accidentally running. */
const BAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);
const MAX_AGE_MS = 10 * 60 * 1000;

function buildData(id, n) {
  return {
    nid: String(id),
    title: String(n.title || 'ShopWave').slice(0, 120),
    body: String(n.message || '').slice(0, 300),
    type: String(n.type || 'system'),
    orderId: String(n.orderId || ''),
    panel: String(n.panel || 'user'),
    key: String(n.key || id),                                   // same key = same alert, so the app never shows it twice
    kind: String(n.kind || (n.target === 'zone' ? 'pickup' : '')),
  };
}

/* deps: { db, messaging, FieldValue, log } */
function createSender({ db, messaging, FieldValue, log = console }) {
  async function claim(ref) {
    return db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const d = s.data();
      if (d.pushedAt || d.active === false) return null;
      tx.update(ref, { pushedAt: FieldValue.serverTimestamp() });
      return d;
    });
  }

  async function tokensFor(n) {
    const panel = n.panel || 'user';
    const col = db.collection('deviceTokens');
    const ids = snap => snap.docs.map(d => d.id);
    if (n.target === 'specific' && n.targetUserId) {
      const snap = await col.where('userId', '==', n.targetUserId).get();
      return snap.docs.filter(d => (d.data().panel || 'user') === panel).map(d => d.id);
    }
    if (n.target === 'all') return ids(await col.where('panel', '==', 'user').get());       // broadcasts go to customers
    if (n.target === 'admins') return ids(await col.where('panel', '==', 'admin').get());   // new applications
    if (n.target === 'zone' && n.pinCode) {
      // Online, approved partners whose zone covers this pincode.
      const ps = await db.collection('deliveryPartners').where('activePincodes', 'array-contains', String(n.pinCode)).get();
      const users = ps.docs.map(d => d.data()).filter(p => p.status === 'approved' && p.isOnline === true).map(p => p.userId).filter(Boolean);
      const out = [];
      for (let i = 0; i < users.length; i += 10) {
        const snap = await col.where('userId', 'in', users.slice(i, i + 10)).get();
        snap.docs.forEach(d => { if ((d.data().panel || 'user') === 'delivery') out.push(d.id); });
      }
      return out;
    }
    return [];
  }

  async function handle(id, data) {
    if (data && data.createdAt && data.createdAt.toMillis && Date.now() - data.createdAt.toMillis() > MAX_AGE_MS) return { skipped: 'old' };
    const ref = db.collection('notifications').doc(id);
    const n = await claim(ref);
    if (!n) return { skipped: 'already-sent-or-inactive' };
    const tokens = await tokensFor(n);
    if (!tokens.length) return { sent: 0, tokens: 0 };
    const payload = buildData(id, n);
    let sent = 0, failed = 0; const dead = [];
    for (let i = 0; i < tokens.length; i += 500) {
      const part = tokens.slice(i, i + 500);
      const res = await messaging.sendEachForMulticast({ tokens: part, data: payload, webpush: { headers: { Urgency: 'high', TTL: '86400' } } });
      res.responses.forEach((r, k) => {
        if (r.success) sent++;
        else { failed++; if (r.error && BAD_TOKEN.has(r.error.code)) dead.push(part[k]); else log.warn && log.warn('push failed', r.error && r.error.code); }
      });
    }
    await Promise.all(dead.map(t => db.collection('deviceTokens').doc(t).delete().catch(() => {})));
    return { sent, failed, removed: dead.length, tokens: tokens.length };
  }
  return { handle };
}
module.exports = { createSender, buildData };
