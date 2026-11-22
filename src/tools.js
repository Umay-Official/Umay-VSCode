// Tools Umay can use in the open workspace folder. From Umay Code (src/tools.js), a Node port of Umay CLI's
// python/tools.py (from Gambit AI CLI, Copyright (c) 2026 Eray Çiçek), so the extension needs no Python.
// Unlike the CLI, every path must stay inside the project folder: a file's text cannot make Umay read ~/.ssh or
// write elsewhere. Commands are not limited this way, so they always need the user's approval.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createTwoFilesPatch } = require('diff');
const { createProcessManager, processTools } = require('./processes');

const MAX_OUTPUT = 20_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_ENTRIES = 500;
// Umay's answers stop at about 24 KB; one tool call's content should stay well below that.
const PART_LIMIT_KB = 8;
const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.mypy_cache', '.pytest_cache', 'dist', 'build', 'out', '.next']);
const CODE_EXTS = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.ps1', '.sh', '.go', '.rs', '.java', '.c', '.cpp', '.cs', '.php', '.rb']);
const LINE_PREFIX = /^ *\d+→/;

class ToolError extends Error {}

const truncate = (text, limit = MAX_OUTPUT) => text.length <= limit ? text
  : `${text.slice(0, limit)}\n... [kesildi: ${text.length - limit} karakter daha var; dosyaysa read_file ile start_line/max_lines vererek parça parça oku, komutsa çıktıyı daralt]`;
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const numbered = (lines, start) => lines.map((line, i) => `${String(i + start).padStart(5)}→${line}`).join('\n');
const globRegex = pattern => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

// ---------- Environment ----------

function which(name) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    // The Microsoft Store shortcut named python only opens the store.
    return out.split(/\r?\n/).map(line => line.trim()).find(line => line && !/WindowsApps/i.test(line)) ?? null;
  } catch { return null; }
}

let environment;
function detect() {
  if (environment) return environment;
  let shell;
  if (process.platform === 'win32') {
    const pwsh = which('pwsh');
    shell = pwsh ? { file: pwsh, args: ['-NoProfile', '-NonInteractive', '-Command'], name: 'PowerShell 7', powershell: true }
      : { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'], name: 'Windows PowerShell 5.1', powershell: true };
  } else shell = { file: '/bin/sh', args: ['-c'], name: 'sh', powershell: false };
  const python = which('python') ?? which('python3') ?? which('py');
  const programs = ['node', 'npm', 'git', 'sqlite3'].filter(which);
  if (python) programs.unshift('python');
  environment = { shell, python, programs };
  return environment;
}

const PS_PRELUDE = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; ";
const PS51_PRELUDE = "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; $PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'; $PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'; ";

// ---------- Paths and files ----------

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolver(root) {
  return value => {
    if (typeof value !== 'string' || !value.trim()) throw new ToolError('yol boş olamaz');
    const target = path.resolve(root, value.trim());
    if (!inside(root, target)) throw new ToolError(`yol proje klasörünün dışında: ${value}. Yalnızca ${root} içinde çalışabilirsin.`);
    // A link inside the folder that points outside it is outside too.
    try {
      const real = fs.realpathSync.native(target);
      if (!inside(fs.realpathSync.native(root), real)) throw new ToolError(`yol proje klasörünün dışına bağlanıyor: ${value}`);
    } catch (error) { if (error instanceof ToolError) throw error; }
    return target;
  };
}

function isBinary(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } finally { fs.closeSync(handle); }
}

function readText(file, strict = false) {
  let stat;
  try { stat = fs.statSync(file); } catch { throw new ToolError(`dosya bulunamadı: ${file}`); }
  if (!stat.isFile()) throw new ToolError(`dosya bulunamadı: ${file}`);
  if (stat.size > MAX_FILE_BYTES) throw new ToolError(`dosya çok büyük (${size(stat.size)}): ${file}`);
  if (isBinary(file)) throw new ToolError(`ikili (binary) dosya, metin olarak okunamaz: ${file}`);
  const buffer = fs.readFileSync(file);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch {
    if (strict) throw new ToolError(`dosya UTF-8 değil, bozulmaması için düzenlenmedi: ${file}`);
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function writeText(file, text, crlf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  text = text.replace(/\r\n/g, '\n');
  fs.writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
}

function diff(file, before, after) {
  const name = path.basename(file);
  const patch = createTwoFilesPatch(`a/${name}`, `b/${name}`, before, after, '', '', { context: 2 });
  const lines = patch.split('\n').filter(line => !line.startsWith('====') && !/^\\ No newline/.test(line));
  return lines.some(line => line.startsWith('@@')) ? lines.join('\n').trim() : '(değişiklik yok)';
}

function* walk(root, pattern) {
  const match = globRegex(pattern);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const dirs = [];
    for (const entry of entries) {
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) dirs.push(path.join(dir, entry.name)); }
      else if (match.test(entry.name)) yield path.join(dir, entry.name);
    }
    stack.push(...dirs.reverse());
  }
}

