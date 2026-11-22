const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeyStore } = require('../src/keystore');
const { checkBaseURL, anySignal } = require('../src/umay');

function secrets() {
  const map = new Map();
  return { map, get: async key => map.get(key), store: async (key, value) => { map.set(key, value); }, delete: async key => { map.delete(key); } };
}

test('a saved key wins over UMAY_API_KEY, which is used when nothing is saved', async () => {
  const box = secrets();
  const keys = createKeyStore(box, { UMAY_API_KEY: ' umay-sk-ortam ' });
  assert.deepEqual(await keys.load(), { key: 'umay-sk-ortam', source: 'env' });
  await keys.save(' umay-sk-kayitli\n');
  assert.deepEqual(await keys.load(), { key: 'umay-sk-kayitli', source: 'saved' });
  assert.equal(box.map.get('umay.apiKey'), 'umay-sk-kayitli');
  await keys.remove();
  assert.equal((await keys.load()).source, 'env');
  assert.equal(await createKeyStore(secrets(), {}).load(), null);
});

test('empty keys and keys with spaces are refused; another window\'s change is picked up after forget()', async () => {
  const box = secrets();
  const keys = createKeyStore(box, {});
  await assert.rejects(keys.save('  '), /boş/);
  await assert.rejects(keys.save('umay sk'), /boşluk/);
  await keys.save('umay-sk-1');
  box.map.set('umay.apiKey', 'umay-sk-2');
  assert.equal((await keys.load()).key, 'umay-sk-1', 'cached');
  keys.forget();
  assert.equal((await keys.load()).key, 'umay-sk-2');
});

test('the API address must be HTTPS, or HTTP on this computer', () => {
  assert.equal(checkBaseURL(''), 'https://umayzeka.com/v1');
  assert.equal(checkBaseURL('https://umayzeka.com/v1/'), 'https://umayzeka.com/v1');
  assert.equal(checkBaseURL('http://127.0.0.1:4000/v1'), 'http://127.0.0.1:4000/v1');
  assert.throws(() => checkBaseURL('http://example.com/v1'), /HTTPS/);
  assert.throws(() => checkBaseURL('dosya'), /Geçersiz/);
});

test('anySignal aborts when any of its signals does, also without AbortSignal.any', () => {
  const saved = AbortSignal.any;
  try {
    AbortSignal.any = undefined;
    const a = new AbortController();
    const b = new AbortController();
    const both = anySignal([a.signal, b.signal]);
    assert.equal(both.aborted, false);
    b.abort();
    assert.equal(both.aborted, true);
    const early = new AbortController();
    early.abort();
    assert.equal(anySignal([early.signal]).aborted, true);
  } finally { AbortSignal.any = saved; }
});
