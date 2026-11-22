const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { runTurn } = require('../src/agent');
const { createToolbox } = require('../src/tools');

// A fake Umay: each request gets the next scripted answer, streamed as server-sent events.
async function umay(t, answers) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk).on('end', () => {
      requests.push(JSON.parse(body));
      const answer = answers[requests.length - 1] ?? 'Bitti.';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of answer.match(/[\s\S]{1,25}/g)) res.write(`data: ${JSON.stringify({ model: 'umay-hizli', choices: [{ delta: { content: piece } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { baseURL: `http://127.0.0.1:${srv.address().port}/v1`, requests };
}

const call = (name, args) => `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umay-ajan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  fs.writeFileSync(path.join(root, 'a.txt'), 'eski\n');
  return { root, toolbox: createToolbox(root) };
}

function recorder() {
  const events = [];
  return { events, emit: event => events.push(event), text: () => events.filter(e => e.type === 'text').map(e => e.text).join('') };
}

test('a turn reads, asks before writing, writes after approval and ends with the answer', async t => {
  const { root, toolbox } = project(t);
  const api = await umay(t, [
    `Önce dosyaya bakıyorum.\n${call('read_file', { path: 'a.txt' })}`,
    `Şimdi değiştiriyorum.\n${call('edit_file', { path: 'a.txt', old_text: 'eski', new_text: 'yeni' })}`,
    'Tamam, a.txt artık "yeni" diyor.',
  ]);
  const log = recorder();
  const asked = [];
  const result = await runTurn({ apiKey: 'k', baseURL: api.baseURL, model: 'umay-hizli', system: 'sistem', toolbox,
    history: [{ role: 'user', content: 'a.txt içindeki eski yazısını yeni yap' }], emit: log.emit,
    approve: async request => { asked.push(request); return 'yes'; } });

  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'yeni\n');
  assert.equal(asked.length, 1, 'only the edit needs approval');
  assert.equal(asked[0].name, 'edit_file');
  assert.equal(api.requests.length, 3);
  assert.match(api.requests[0].messages[0].content, /TOOL CALLS/);
  assert.match(api.requests[0].messages[0].content, new RegExp(root.replace(/\\/g, '\\\\')));
  assert.match(api.requests[1].messages.at(-1).content, /<tool_result name="read_file">[\s\S]*1→eski/);
  // The tool-call markup never reaches the screen.
  assert.equal(log.text(), 'Önce dosyaya bakıyorum.\nŞimdi değiştiriyorum.\nTamam, a.txt artık "yeni" diyor.');
  const statuses = log.events.filter(e => e.type === 'tool').map(e => `${e.name}:${e.status}`);
  assert.deepEqual(statuses, ['read_file:running', 'read_file:done', 'edit_file:running', 'edit_file:approval', 'edit_file:running', 'edit_file:done']);
  assert.match(log.events.find(e => e.status === 'approval').preview.text, /^\+yeni$/m);
  assert.equal(result.transcript.length, 5, 'three answers and two result messages');
  assert.equal(result.model, 'umay-hizli');
});

test('a refused change is not made and Umay is told so; "always" stops asking for that tool', async t => {
  const { root, toolbox } = project(t);
  const api = await umay(t, [
    call('write_file', { path: 'a.txt', content: 'bir\n' }),
    'Peki, dokunmadım.',
    call('write_file', { path: 'b.txt', content: 'iki\n' }),
    call('write_file', { path: 'c.txt', content: 'üç\n' }),
    'İkisini de yazdım.',
  ]);
  const verdicts = ['no', 'always'];
  const asked = [];
  const always = new Set();
  const turn = history => runTurn({ apiKey: 'k', baseURL: api.baseURL, system: 's', toolbox, history, always, emit: () => {},
    approve: async request => { asked.push(request.args.path); return verdicts.shift(); } });

  await turn([{ role: 'user', content: 'a.txt yaz' }]);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'eski\n');
  assert.match(api.requests[1].messages.at(-1).content, /Kullanıcı bu işlemi reddetti/);

  await turn([{ role: 'user', content: 'b ve c yaz' }]);
  assert.deepEqual(asked, ['a.txt', 'b.txt'], 'c.txt was not asked after "always"');
  assert.ok(fs.existsSync(path.join(root, 'b.txt')) && fs.existsSync(path.join(root, 'c.txt')));
});

test('without a folder there are no tools; a broken call is reported back; stopping during approval keeps the transcript', async t => {
  const plain = await umay(t, [`Araç yok.\n${call('read_file', { path: 'a.txt' })}`]);
  const log = recorder();
  const result = await runTurn({ apiKey: 'k', baseURL: plain.baseURL, system: 's', toolbox: null, history: [{ role: 'user', content: 'x' }], emit: log.emit, approve: async () => 'yes' });
  assert.equal(plain.requests.length, 1);
  assert.doesNotMatch(plain.requests[0].messages[0].content, /TOOL CALLS/);
  assert.equal(result.transcript.length, 1);

  const { toolbox } = project(t);
  const broken = await umay(t, ['<tool_call>\n{"name": "read_file", "arguments": \n</tool_call>', 'Düzelttim.']);
  await runTurn({ apiKey: 'k', baseURL: broken.baseURL, system: 's', toolbox, history: [{ role: 'user', content: 'x' }], emit: () => {}, approve: async () => 'yes' });
  assert.match(broken.requests[1].messages.at(-1).content, /Araç çağrısı okunamadı/);

  const waiting = await umay(t, [call('run_command', { command: 'echo hi' })]);
  const controller = new AbortController();
  const error = await runTurn({ apiKey: 'k', baseURL: waiting.baseURL, system: 's', toolbox, history: [{ role: 'user', content: 'x' }], signal: controller.signal, emit: () => {},
    approve: () => new Promise(resolve => { setTimeout(() => { controller.abort(); resolve('no'); }, 50); }) }).then(() => null, caught => caught);
  assert.ok(error, 'the turn ends with an error when stopped');
  assert.equal(error.transcript.length, 1, 'the answer with the call is kept');
});

test('while a tool call streams, the window hears which tool and file it is and how long it has grown', async t => {
  const { toolbox } = project(t);
  const content = 'body { color: red; }\n'.repeat(200);
  const api = await umay(t, [`Yazıyorum.\n${call('write_file', { path: 'stil/ana.css', content })}`, 'Yazdım.']);
  const log = recorder();
  await runTurn({ apiKey: 'k', baseURL: api.baseURL, system: 's', toolbox, history: [{ role: 'user', content: 'x' }], emit: log.emit, approve: async () => 'yes' });
  const drafts = log.events.filter(e => e.type === 'drafting');
  const writing = drafts.filter(e => !e.done).at(-1);
  assert.ok(writing, 'a drafting event while the call streams');
  assert.equal(writing.name, 'write_file');
  assert.equal(writing.path, 'stil/ana.css');
  assert.ok(writing.chars > 0);
  assert.equal(drafts.at(-1).done, true, 'the window hears when the call is complete');
  assert.ok(log.events.indexOf(drafts.at(-1)) < log.events.findIndex(e => e.type === 'tool'), 'before the tool card starts');
});

test('a write_file cut off by the length limit is saved up to its last whole line and Umay is told to append the rest', async t => {
  const { root, toolbox } = project(t);
  const line = 'body { font-family: "Inter"; color: red; }\n';
  const cut = `Yazıyorum.\n<tool_call>\n{"name": "write_file", "arguments": {"path": "stil/uzun.css", "content": "/* başlık */\n${line.repeat(400)}.yarim { colo`;
  const api = await umay(t, [cut, `Devam ediyorum.\n${call('append_file', { path: 'stil/uzun.css', content: '.son {}\n' })}`, 'Bitti.']);
  const asked = [];
  await runTurn({ apiKey: 'k', baseURL: api.baseURL, system: 's', toolbox, history: [{ role: 'user', content: 'uzun css yaz' }], emit: () => {},
    approve: async request => { asked.push(request.name); return 'yes'; } });
  assert.deepEqual(asked, ['write_file', 'append_file']);
  const written = fs.readFileSync(path.join(root, 'stil', 'uzun.css'), 'utf8');
  assert.ok(written.startsWith('/* başlık */\nbody { font-family: "Inter"; color: red; }\n'), 'unescaped quotes are kept');
  assert.equal(written.split('\n').length - 1, 402, '401 whole lines from the cut answer, then the appended one');
  assert.ok(!written.includes('.yarim'), 'the half line is not written');
  assert.ok(written.endsWith('.son {}\n'));
  const told = api.requests[1].messages.at(-1).content;
  assert.match(told, /Dosya bitmedi/);
  assert.match(told, /son yazılan satır: "body \{ font-family: \\"Inter\\"; color: red; \}"/);
  assert.match(told, /append_file/);
});

test('a cut call that cannot be saved is reported with the advice to write in parts', async t => {
  const { toolbox } = project(t);
  // The content comes before the path, so the path never arrived.
  const cut = `<tool_call>\n{"name": "write_file", "arguments": {"content": "${'a {}\n'.repeat(3000)}`;
  const api = await umay(t, [cut, 'Anladım.']);
  await runTurn({ apiKey: 'k', baseURL: api.baseURL, system: 's', toolbox, history: [{ role: 'user', content: 'x' }], emit: () => {}, approve: async () => 'yes' });
  const told = api.requests[1].messages.at(-1).content;
  assert.match(told, /uzunluk sınırına takılıp kesildi/);
  assert.match(told, /append_file/);
  assert.match(api.requests[0].messages[0].content, /append_file/, 'the tool and the rule are in the instructions');
});