// ---------- Processes ----------

// Ends the process and everything it started (closing only the shell would leave an endless loop running),
// and waits until it is gone, so the folder is free again when the call returns.
function killTree(child) {
  return new Promise(resolve => {
    if (!child.pid || child.exitCode !== null) { resolve(); return; }
    const done = setTimeout(resolve, 5000);
    child.once('close', () => { clearTimeout(done); resolve(); });
    if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }).on('error', () => {});
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  });
}

function runProcess(file, args, { cwd, timeout, input, env, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: env ?? process.env, windowsHide: true, detached: process.platform !== 'win32' });
    let out = '';
    let err = '';
    let finished = false;
    const stop = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killTree(child).then(() => reject(new ToolError(reason)));
    };
    const timer = setTimeout(() => stop(`komut ${timeout} saniyede bitmedi; komut ve başlattığı tüm süreçler durduruldu (sonsuz döngü ya da girdi bekleyen bir program olabilir)`), timeout * 1000);
    const onAbort = () => stop('Kullanıcı durdurdu; komut ve alt süreçleri kapatıldı.');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', data => { if (out.length < MAX_OUTPUT * 2) out += data; });
    child.stderr.setEncoding('utf8').on('data', data => { if (err.length < MAX_OUTPUT * 2) err += data; });
    child.on('error', error => { if (!finished) { finished = true; clearTimeout(timer); reject(new ToolError(`başlatılamadı: ${error.message}`)); } });
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

function processResult({ code, out, err }, powershell) {
  let head = `çıkış kodu: ${code}`;
  // PowerShell carries on after most errors and still exits with 0.
  if (code === 0 && err.trim() && powershell) head += ' (ancak stderr\'de hata mesajı var; PowerShell bazı hatalarda çıkış kodunu değiştirmez)';
  const parts = [head];
  if (out.trim()) parts.push(out.trim());
  if (err.trim()) parts.push(`[stderr]\n${err.trim()}`);
  return parts.join('\n');
}

const clampTimeout = value => Math.min(Math.max(Number.parseInt(value, 10) || 120, 1), 600);

// ---------- After a write ----------

async function syntaxCheck(file, text, signal) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') { try { JSON.parse(text); return ''; } catch (error) { return error.message; } }
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    // Electron can run as plain Node, so the check needs no Node installation.
    try {
      const result = await runProcess(process.execPath, ['--check', file], { timeout: 20, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, signal });
      return result.code === 0 ? '' : (result.err || result.out).trim().split('\n').filter(Boolean).slice(0, 8).join('\n');
    } catch { return null; }
  }
  if (ext === '.py' && detect().python) {
    try {
      const result = await runProcess(detect().python, ['-B', '-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', file], { timeout: 20, signal });
      return result.code === 0 ? '' : (result.err || result.out).trim().split('\n').slice(-3).join('\n');
    } catch { return null; }
  }
  return null;
}

async function afterWrite(file, text, signal) {
  const check = await syntaxCheck(file, text, signal);
  if (check) return `\nSYNTAX ERROR: ${check}\nThe file was saved but does not compile. Fix it next.`;
  const note = check === '' ? '\nSyntax check: OK.' : '';
  if (!CODE_EXTS.has(path.extname(file).toLowerCase())) return note;
  return `${note}\nNext step: before finishing, run this code yourself (its tests, or a short script); a syntax check alone is not verification. Do not ask the user to run it. Do not start servers or other commands that never finish.`;
}

function shrinkWarning(file, content) {
  let oldLines;
  try { oldLines = readText(file).split('\n').length; } catch { return ''; }
  const newLines = content.split('\n').length;
  return oldLines >= 30 && newLines < oldLines * 0.5
    ? `Warning: this replaced a ${oldLines}-line file with only ${newLines} lines. write_file overwrites the WHOLE file; if you meant to change only part of it, the rest of the file is now gone: write the complete file again (use edit_file for partial changes).`
    : '';
}

