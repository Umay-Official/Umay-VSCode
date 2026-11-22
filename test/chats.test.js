const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatStore } = require('../src/chats');

test('chat store keeps the latest first, drops UI-only fields and survives a damaged file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umay-code-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createChatStore({ dir });
  assert.deepEqual(store.list(), []);

  store.save({ id: 'a', title: 'İlk', messages: [{ role: 'user', content: 'selam' }] });
  store.save({ id: 'b', title: 'İkinci', messages: [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: 'y', reasoning: 'r', model: 'umay-hizli', seconds: 1.2, pending: true, extra: 1 },
    { role: 'system', content: 'gizli' },
  ] });
  assert.deepEqual(store.list().map(chat => chat.id), ['b', 'a']);
  const [b] = store.list();
  assert.equal(b.messages.length, 2, 'only user and assistant messages are kept');
  assert.equal('pending' in b.messages[1], false);
  assert.equal('extra' in b.messages[1], false);

  store.save({ id: 'a', title: 'İlk (güncel)', messages: [] });
  assert.deepEqual(store.list().map(chat => `${chat.id}:${chat.title}`), ['a:İlk (güncel)', 'b:İkinci']);
  store.remove('b');
  assert.deepEqual(store.list().map(chat => chat.id), ['a']);
  assert.throws(() => store.save({ id: 1 }), /Geçersiz/);

  fs.writeFileSync(store.file, '{bozuk');
  assert.deepEqual(store.list(), []);
});
