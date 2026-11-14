'use strict';
/* Runs with plain node: node test/push-core.test.js */
const assert = require('assert');
const { createSender, buildData } = require('../services/push-core');

function fakeDb(tokens, notif, partners = []) {
  const store = { 'notifications/n1': { ...notif }, ...Object.fromEntries(tokens.map(t => ['deviceTokens/' + t.id, t])), ...Object.fromEntries(partners.map((p, i) => ['deliveryPartners/p' + i, p])) };
  const deleted = [];
  const FieldValue = { serverTimestamp: () => 'TS' };
  const db = {
    collection: c => ({
      doc: id => ({ _p: c + '/' + id, delete: async () => { deleted.push(id); delete store[c + '/' + id]; } }),
      where: (f, op, v) => ({ get: async () => ({ docs: Object.keys(store).filter(k => k.startsWith(c + '/')).map(k => ({ id: k.split('/')[1], data: () => store[k] })).filter(d => op === 'array-contains' ? (d.data()[f] || []).includes(v) : op === 'in' ? v.includes(d.data()[f]) : d.data()[f] === v) }) }),
    }),
    runTransaction: async fn => fn({ get: async r => ({ exists: !!store[r._p], data: () => store[r._p] }), update: (r, d) => Object.assign(store[r._p], d) }),
  };
  return { db, store, deleted, FieldValue };
}
const sent = [];
const messaging = bad => ({ sendEachForMulticast: async m => { sent.push(m); return { responses: m.tokens.map(t => bad.includes(t) ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true }) }; } });

(async () => {
  // 1. specific user, matching panel only
  let f = fakeDb([{ id: 'tA', userId: 'u1', panel: 'user' }, { id: 'tB', userId: 'u1', panel: 'seller' }, { id: 'tC', userId: 'u2', panel: 'user' }],
    { target: 'specific', targetUserId: 'u1', panel: 'user', title: 'Order accepted', message: 'Hi', orderId: 'o1', type: 'order', active: true });
  let r = await createSender({ db: f.db, messaging: messaging([]), FieldValue: f.FieldValue, log: { warn() {} } }).handle('n1', f.store['notifications/n1']);
  assert.deepStrictEqual(sent[0].tokens, ['tA'], 'only the customer device of u1');
  assert.strictEqual(sent[0].data.orderId, 'o1'); assert.strictEqual(sent[0].data.panel, 'user'); assert.ok(!sent[0].notification, 'data-only message');
  assert.strictEqual(r.sent, 1); console.log('PASS specific user + panel filter');

  // 2. claimed once
  r = await createSender({ db: f.db, messaging: messaging([]), FieldValue: f.FieldValue }).handle('n1', f.store['notifications/n1']);
  assert.ok(r.skipped); assert.strictEqual(sent.length, 1); console.log('PASS never pushed twice');

  // 3. seller panel notification goes to the seller device
  f = fakeDb([{ id: 'tA', userId: 'u1', panel: 'user' }, { id: 'tB', userId: 'u1', panel: 'seller' }],
    { target: 'specific', targetUserId: 'u1', panel: 'seller', title: 'New order', message: 'x', active: true });
  sent.length = 0; await createSender({ db: f.db, messaging: messaging([]), FieldValue: f.FieldValue }).handle('n1', f.store['notifications/n1']);
  assert.deepStrictEqual(sent[0].tokens, ['tB']); console.log('PASS seller alert reaches seller device only');

  // 4. broadcast -> customers only; dead tokens removed
  f = fakeDb([{ id: 'tA', userId: 'u1', panel: 'user' }, { id: 'tB', userId: 'u2', panel: 'user' }, { id: 'tS', userId: 's1', panel: 'seller' }],
    { target: 'all', title: 'Sale', message: 'x', active: true });
  sent.length = 0; r = await createSender({ db: f.db, messaging: messaging(['tB']), FieldValue: f.FieldValue }).handle('n1', f.store['notifications/n1']);
  assert.deepStrictEqual(sent[0].tokens.sort(), ['tA', 'tB']); assert.deepStrictEqual(f.deleted, ['tB']); assert.strictEqual(r.removed, 1);
  console.log('PASS broadcast to customers, dead token cleaned up');

  // 5. skip inactive and old
  f = fakeDb([{ id: 'tA', userId: 'u1', panel: 'user' }], { target: 'specific', targetUserId: 'u1', title: 't', active: false });
  sent.length = 0; r = await createSender({ db: f.db, messaging: messaging([]), FieldValue: f.FieldValue }).handle('n1', f.store['notifications/n1']);
  assert.ok(r.skipped && !sent.length);
  r = await createSender({ db: f.db, messaging: messaging([]), FieldValue: f.FieldValue }).handle('n1', { createdAt: { toMillis: () => Date.now() - 3600000 } });
  assert.strictEqual(r.skipped, 'old'); console.log('PASS inactive and old notifications are skipped');

  // 7. zone: only ONLINE, APPROVED partners covering the pincode, on their delivery device
  f = fakeDb([{ id: 'd1app', userId: 'u10', panel: 'delivery' }, { id: 'd1cust', userId: 'u10', panel: 'user' }, { id: 'd2', userId: 'u11', panel: 'delivery' }, { id: 'd3', userId: 'u12', panel: 'delivery' }, { id: 'd4', userId: 'u13', panel: 'delivery' }],
    { target: 'zone', pinCode: '400001', panel: 'delivery', title: 'Order ready', message: 'x', orderId: 'o5', active: true, key: 'pk-o5' },
    [{ userId: 'u10', status: 'approved', isOnline: true, activePincodes: ['400001'] }, { userId: 'u11', status: 'approved', isOnline: false, activePincodes: ['400001'] },
     { userId: 'u12', status: 'suspended', isOnline: true, activePincodes: ['400001'] }, { userId: 'u13', status: 'approved', isOnline: true, activePincodes: ['400002'] }]);
  sent.length = 0; r = await createSender({ db: f.db, messaging: messaging([]), FieldValue: f.FieldValue }).handle('n1', f.store['notifications/n1']);
  assert.deepStrictEqual(sent[0].tokens, ['d1app']); assert.strictEqual(sent[0].data.kind, 'pickup'); assert.strictEqual(sent[0].data.key, 'pk-o5');
  console.log('PASS pickup alert reaches only online approved partners in that pincode');

  // 8. admins
  f = fakeDb([{ id: 'a1', userId: 'ad', panel: 'admin' }, { id: 'c1', userId: 'u1', panel: 'user' }], { target: 'admins', panel: 'admin', title: 'New seller application', message: 'x', active: true });
  sent.length = 0; await createSender({ db: f.db, messaging: messaging([]), FieldValue: f.FieldValue }).handle('n1', f.store['notifications/n1']);
  assert.deepStrictEqual(sent[0].tokens, ['a1']); console.log('PASS application alert reaches admin devices only');

  // 6. payload hygiene
  const d = buildData('x', { title: 'T'.repeat(500), message: undefined, orderId: undefined });
  assert.ok(d.title.length === 120 && d.body === '' && d.orderId === '' && d.panel === 'user'); console.log('PASS payload is clamped and has no undefined');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