// ---------- edit_file helpers ----------

function stripLineNumbers(text) {
  const lines = text.split('\n');
  const filled = lines.filter(line => line.trim());
  if (!filled.length || !filled.every(line => LINE_PREFIX.test(line))) return [text, false];
  return [lines.map(line => line.replace(LINE_PREFIX, '')).join('\n'), true];
}

function looseReplace(text, oldText, newText) {
  const lines = text.split('\n');
  let oldLines = oldText.split('\n');
  let newLines = newText.split('\n');
  if (oldLines.length > 1 && oldLines.at(-1) === '') {
    oldLines = oldLines.slice(0, -1);
    if (newLines.length > 1 && newLines.at(-1) === '') newLines = newLines.slice(0, -1);
  }
  const key = oldLines.map(line => line.trimEnd());
  if (!key.some(Boolean)) return null;
  const stripped = lines.map(line => line.trimEnd());
  const hits = [];
  for (let i = 0; i + key.length <= lines.length; i++) if (key.every((line, j) => stripped[i + j] === line)) hits.push(i);
  if (hits.length !== 1) return null;
  return [...lines.slice(0, hits[0]), ...newLines, ...lines.slice(hits[0] + key.length)].join('\n');
}

// Bigram similarity of two strings, 0..1.
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) ?? 0) + 1); }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) { const g = b.slice(i, i + 2); const n = grams.get(g); if (n) { shared++; grams.set(g, n - 1); } }
  return (2 * shared) / (a.length + b.length - 2);
}

function closest(text, oldText) {
  const lines = text.split('\n');
  const want = oldText.replace(/^\n+|\n+$/g, '').split('\n').map(line => line.trim());
  if (!lines.length || !want.some(Boolean)) return '';
  const target = want.join('\n');
  const stripped = lines.map(line => line.trim());
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.max(1, lines.length - want.length + 1); i++) {
    const score = similarity(stripped.slice(i, i + want.length).join('\n'), target);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0 || bestScore < 0.5) return ' Dosyada benzer bir kısım da yok; dosyayı read_file ile tekrar oku.';
  const from = Math.max(0, best - 1);
  const to = Math.min(lines.length, best + want.length + 1);
  return `\nDosyada en çok benzeyen kısım (satır ${from + 1}-${to}, benzerlik %${Math.round(bestScore * 100)}). old_text'i buradan birebir, satır numaraları ve → olmadan kopyala:\n${numbered(lines.slice(from, to).slice(0, 60), from + 1)}`;
}

function editTarget(file, oldText, newText) {
  const raw = readText(file, true);
  const text = raw.replace(/\r\n/g, '\n');
  let numberedInput;
  [oldText, numberedInput] = stripLineNumbers(String(oldText ?? '').replace(/\r\n/g, '\n'));
  newText = String(newText ?? '').replace(/\r\n/g, '\n');
  if (numberedInput) newText = stripLineNumbers(newText)[0];
  if (!oldText) throw new ToolError('old_text boş olamaz');
  const count = text.split(oldText).length - 1;
  if (count === 1) return { before: text, after: text.replace(oldText, () => newText), crlf: raw.includes('\r\n') };
  if (count > 1) {
    const where = [];
    for (let at = text.indexOf(oldText); at >= 0 && where.length < 10; at = text.indexOf(oldText, at + 1)) where.push(text.slice(0, at).split('\n').length);
    throw new ToolError(`old_text dosyada ${count} kez geçiyor (satır ${where.join(', ')}); çevresinden birkaç satır daha ekleyerek benzersiz yap`);
  }
  const loose = looseReplace(text, oldText, newText);
  if (loose !== null) return { before: text, after: loose, crlf: raw.includes('\r\n') };
  throw new ToolError(`old_text dosyada bulunamadı.${closest(text, oldText)}`);
}

// ---------- Definitions ----------

const schema = (properties, required) => ({ type: 'object', properties, required });

