const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createToolbox } = require('../src/tools');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umay-proje-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'paket'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'hesap.py'), 'def kdv(tutar):\n    return tutar * 0.18\n');
  fs.writeFileSync(path.join(root, 'notlar.txt'), 'ilk satır\r\nikinci satır\r\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'paket', 'index.js'), 'kdv\n');
  return { root, box: createToolbox(root) };
}

test('paths must stay inside the project folder', async t => {
  const { root, box } = project(t);
  for (const outside of ['../dışarı.txt', path.join(os.homedir(), '.ssh', 'id_rsa'), 'C:\\Windows\\win.ini']) {
    assert.match(await box.run('read_file', { path: outside }), /proje klasörünün dışında/);
  }
  assert.match(await box.run('write_file', { path: '../kaçış.txt', content: 'x' }), /proje klasörünün dışında/);
  assert.equal(fs.existsSync(path.join(root, '..', 'kaçış.txt')), false);
  assert.throws(() => box.preview('write_file', { path: '..\\kaçış.txt', content: 'x' }), /dışında/);
});

test('read, list and search work inside the folder and skip node_modules', async t => {
  const { box } = project(t);
  const read = await box.run('read_file', { path: 'src/hesap.py' });
  assert.match(read, /\(2 satır;/);
  assert.match(read, /    2→    return tutar \* 0\.18/);
  assert.match(await box.run('read_file', { path: 'src/hesap.py', start_line: 2, max_lines: 1 }), /^.*\n    2→/);
  const listing = await box.run('list_dir', {});
  assert.match(listing, /src\//);
  assert.match(listing, /notlar\.txt {2}\(/);
  assert.match(await box.run('list_dir', { pattern: '*.py', recursive: true }), /src[\\/]hesap\.py/);
  const found = await box.run('search_files', { pattern: 'KDV' });
  assert.match(found, /src[\\/]hesap\.py:1: def kdv/);
  assert.doesNotMatch(found, /node_modules/);
  assert.match(await box.run('search_files', { pattern: '(' }), /geçersiz regex/);
  assert.match(await box.run('read_file', {}), /eksik argüman: path/);
  assert.match(await box.run('read_file', { path: 'notlar.txt', proje: 'x' }), /yok sayıldı: proje/);
});

test('write_file shows a diff first, keeps CRLF files CRLF, warns when a long file shrinks and can be undone', async t => {
  const { root, box } = project(t);
  const fresh = box.preview('write_file', { path: 'yeni/a.json', content: '{"a": 1}' });
  assert.equal(fresh.kind, 'diff');
  assert.match(fresh.text, /yeni dosya/);
  assert.match(await box.run('write_file', { path: 'yeni/a.json', content: '{"a": 1}' }), /yazıldı: .*Syntax check: OK/s);
  assert.match(await box.run('write_file', { path: 'bozuk.json', content: '{"a": ' }), /SYNTAX ERROR/);

  const preview = box.preview('write_file', { path: 'notlar.txt', content: 'ilk satır\nüçüncü satır\n' });
  assert.match(preview.text, /^-ikinci satır$/m);
  assert.match(preview.text, /^\+üçüncü satır$/m);
  await box.run('write_file', { path: 'notlar.txt', content: 'ilk satır\nüçüncü satır\n' });
  assert.equal(fs.readFileSync(path.join(root, 'notlar.txt'), 'utf8'), 'ilk satır\r\nüçüncü satır\r\n');
  assert.match(box.undoLast(), /eski hâline döndü/);
  assert.equal(fs.readFileSync(path.join(root, 'notlar.txt'), 'utf8'), 'ilk satır\r\nikinci satır\r\n');

  fs.writeFileSync(path.join(root, 'uzun.txt'), Array.from({ length: 40 }, (_, i) => `satır ${i}`).join('\n'));
  assert.match(box.preview('write_file', { path: 'uzun.txt', content: 'kısa' }).warning, /replaced a 40-line file/);
  assert.match(box.undoLast(), /silindi \(araçla oluşturulmuştu\)/);
});

test('edit_file: exact, without line numbers, with trailing spaces, ambiguous and missing text', async t => {
  const { root, box } = project(t);
  const file = path.join(root, 'src', 'hesap.py');
  assert.match(box.preview('edit_file', { path: 'src/hesap.py', old_text: '0.18', new_text: '0.20' }).text, /^\+    return tutar \* 0\.20$/m);
  assert.match(await box.run('edit_file', { path: 'src/hesap.py', old_text: '0.18', new_text: '0.20' }), /düzenlendi/);
  assert.match(fs.readFileSync(file, 'utf8'), /0\.20/);
  // Copied from read_file output, with the line numbers.
  await box.run('edit_file', { path: 'src/hesap.py', old_text: '    2→    return tutar * 0.20', new_text: '    2→    return round(tutar * 0.20, 2)' });
  assert.match(fs.readFileSync(file, 'utf8'), /round\(tutar \* 0\.20, 2\)/);
  fs.writeFileSync(file, 'a = 1   \nb = 2\na = 1\n');
  assert.match(await box.run('edit_file', { path: 'src/hesap.py', old_text: 'a = 1', new_text: 'a = 3' }), /2 kez geçiyor \(satır 1, 3\)/);
  assert.match(await box.run('edit_file', { path: 'src/hesap.py', old_text: 'b = 2\n', new_text: 'b = $& 5\n' }), /düzenlendi/);
  assert.match(fs.readFileSync(file, 'utf8'), /b = \$& 5/, 'replacement text is taken literally');
  assert.match(await box.run('edit_file', { path: 'src/hesap.py', old_text: 'c = 9 + bambaşka', new_text: 'x' }), /bulunamadı/);
  assert.match(await box.run('edit_file', { path: 'src/hesap.py', old_text: 'b = $& 6', new_text: 'x' }), /en çok benzeyen kısım/);
});

test('run_command runs in the project folder, reports the exit code and stops at the time limit', async t => {
  const { root, box } = project(t);
  const command = process.platform === 'win32' ? 'Get-Location | Select-Object -ExpandProperty Path; Write-Output "çağrı tamam"' : 'pwd; echo "çağrı tamam"';
  const result = await box.run('run_command', { command });
  assert.match(result, /^çıkış kodu: 0/);
  assert.ok(result.includes(fs.realpathSync.native(root)) || result.includes(root), result);
  assert.match(result, /çağrı tamam/);
  assert.match(await box.run('run_command', { command: process.platform === 'win32' ? 'exit 3' : 'exit 3' }), /^çıkış kodu: 3/);
  const slow = await box.run('run_command', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', timeout: 2 });
  assert.match(slow, /2 saniyede bitmedi/);
  assert.equal(box.preview('run_command', { command: 'dir' }).kind, 'command');
});

test('a running command stops when the turn is stopped', async t => {
  const { box } = project(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  const started = Date.now();
  await assert.rejects(box.run('run_command', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30' }, controller.signal));
  assert.ok(Date.now() - started < 10_000);
});

test('append_file adds to the end, keeps CRLF, creates a missing file and can be undone', async t => {
  const { root, box } = project(t);
  const preview = box.preview('append_file', { path: 'notlar.txt', content: 'üçüncü satır\n' });
  assert.match(preview.text, /sonuna ekleniyor/);
  assert.match(preview.text, /^\+üçüncü satır$/m);
  assert.match(await box.run('append_file', { path: 'notlar.txt', content: 'üçüncü satır\n' }), /eklendi: .*dosya şimdi 4 satır/);
  assert.equal(fs.readFileSync(path.join(root, 'notlar.txt'), 'utf8'), 'ilk satır\r\nikinci satır\r\nüçüncü satır\r\n');
  await box.run('append_file', { path: 'parca/a.css', content: 'a {}\n' });
  await box.run('append_file', { path: 'parca/a.css', content: 'b {}\n' });
  assert.equal(fs.readFileSync(path.join(root, 'parca', 'a.css'), 'utf8'), 'a {}\nb {}\n');
  assert.match(box.undoLast(), /eski hâline döndü/);
  assert.equal(fs.readFileSync(path.join(root, 'parca', 'a.css'), 'utf8'), 'a {}\n');
  assert.match(await box.run('append_file', { path: '../dış.txt', content: 'x' }), /dışında/);
});

test('no tool has an argument named like a key of the call format', t => {
  // {"name": "start_process", "arguments": {..., "name": "x"}} could not be read: "name" twice (13 Nov 2026).
  const { box } = project(t);
  for (const schema of box.schemas) {
    for (const key of Object.keys(schema.parameters.properties)) {
      assert.ok(!['name', 'arguments', 'parameters', 'args', 'tool', 'function'].includes(key), `${schema.name}.${key}`);
    }
  }
});

test('a start_process call written in the text protocol is read with its label', t => {
  const { box } = project(t);
  const { parseToolCalls } = require('../src/texttools');
  const parsed = parseToolCalls('<tool_call>\n{"name": "start_process", "arguments": {"command": "python -m http.server 8080", "label": "web sunucusu"}}\n</tool_call>', box.schemas);
  assert.deepEqual(parsed.calls, [{ name: 'start_process', args: { command: 'python -m http.server 8080', label: 'web sunucusu' } }]);
});
