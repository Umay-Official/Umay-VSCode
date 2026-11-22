const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createToolbox } = require('../src/tools');
const { localUrl, checkUrl } = require('../src/processes');

// A tiny server the test project starts like a real one: it prints its address and answers "merhaba".
const SERVER = `const http = require('http');
const server = http.createServer((req, res) => res.end('merhaba ' + req.url));
server.listen(0, '127.0.0.1', () => console.log('Sunucu hazır: http://localhost:' + server.address().port + '/'));`;

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umay-surec-'));
  fs.writeFileSync(path.join(root, 'sunucu.js'), SERVER);
  const changes = [];
  const box = createToolbox(root, { onProcessChange: () => changes.push(box.processes.list().map(item => `${item.id}:${item.status}`).join(',')) });
  t.after(async () => {
    await box.processes.stopAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return { root, box, changes };
}

test('localUrl finds the address servers print and calls every local form localhost', () => {
  assert.equal(localUrl('Serving HTTP on :: port 8080 (http://[::]:8080/) ...'), 'http://localhost:8080/');
  assert.equal(localUrl('  ➜  Local:   http://localhost:5173/'), 'http://localhost:5173/');
  assert.equal(localUrl('listening on http://0.0.0.0:3000.'), 'http://localhost:3000');
  assert.equal(localUrl('see https://example.com'), undefined);
});

test('a server starts in the background, its address is found, it answers, and it stops', async t => {
  const { box, changes } = project(t);
  assert.ok(box.needsApproval('start_process'));
  assert.ok(!box.needsApproval('check_url') && !box.needsApproval('process_output') && !box.needsApproval('stop_process'));
  assert.equal(box.preview('start_process', { command: 'node sunucu.js' }).kind, 'command');

  const started = await box.run('start_process', { command: 'node sunucu.js', label: 'deneme sunucusu' });
  assert.match(started, /^başlatıldı: p1 · node sunucu\.js/);
  assert.match(started, /durum: çalışıyor/);
  const url = /adres: (\S+)/.exec(started)?.[1];
  assert.match(url, /^http:\/\/localhost:\d+\/$/);
  const [item] = box.processes.list();
  assert.equal(item.name, 'deneme sunucusu');
  assert.equal(item.url, url);

  assert.match(await box.run('check_url', { url: `${url}selam` }), /HTTP 200[\s\S]*merhaba \/selam/);
  assert.match(await box.run('process_output', { id: 'p1' }), /Sunucu hazır/);
  assert.match(await box.run('stop_process', { id: 'p1' }), /^durduruldu: p1[\s\S]*durum: durduruldu/);
  assert.match(await box.run('check_url', { url }), /^Hata: .*bağlantı reddedildi/);
  assert.ok(changes.some(state => state.includes('p1:running')) && changes.at(-1).includes('p1:stopped'), changes.join(' | '));
  assert.match(await box.run('stop_process', { id: 'p9' }), /böyle bir süreç yok/);
});

test('a command that fails at once is reported as an error; a quiet one says no address was seen', async t => {
  const { box } = project(t);
  const failed = await box.run('start_process', { command: 'node yok-boyle-dosya.js', wait: 5 });
  assert.match(failed, /^Hata: süreç hemen kapandı/);
  assert.match(failed, /bitti \(çıkış kodu: [1-9]/);
  const quiet = await box.run('start_process', { command: 'node -e "setInterval(() => {}, 1000)"', wait: 1 });
  assert.match(quiet, /durum: çalışıyor/);
  assert.match(quiet, /Henüz bir adres görünmedi/);
  await box.processes.stopAll();
  assert.ok(box.processes.list().every(item => item.status !== 'running'));
});

test('check_url refuses addresses outside this computer', async () => {
  await assert.rejects(checkUrl('https://example.com/'), /yalnızca bu bilgisayardaki/);
  await assert.rejects(checkUrl('http://192.168.1.1/'), /yalnızca bu bilgisayardaki/);
  await assert.rejects(checkUrl('file:///C:/Windows/win.ini'), /yalnızca bu bilgisayardaki/);
  const server = http.createServer((_req, res) => res.end('tamam')).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { assert.match(await checkUrl(`http://127.0.0.1:${server.address().port}/`), /HTTP 200[\s\S]*tamam/); }
  finally { server.close(); }
});
