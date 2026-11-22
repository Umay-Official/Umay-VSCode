// Long-running commands Umay starts in the project folder: servers, watchers, builds that keep going. They run
// in the background, outlive the turn that started them, show in the window with a stop button, and all stop
// when the app closes. check_url looks at a local address, so Umay can verify a server without shell quoting.
const { spawn } = require('node:child_process');

const MAX_RUNNING = 5;
const OUTPUT_LIMIT = 64 * 1024;
// Addresses servers print when they start: localhost, 127.0.0.1, 0.0.0.0 and [::] (all mean this computer).
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"`<>)\]]*)?/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const localUrl = text => {
  const match = URL_PATTERN.exec(text)?.[0];
  return match?.replace(/\/\/(0\.0\.0\.0|\[::\])/, '//localhost').replace(/[.,;:]+$/, '');
};

function killTree(child) {
  return new Promise(resolve => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const done = setTimeout(resolve, 5000);
    child.once('close', () => { clearTimeout(done); resolve(); });
    if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }).on('error', () => {});
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  });
}

function createProcessManager({ root, shell, prelude = '', onChange = () => {} }) {
  const entries = new Map();
  let next = 0;

  const view = entry => ({
    id: entry.id, name: entry.name, command: entry.command, folder: root, pid: entry.child.pid,
    status: entry.status, code: entry.code, url: entry.url, started: entry.started,
  });
  const running = () => [...entries.values()].filter(entry => entry.status === 'running');

  function tail(entry, lines = 40) {
    const all = entry.output.replace(/\r\n/g, '\n').split('\n');
    while (all.length && !all.at(-1).trim()) all.pop();
    return all.slice(-lines).join('\n');
  }

  function describe(entry, lines) {
    const state = entry.status === 'running' ? 'çalışıyor' : entry.status === 'stopped' ? 'durduruldu' : `bitti (çıkış kodu: ${entry.code})`;
    const output = tail(entry, lines);
    return `${entry.id} · ${entry.command}\ndurum: ${state}${entry.url ? `\nadres: ${entry.url}` : ''}\nson çıktı:\n${output || '(henüz çıktı yok)'}`;
  }

  function start(command, { name, wait = 6, signal } = {}) {
    if (running().length >= MAX_RUNNING) {
      throw new Error(`En fazla ${MAX_RUNNING} süreç aynı anda çalışabilir. Önce birini stop_process ile durdur: ${running().map(entry => entry.id).join(', ')}`);
    }
    const id = `p${++next}`;
    const child = spawn(shell.file, [...shell.args, prelude + command], {
      cwd: root, windowsHide: true, detached: process.platform !== 'win32',
      // Python and others hold back output written to a pipe; the address must show at once.
      env: { ...process.env, PYTHONUNBUFFERED: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const entry = { id, name: name || command.slice(0, 60), command, child, status: 'running', code: null, url: null, output: '', started: Date.now() };
    entries.set(id, entry);
    const take = data => {
      entry.output = (entry.output + data).slice(-OUTPUT_LIMIT);
      if (!entry.url) {
        entry.url = localUrl(String(data)) ?? null;
        if (entry.url) onChange();
      }
    };
    child.stdout.setEncoding('utf8').on('data', take);
    child.stderr.setEncoding('utf8').on('data', take);
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.on('error', error => { take(`\n[başlatılamadı: ${error.message}]`); });
    child.on('close', code => {
      if (entry.status === 'running') { entry.status = 'exited'; entry.code = code ?? 1; }
      onChange();
    });
    onChange();

    // Waits a few seconds for the address, an early exit or the first output to settle.
    return new Promise(resolve => {
      const limit = Math.min(Math.max(Number(wait) || 6, 1), 30) * 1000;
      const began = Date.now();
      const timer = setInterval(() => {
        const settled = entry.url || entry.status !== 'running' || signal?.aborted || Date.now() - began > limit;
        if (!settled) return;
        clearInterval(timer);
        const failed = entry.status === 'exited' && entry.code !== 0;
        resolve({ entry, failed, text: `${failed ? 'Hata: süreç hemen kapandı.\n' : 'başlatıldı: '}${describe(entry, 25)}${entry.status === 'running' && !entry.url ? '\n(Henüz bir adres görünmedi. Sunucuysa process_output ile çıktısına veya check_url ile adresine bak.)' : ''}` });
      }, 200);
    });
  }

  async function stop(id) {
    const entry = entries.get(id);
    if (!entry) throw new Error(`böyle bir süreç yok: ${id}. Çalışanlar: ${running().map(item => item.id).join(', ') || 'yok'}`);
    if (entry.status === 'running') {
      entry.status = 'stopped';
      await killTree(entry.child);
      onChange();
    }
    return entry;
  }

  return {
    start,
    stop,
    output: (id, lines) => {
      const entry = entries.get(id);
      if (!entry) throw new Error(`böyle bir süreç yok: ${id}. Çalışanlar: ${running().map(item => item.id).join(', ') || 'yok'}`);
      return describe(entry, lines);
    },
    describe: id => describe(entries.get(id)),
    list: () => [...entries.values()].map(view),
    stopAll: () => Promise.all(running().map(entry => stop(entry.id))),
  };
}

// GETs an address on this computer and returns its status and the start of its body. Other hosts are refused:
// Umay should not reach the internet or the local network from here.
async function checkUrl(value, { timeout = 8000 } = {}) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`geçersiz adres: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('check_url yalnızca bu bilgisayardaki adresleri açar (localhost, 127.0.0.1)');
  }
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    const reason = error?.cause?.code === 'ECONNREFUSED' ? 'bağlantı reddedildi: bu adreste çalışan bir sunucu yok'
      : error?.name === 'TimeoutError' ? `${timeout / 1000} saniyede yanıt gelmedi` : String(error?.cause?.message ?? error?.message ?? error);
    throw new Error(`${url.href} açılamadı (${reason})`);
  }
  const type = response.headers.get('content-type') ?? '';
  const body = /text|json|javascript|xml|html/i.test(type) || !type ? (await response.text()).slice(0, 1500) : `(${type}, ${response.headers.get('content-length') ?? '?'} bayt)`;
  return `${url.href} → HTTP ${response.status} ${response.statusText} · ${type || 'tür yok'} · ${Date.now() - started} ms\n${body}`;
}

function processTools() {
  return {
    start_process: {
      description: 'Start a long-running command in the background in the project folder: a development server, a watcher, anything that does not finish by itself. Waits a few seconds and returns its id, status, the local address it printed and its first output. It keeps running after your answer; stop it with stop_process when it is no longer needed. Never use run_command for these. Requires user approval.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'Command to start' }, label: { type: 'string', description: 'Short name shown to the user, like "web sunucusu"' }, wait: { type: 'integer', description: 'Seconds to wait for the first output. Default 6, at most 30' } }, required: ['command'] },
      needsApproval: true,
      preview: ({ command }) => ({ kind: 'command', text: String(command ?? '') }),
      // The short name is "label", not "name": "name" is the tool's own name in the call format, and a second
      // "name" made every call unreadable (13 Nov 2026).
      run: async ({ command, label, wait }, { processes, signal }) => {
        if (typeof command !== 'string' || !command.trim()) throw new Error('command boş olamaz');
        return (await processes.start(command, { name: label, wait, signal })).text;
      },
    },
    process_output: {
      description: 'Show the latest output and status of a background process started with start_process.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Process id, like p1' }, lines: { type: 'integer', description: 'Number of last lines. Default 40' } }, required: ['id'] },
      run: ({ id, lines = 40 }, { processes }) => processes.output(String(id), Math.min(Math.max(Number.parseInt(lines, 10) || 40, 1), 400)),
    },
    stop_process: {
      description: 'Stop a background process started with start_process, with everything it started.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Process id, like p1' } }, required: ['id'] },
      run: async ({ id }, { processes }) => { await processes.stop(String(id)); return `durduruldu: ${processes.describe(String(id))}`; },
    },
    check_url: {
      description: 'Request a local address (http://localhost:PORT/...) and return the HTTP status and the start of the response. Use it to verify a server you started. Only addresses on this computer are allowed.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Address on this computer, like http://localhost:8080/' } }, required: ['url'] },
      run: ({ url }) => checkUrl(url),
    },
  };
}

module.exports = { createProcessManager, processTools, checkUrl, localUrl, MAX_RUNNING };
