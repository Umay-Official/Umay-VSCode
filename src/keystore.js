// The Umay API key. It is kept in the editor's secret storage (the operating system's credential store:
// Windows Credential Manager, macOS Keychain, libsecret on Linux) and never reaches the webview.
// UMAY_API_KEY in the environment is used when no key was saved, as in Umay CLI.
// A key Umay CLI already saved on this computer can be taken over with one click, so a CLI user types nothing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SECRET = 'umay.apiKey';

function createKeyStore(secrets, env = process.env) {
  let cached;
  return {
    // { key, source: 'saved' | 'env' } or null.
    async load() {
      if (cached === undefined) cached = (await secrets.get(SECRET))?.trim() || null;
      if (cached) return { key: cached, source: 'saved' };
      const fromEnv = String(env.UMAY_API_KEY ?? '').trim();
      return fromEnv ? { key: fromEnv, source: 'env' } : null;
    },
    async save(key) {
      key = String(key ?? '').trim();
      if (!key) throw new Error('Anahtar boş olamaz.');
      if (/\s/.test(key)) throw new Error('Anahtar boşluk içeremez.');
      await secrets.store(SECRET, key);
      cached = key;
    },
    async remove() {
      await secrets.delete(SECRET);
      cached = null;
    },
    // Another window changed the key.
    forget() { cached = undefined; },
  };
}

// ---------- Umay CLI's key ----------

const cliDir = () => path.dirname(process.env.UMAY_SETTINGS || path.join(os.homedir(), '.umay', 'ayarlar.json'));

function run(file, args, input = '') {
  return new Promise(resolve => {
    const child = execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Whether Umay CLI saved a key, without reading it (reading may ask the user on macOS).
async function hasCliKey() {
  if (process.platform === 'darwin') return (await run('security', ['find-generic-password', '-s', 'umay-cli', '-a', 'umay-cli'])) !== null;
  return fs.existsSync(path.join(cliDir(), process.platform === 'win32' ? 'anahtar.dpapi' : 'anahtar'));
}

// The key Umay CLI keeps for this user, or null. Windows: DPAPI with the entropy "umay-cli" (the key travels
// through stdin, never on a command line). macOS: the login keychain. Elsewhere: a file only the owner reads.
async function readCliKey() {
  if (process.platform === 'darwin') return run('security', ['find-generic-password', '-s', 'umay-cli', '-a', 'umay-cli', '-w']);
  if (process.platform !== 'win32') {
    try { return fs.readFileSync(path.join(cliDir(), 'anahtar'), 'utf8').trim() || null; } catch { return null; }
  }
  const file = path.join(cliDir(), 'anahtar.dpapi');
  if (!fs.existsSync(file)) return null;
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $e=New-Object Text.UTF8Encoding $false; "
    + "[Console]::OutputEncoding=$e; $in=[Console]::In.ReadToEnd(); $x=$e.GetBytes('umay-cli'); "
    + "[Console]::Out.Write($e.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in.Trim()), $x, 'CurrentUser')))";
  return run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    fs.readFileSync(file, 'utf8'));
}

module.exports = { createKeyStore, hasCliKey, readCliKey, SECRET };
