// Runs test/vscode/suite.js inside a real VS Code with the extension loaded from this folder, in a fresh profile
// and a temporary project folder. VSCODE_PATH points at an installed Code.exe; without it the current stable
// VS Code is downloaded (as in CI).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'umay-vscode-'));
  const project = path.join(scratch, 'proje');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'a.txt'), 'eski\n');
  fs.writeFileSync(path.join(project, 'hesap.js'), 'function topla(a, b) {\n  return a - b;\n}\nmodule.exports = { topla };\n');
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_PATH || undefined,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [project, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', path.join(scratch, 'profil'), '--extensions-dir', path.join(scratch, 'eklentiler')],
      extensionTestsEnv: { UMAY_API_KEY: 'umay-sk-test', UMAY_TEST_PROJECT: project },
    });
  } finally {
    // VS Code may still hold its profile for a moment after closing.
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left in the temp folder */ }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
