const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const umay = require('../src/umay');

async function server(t, handler) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk).on('end', () => {
      const request = { method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
      requests.push(request);
      handler(request, res);
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { baseURL: `http://127.0.0.1:${srv.address().port}/v1`, requests };
}
const sse = (res, parts, { model = 'umay-akilli', end = true } = {}) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const delta of parts) res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta }] })}\n\n`);
  if (end) res.end('data: [DONE]\n\n');
};

test('sseParser joins lines split across chunks and skips [DONE] and broken lines', () => {
  const seen = [];
  const feed = umay.sseParser(data => seen.push(data));
  feed('data: {"a":');
  feed('1}\n\ndata: [DONE]\n');
  feed('data: {kırık\n\r\ndata: {"b":2}\r\n');
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
});

test('streamChat streams thought and answer, sends the thinking switch and reports the answering model', async t => {
  const api = await server(t, (_req, res) => sse(res, [{ reasoning_content: 'Düşün' }, { reasoning_content: 'üyorum.' }, { content: '**391**' }, { content: ' olur.' }], { model: 'umay-hizli' }));
  const texts = [];
  const thoughts = [];
  const result = await umay.streamChat({ apiKey: 'k', baseURL: api.baseURL, model: 'umay-hizli', thinking: true,
    messages: [{ role: 'user', content: '17x23' }], onText: piece => texts.push(piece), onReasoning: piece => thoughts.push(piece) });
  assert.equal(result.text, '**391** olur.');
  assert.equal(result.reasoning, 'Düşünüyorum.');
  assert.equal(result.model, 'umay-hizli');
  assert.deepEqual(texts, ['**391**', ' olur.']);
  assert.equal(thoughts.join(''), 'Düşünüyorum.');
  const body = api.requests[0].body;
  assert.equal(api.requests[0].auth, 'Bearer k');
  assert.equal(body.stream, true);
  assert.equal(body.enable_thinking, true);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });

  await umay.streamChat({ apiKey: 'k', baseURL: api.baseURL, thinking: null, messages: [{ role: 'user', content: 'x' }] });
  assert.equal('enable_thinking' in api.requests[1].body, false, 'otomatik sends no thinking field');
});

test('streamChat turns HTTP failures and empty answers into Turkish messages', async t => {
  const cases = [
    [401, '', /anahtarı kabul edilmedi/],
    [429, '{"error":{"message":"Ani istek patlaması (burst) sınırı aşıldı"}}', /saniyede en fazla 3/],
    [524, '<html>', /ağ geçidi/],
    [503, '', /bakımda/],
  ];
  for (const [status, body, expected] of cases) {
    const api = await server(t, (_req, res) => { res.writeHead(status); res.end(body); });
    await assert.rejects(umay.streamChat({ apiKey: 'k', baseURL: api.baseURL, messages: [] }), expected);
  }
  const empty = await server(t, (_req, res) => sse(res, [{ content: '' }]));
  await assert.rejects(umay.streamChat({ apiKey: 'k', baseURL: empty.baseURL, messages: [] }), /boş yanıt/);
  await assert.rejects(umay.streamChat({ apiKey: 'k', baseURL: 'http://127.0.0.1:9/v1', messages: [] }), /bağlanılamadı/);
});

test('streamChat stops on request and keeps what had arrived', async t => {
  const api = await server(t, (_req, res) => sse(res, [{ content: 'Yarım ' }], { end: false }));
  const controller = new AbortController();
  const pending = umay.streamChat({ apiKey: 'k', baseURL: api.baseURL, messages: [], signal: controller.signal,
    onText: () => setTimeout(() => controller.abort(), 20) });
  const error = await pending.then(() => null, caught => caught);
  assert.equal(error?.stopped, true);
  assert.equal(error.partial.text, 'Yarım ');
});

test('streamChat gives up after the server stays silent, but not while pieces keep coming', async t => {
  const api = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${sent}` } }] })}\n\n`);
      if (++sent === 6) { clearInterval(timer); res.end('data: [DONE]\n\n'); }
    }, 60);
  });
  const slowButSteady = await umay.streamChat({ apiKey: 'k', baseURL: api.baseURL, messages: [], silence: 200 });
  assert.equal(slowButSteady.text, '012345');

  const silent = await server(t, (_req, res) => sse(res, [{ content: 'a' }], { end: false }));
  await assert.rejects(umay.streamChat({ apiKey: 'k', baseURL: silent.baseURL, messages: [], silence: 200 }), /veri göndermiyor/);
});

test('verifyKey: 400 for an empty request means accepted, 401 refused, anything else unknown', async t => {
  const api = await server(t, (req, res) => { res.writeHead(req.auth === 'Bearer iyi' ? 400 : 401); res.end('{}'); });
  assert.equal(await umay.verifyKey('iyi', { baseURL: api.baseURL }), true);
  assert.equal(await umay.verifyKey('kotu', { baseURL: api.baseURL }), false);
  assert.deepEqual(api.requests[0].body, { model: 'umay-akilli', messages: [] });
  const odd = await server(t, (_req, res) => { res.writeHead(500); res.end(); });
  assert.equal(await umay.verifyKey('iyi', { baseURL: odd.baseURL }), null);
});

test('listModels keeps Umay\'s own names and falls back to the four Umay models', async t => {
  const api = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'umay-akilli', owned_by: 'umay' }, { id: 'umay-mistral-large', owned_by: 'umay' }, { id: 'mistralai/mistral-large-4-1t-a52b', owned_by: 'mistralai' }] }));
  });
  assert.deepEqual(await umay.listModels({ baseURL: api.baseURL }), [{ id: 'umay-akilli', name: 'Umay Akıllı' }, { id: 'umay-mistral-large', name: 'Mistral Large 4' }]);
  const html = await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>'); });
  assert.deepEqual((await umay.listModels({ baseURL: html.baseURL })).map(model => model.id), ['umay-akilli', 'umay-hizli', 'umay-ultra-hizli', 'umay-daha-zeki']);
});

test('modelName turns the answering provider model into a readable name', () => {
  assert.equal(umay.modelName('deepseek-ai/deepseek-v4.1-flash'), 'DeepSeek v4.1 Flash');
  assert.equal(umay.modelName('z-ai/glm-5.3-flash'), 'GLM 5.3 Flash');
  assert.equal(umay.modelName('umay-akilli'), 'Umay Akıllı');
  assert.equal(umay.modelName('acme/yeni-model-9'), 'yeni-model-9', 'unknown provider names lose only the prefix');
  assert.equal(umay.modelName('umay-yeni'), 'umay-yeni');
});