function definitions() {
  const { shell, python } = detect();
  const shellHint = shell.powershell ? ` Use ${shell.name} syntax, not bash; inside double quotes \\" is NOT an escaped quote in PowerShell.` : '';
  const tools = {
    read_file: {
      description: "Read a text file. Each returned line starts with its line number and an arrow, like '    3→text'; the number and the arrow are NOT part of the file content.",
      parameters: schema({ path: { type: 'string', description: 'File path' }, start_line: { type: 'integer', description: 'First line to return (1-based). Default 1' }, max_lines: { type: 'integer', description: 'Maximum number of lines. Default 400' } }, ['path']),
      run: ({ path: file, start_line: startLine = 1, max_lines: maxLines = 400 }, { resolve }) => {
        const target = resolve(file);
        const lines = readText(target).replace(/\r\n/g, '\n').split('\n');
        if (lines.length > 1 && lines.at(-1) === '') lines.pop();
        const start = Math.max(1, Number.parseInt(startLine, 10) || 1);
        const end = Math.min(lines.length, start + Math.max(1, Number.parseInt(maxLines, 10) || 400) - 1);
        const more = end < lines.length ? `\n... (${lines.length - end} satır daha var; devamı için start_line=${end + 1})` : '';
        return `${target} (${lines.length} satır; soldaki numaralar ve → işareti dosyaya ait değildir)\n${numbered(lines.slice(start - 1, end), start)}${more}`;
      },
    },
    list_dir: {
      description: 'List files and folders. With recursive=true, lists matching files in all subfolders (use this to find files by name).',
      parameters: schema({ path: { type: 'string', description: 'Folder path. Default: the project folder' }, pattern: { type: 'string', description: 'Name filter like *.py. Default *' }, recursive: { type: 'boolean', description: 'Search subfolders. Default false' } }, []),
      run: ({ path: dir = '.', pattern = '*', recursive = false }, { resolve }) => {
        const root = resolve(dir);
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new ToolError(`klasör bulunamadı: ${root}`);
        const rows = [];
        if (recursive === true || recursive === 'true') {
          for (const file of walk(root, String(pattern))) { rows.push(path.relative(root, file)); if (rows.length >= MAX_ENTRIES) break; }
        } else {
          const match = globRegex(String(pattern));
          const entries = fs.readdirSync(root, { withFileTypes: true })
            .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
          for (const entry of entries) {
            if (!match.test(entry.name)) continue;
            if (entry.isDirectory()) rows.push(`${entry.name}/`);
            else { try { rows.push(`${entry.name}  (${size(fs.statSync(path.join(root, entry.name)).size)})`); } catch { rows.push(entry.name); } }
            if (rows.length >= MAX_ENTRIES) break;
          }
        }
        if (!rows.length) return `${root}: eşleşen öğe yok`;
        return `${root} (${rows.length} öğe)\n${rows.join('\n')}${rows.length >= MAX_ENTRIES ? `\n... (ilk ${MAX_ENTRIES} öğe gösterildi)` : ''}`;
      },
    },
    search_files: {
      description: 'Search inside files with a case-insensitive regex. Returns file:line: text matches.',
      parameters: schema({ pattern: { type: 'string', description: 'Regular expression to search for' }, path: { type: 'string', description: 'Folder or file to search. Default: the project folder' }, file_pattern: { type: 'string', description: 'Only search files matching this name filter, like *.py' } }, ['pattern']),
      run: ({ pattern, path: where = '.', file_pattern: filePattern = '*' }, { resolve }) => {
        let regex;
        try { regex = new RegExp(String(pattern), 'i'); } catch (error) { throw new ToolError(`geçersiz regex: ${error.message}`); }
        let root = resolve(where);
        let candidates;
        if (fs.existsSync(root) && fs.statSync(root).isFile()) { candidates = [root]; root = path.dirname(root); }
        else if (fs.existsSync(root)) candidates = walk(root, String(filePattern));
        else throw new ToolError(`yol bulunamadı: ${root}`);
        const hits = [];
        for (const file of candidates) {
          try {
            if (fs.statSync(file).size > MAX_FILE_BYTES || isBinary(file)) continue;
            const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (!regex.test(lines[i])) continue;
              hits.push(`${path.relative(root, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              if (hits.length >= 200) return `${hits.join('\n')}\n... (ilk 200 eşleşme gösterildi)`;
            }
          } catch { /* unreadable file */ }
        }
        return hits.length ? hits.join('\n') : 'eşleşme yok';
      },
    },
    write_file: {
      description: `Create a new file or completely overwrite an existing one with the full content. Parent folders are created. Code files are syntax-checked automatically. Keep content under ${PART_LIMIT_KB} KB: for a longer file write the first part here and the rest with append_file. Requires user approval.`,
      parameters: schema({ path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Full file content' } }, ['path', 'content']),
      needsApproval: true,
      preview: ({ path: file, content = '' }, { resolve }) => {
        const target = resolve(file);
        // `after` is the whole new content, so the editor can open a real side-by-side diff.
        const after = String(content).replace(/\r\n/g, '\n');
        if (!fs.existsSync(target)) return { kind: 'diff', file: target, isNew: true, after, text: `+++ ${path.basename(target)} (yeni dosya)\n${String(content).split('\n').map(line => `+${line}`).join('\n')}` };
        const warning = shrinkWarning(target, String(content));
        return { kind: 'diff', file: target, warning, after, text: diff(target, readText(target).replace(/\r\n/g, '\n'), after) };
      },
      run: async ({ path: file, content = '' }, { resolve, remember, signal }) => {
        const target = resolve(file);
        content = String(content);
        const crlf = fs.existsSync(target) && readText(target).includes('\r\n');
        const warning = shrinkWarning(target, content);
        remember(target);
        writeText(target, content, crlf);
        return `yazıldı: ${target} (${content.split('\n').length} satır)${warning ? `\n${warning}` : ''}${await afterWrite(target, content, signal)}`;
      },
    },
    edit_file: {
      description: 'Replace one exact occurrence of old_text with new_text in a file. old_text must match the file exactly (copy it from read_file output without line numbers) and be unique. Requires user approval.',
      parameters: schema({ path: { type: 'string', description: 'File path' }, old_text: { type: 'string', description: 'Exact existing text to replace' }, new_text: { type: 'string', description: 'Replacement text' } }, ['path', 'old_text', 'new_text']),
      needsApproval: true,
      preview: ({ path: file, old_text: oldText, new_text: newText }, { resolve }) => {
        const target = resolve(file);
        const { before, after } = editTarget(target, oldText, newText);
        return { kind: 'diff', file: target, after, text: diff(target, before, after) };
      },
      run: async ({ path: file, old_text: oldText, new_text: newText }, { resolve, remember, signal }) => {
        const target = resolve(file);
        const { after, crlf } = editTarget(target, oldText, newText);
        remember(target);
        writeText(target, after, crlf);
        return `düzenlendi: ${target}${await afterWrite(target, after, signal)}`;
      },
    },
    // Umay cuts an answer at about 24 KB (8k tokens) without saying so, which leaves a long write_file call
    // half-written and unreadable. Long files are written in parts: write_file, then append_file.
    append_file: {
      description: `Append content to the end of a file (created if missing). Use it to write a long file in parts: write_file with the first part, then append_file for each next part. Keep each part under ${PART_LIMIT_KB} KB. Requires user approval.`,
      parameters: schema({ path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Text to add at the end of the file' } }, ['path', 'content']),
      needsApproval: true,
      preview: ({ path: file, content = '' }, { resolve }) => {
        const target = resolve(file);
        const exists = fs.existsSync(target);
        const lines = exists ? readText(target).replace(/\r\n/g, '\n').split('\n') : [];
        const tail = lines.slice(-3).map(line => ` ${line}`);
        const after = lines.join('\n') + String(content).replace(/\r\n/g, '\n');
        return { kind: 'diff', file: target, isNew: !exists, after, text: [`+++ ${path.basename(target)} (${exists ? `${lines.length} satırın sonuna ekleniyor` : 'yeni dosya'})`, ...tail, ...String(content).split('\n').map(line => `+${line}`)].join('\n') };
      },
      run: async ({ path: file, content = '' }, { resolve, remember }) => {
        const target = resolve(file);
        const before = fs.existsSync(target) ? readText(target, true) : '';
        remember(target);
        const after = before.replace(/\r\n/g, '\n') + String(content).replace(/\r\n/g, '\n');
        writeText(target, after, before.includes('\r\n'));
        // No syntax check: the file is often unfinished between parts.
        return `eklendi: ${target} (dosya şimdi ${after.split('\n').length} satır, ${size(Buffer.byteLength(after))}). Bittiyse dosyayı bir komutla veya testle doğrula.`;
      },
    },
    run_command: {
      description: `Run a shell command (${shell.name}) in the project folder and return its exit code and output.${shellHint}${python ? ' For Python code use run_python instead of python -c.' : ''} Requires user approval. Commands must finish by themselves: start servers, watchers and other long-running commands with start_process instead, never with Start-Process, start or & that detach them (those keep running where neither you nor the user can see or stop them).`,
      parameters: schema({ command: { type: 'string', description: 'Command to run' }, timeout: { type: 'integer', description: 'Seconds before the command is stopped. Default 120' } }, ['command']),
      needsApproval: true,
      preview: ({ command }) => ({ kind: 'command', text: String(command ?? '') }),
      run: async ({ command, timeout }, { root, signal }) => {
        if (typeof command !== 'string' || !command.trim()) throw new ToolError('command boş olamaz');
        const prelude = shell.powershell ? PS_PRELUDE + (shell.name.endsWith('5.1') ? PS51_PRELUDE : '') : '';
        return processResult(await runProcess(shell.file, [...shell.args, prelude + command], { cwd: root, timeout: clampTimeout(timeout), signal }), shell.powershell);
      },
    },
  };
  if (python) {
    tools.run_python = {
      description: 'Run a Python script in the project folder and return its exit code and output. Pass the code itself (multi-line is fine, no shell quoting needed). Best way to test code or process files and data. Modules in the project folder can be imported. stdin is empty, so input() does not work. Requires user approval.',
      parameters: schema({ code: { type: 'string', description: 'Python source code to run' }, timeout: { type: 'integer', description: 'Seconds before the script is stopped. Default 120' } }, ['code']),
      needsApproval: true,
      preview: ({ code }) => ({ kind: 'code', language: 'python', text: String(code ?? '') }),
      run: async ({ code, timeout }, { root, signal }) => processResult(await runProcess(python, ['-B', '-'], {
        cwd: root, timeout: clampTimeout(timeout), input: String(code ?? ''), signal, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      }), false),
    };
  }
  return tools;
}

// One project session: the folder, an undo list of earlier file contents, the background processes, and a way
// to run a call. onProcessChange is called whenever a background process starts, prints its address or ends.
// guard(file) runs before every write and may throw a ToolError: the editor uses it to protect unsaved changes.
function createToolbox(root, { onProcessChange = () => {}, guard = () => {} } = {}) {
  root = path.resolve(root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Proje klasörü bulunamadı: ${root}`);
  const tools = { ...definitions(), ...processTools() };
  const resolve = resolver(root);
  const { shell } = detect();
  const processes = createProcessManager({
    root, shell, onChange: onProcessChange,
    prelude: shell.powershell ? PS_PRELUDE + (shell.name.endsWith('5.1') ? PS51_PRELUDE : '') : '',
  });
  const undo = [];
  const remember = file => {
    guard(file);
    undo.push({ file, before: fs.existsSync(file) ? fs.readFileSync(file) : null });
    if (undo.length > 50) undo.shift();
  };
  const context = signal => ({ root, resolve, remember, signal, processes });

  return {
    root,
    tools,
    schemas: Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, parameters: tool.parameters })),
    needsApproval: name => Boolean(tools[name]?.needsApproval),
    preview(name, args) {
      const tool = tools[name];
      if (!tool?.preview) return null;
      return tool.preview(args, context());
    },
    async run(name, args, signal) {
      const tool = tools[name];
      if (!tool) return `Hata: bilinmeyen araç: ${name}. Kullanılabilen araçlar: ${Object.keys(tools).join(', ')}`;
      // Arguments the tool does not have are dropped with a note instead of failing the call.
      const known = tool.parameters.properties;
      const extra = Object.keys(args).filter(key => !(key in known));
      const clean = Object.fromEntries(Object.entries(args).filter(([key]) => key in known));
      const missing = tool.parameters.required.filter(key => clean[key] === undefined);
      if (missing.length) return `Hata: eksik argüman: ${missing.join(', ')}`;
      try {
        const result = truncate(String(await tool.run(clean, context(signal))));
        return extra.length ? `${result}\n(Not: bu araçta olmayan argümanlar yok sayıldı: ${extra.join(', ')})` : result;
      } catch (error) {
        if (signal?.aborted) throw error;
        return `Hata: ${error instanceof ToolError ? error.message : String(error?.message ?? error)}`;
      }
    },
    undoLast() {
      const last = undo.pop();
      if (!last) return null;
      try { guard(last.file); } catch (error) { undo.push(last); return error.message; }
      if (last.before === null) { fs.rmSync(last.file, { force: true }); return `silindi (araçla oluşturulmuştu): ${last.file}`; }
      fs.writeFileSync(last.file, last.before);
      return `eski hâline döndü: ${last.file}`;
    },
    environment: () => detect(),
    canUndo: () => undo.length > 0,
    processes,
  };
}

module.exports = { createToolbox, ToolError, inside, globRegex, PART_LIMIT_KB };
