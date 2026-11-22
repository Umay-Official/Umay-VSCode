// Runs inside VS Code (see run.js). A fake Umay server answers with scripted replies; the tests drive the
// extension the way a user does: the side bar view, the editor's selection, approvals, the quick fix menu.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const vscode = require('vscode');

const project = process.env.UMAY_TEST_PROJECT;
const file = name => path.join(project, name);
const call = (name, args) => `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, what, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await settle(100);
  }
  throw new Error(`zaman aşımı: ${what}`);
}

// A fake Umay: each chat request gets the next scripted answer, streamed as server-sent events.
async function fakeUmay(answers) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; }).on('end', () => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'umay-akilli', owned_by: 'umay' }, { id: 'umay-hizli', owned_by: 'umay' }] }));
        return;
      }
      const request = JSON.parse(body || '{}');
      if (!request.messages?.length) { res.writeHead(400); res.end('{}'); return; }
      requests.push(request);
      const answer = answers[requests.length - 1] ?? 'Bitti.';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of answer.match(/[\s\S]{1,30}/g)) res.write(`data: ${JSON.stringify({ model: 'umay-hizli', choices: [{ delta: { content: piece } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  await vscode.workspace.getConfiguration('umay').update('baseUrl', baseURL, vscode.ConfigurationTarget.Global);
  return { requests, close: () => { server.closeAllConnections(); server.close(); } };
}

let view;
let original;
// Every message the extension posts to the webview for request `id`, with a hook for approvals.
function watch(id, onApproval) {
  const events = [];
  view.post = message => {
    if (message.type === 'event' && message.id === id) {
      events.push(message.event);
      if (message.event.type === 'tool' && message.event.status === 'approval') setTimeout(() => onApproval(message.event), 0);
    }
    original(message);
  };
  return events;
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

test('the extension starts and registers its commands, view and quick fix', async () => {
  const extension = vscode.extensions.getExtension('umay-official.umay');
  assert.ok(extension, 'extension found');
  ({ view } = await extension.activate());
  original = view.post.bind(view);
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['umay.focus', 'umay.newChat', 'umay.history', 'umay.setKey', 'umay.ask', 'umay.explain', 'umay.fix', 'umay.tests', 'umay.document', 'umay.undo', 'umay.chat.focus']) {
    assert.ok(commands.includes(name), `${name} registered`);
  }
});

test('the side bar view loads its page and the page reports ready', async () => {
  await vscode.commands.executeCommand('umay.chat.focus');
  await until(() => view.ready, 'webview ready');
  const status = await view.keyStatus();
  assert.equal(status.env, true, 'the key comes from UMAY_API_KEY');
});

test('a turn sees the selection, asks before editing, opens the diff and changes the file', async () => {
  const api = await fakeUmay([
    `Toplama yerine çıkarma yapılıyor, düzeltiyorum.\n${call('edit_file', { path: 'hesap.js', old_text: 'return a - b;', new_text: 'return a + b;' })}`,
    'Düzelttim: topla artık topluyor.',
  ]);
  try {
    const document = await vscode.workspace.openTextDocument(file('hesap.js'));
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(1, 0, 1, 15);
    let diffShown = false;
    const events = watch('t1', async event => {
      await view.openDiff('t1', event.callId);
      diffShown = vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input?.modified?.scheme === 'umay-oneri');
      view.answer('t1', event.callId, 'yes');
    });
    await view.send({ id: 't1', chatId: 'c1', text: 'Bu fonksiyondaki hatayı düzelt', model: 'umay-hizli', thinking: 'off', useContext: true, history: [] });

    assert.equal(events.at(-1).type, 'done', JSON.stringify(events.at(-1)));
    assert.match(fs.readFileSync(file('hesap.js'), 'utf8'), /return a \+ b;/);
    const context = events.find(event => event.type === 'context');
    assert.equal(context.label, 'hesap.js:2');
    const approval = events.find(event => event.status === 'approval');
    assert.equal(approval.preview.canDiff, true);
    assert.equal(approval.preview.after, undefined, 'the full content stays in the extension');
    assert.ok(diffShown, 'the side-by-side diff opened');
    await until(() => !vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input?.modified?.scheme === 'umay-oneri'), 'the diff closes once answered');
    const [first] = api.requests;
    assert.equal(first.enable_thinking, false);
    assert.match(first.messages[0].content, new RegExp(vscode.env.appName));
    assert.match(first.messages[0].content, /TOOL CALLS/);
    const sent = first.messages.at(-1).content;
    assert.match(sent, /^Bu fonksiyondaki hatayı düzelt\n\n\[Editör bağlamı\]/);
    assert.match(sent, /Seçili kod, satır 2-2:\n```javascript\n {2}return a - b;\n```/);
    // The open editor follows the file on disk.
    await until(() => document.getText().includes('a + b'), 'editor reloads the changed file');
  } finally { api.close(); }
});

test('a file with unsaved changes is not overwritten', async () => {
  await vscode.workspace.getConfiguration('umay').update('saveBeforeSend', false, vscode.ConfigurationTarget.Global);
  const api = await fakeUmay([call('write_file', { path: 'hesap.js', content: 'bozuk\n' }), 'Anladım, kaydetmeni bekliyorum.']);
  try {
    const document = await vscode.workspace.openTextDocument(file('hesap.js'));
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit(builder => builder.insert(new vscode.Position(0, 0), '// kaydedilmedi\n'));
    assert.ok(document.isDirty);
    const before = fs.readFileSync(file('hesap.js'), 'utf8');
    const events = watch('t2', event => view.answer('t2', event.callId, 'yes'));
    await view.send({ id: 't2', chatId: 'c2', text: 'dosyayı yeniden yaz', model: 'umay-hizli', thinking: 'off', useContext: false, history: [] });
    const result = events.find(event => event.type === 'tool' && event.status === 'done');
    assert.equal(result.ok, false);
    assert.match(result.result, /kaydedilmemiş değişiklikler/);
    assert.equal(fs.readFileSync(file('hesap.js'), 'utf8'), before);
    assert.match(api.requests[1].messages.at(-1).content, /kaydedilmemiş/, 'Umay hears why');
  } finally {
    api.close();
    await vscode.workspace.getConfiguration('umay').update('saveBeforeSend', undefined, vscode.ConfigurationTarget.Global);
  }
});

test('unsaved changes are saved before sending, so Umay sees what is on screen', async () => {
  const api = await fakeUmay(['Gördüm.']);
  try {
    const document = await vscode.workspace.openTextDocument(file('hesap.js'));
    assert.ok(document.isDirty, 'still dirty from the test before');
    watch('t3', () => {});
    await view.send({ id: 't3', chatId: 'c3', text: 'bak', model: 'umay-hizli', thinking: 'auto', useContext: true, history: [] });
    assert.equal(document.isDirty, false);
    assert.match(fs.readFileSync(file('hesap.js'), 'utf8'), /^\/\/ kaydedilmedi/);
    assert.equal(api.requests[0].enable_thinking, undefined, 'automatic thinking sends no switch');
  } finally { api.close(); }
});

test('"Umay ile düzelt" appears on an error and sends it through the side bar page', async () => {
  const api = await fakeUmay(['Bakıyorum.']);
  const diagnostics = vscode.languages.createDiagnosticCollection('umay-test');
  try {
    const document = await vscode.workspace.openTextDocument(file('hesap.js'));
    await vscode.window.showTextDocument(document);
    const range = new vscode.Range(2, 2, 2, 8);
    diagnostics.set(document.uri, [Object.assign(new vscode.Diagnostic(range, 'Toplama yerine çıkarma', vscode.DiagnosticSeverity.Error), { source: 'deneme' })]);
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, range);
    const fix = actions.find(action => /Umay ile düzelt/.test(action.title));
    assert.ok(fix, `quick fix offered: ${actions.map(action => action.title).join(', ')}`);
    view.post = original;
    await vscode.commands.executeCommand(fix.command.command, ...fix.command.arguments);
    // The page receives the prompt, sends it back like a typed message, and the extension runs the turn.
    await until(() => api.requests.length === 1, 'the page sends the quick fix');
    const sent = api.requests[0].messages.at(-1).content;
    assert.match(sent, /^Şu hatayı düzelt \(hesap\.js satır 3\): Toplama yerine çıkarma \[deneme\]/);
    assert.match(sent, /İlgili kısım, satır 1-/);
    await until(() => !view.running.size, 'turn ends');
  } finally {
    diagnostics.dispose();
    api.close();
  }
});

test('the last change Umay made can be undone', async () => {
  const message = view.undo(project);
  assert.match(message, /eski hâline döndü/);
  assert.match(fs.readFileSync(file('hesap.js'), 'utf8'), /return a - b;/);
  assert.match(view.undo(project), /Geri alınacak bir değişiklik yok/);
});

async function run() {
  const failures = [];
  for (const { name, run: body } of tests) {
    try {
      await Promise.race([body(), settle(90_000).then(() => { throw new Error('test 90 sn\'de bitmedi'); })]);
      console.log(`✔ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`✖ ${name}\n  ${error.stack ?? error}`);
    }
  }
  console.log(`\n${tests.length - failures.length}/${tests.length} geçti`);
  if (failures.length) throw new Error(`${failures.length} test başarısız`);
}

module.exports = { run };
