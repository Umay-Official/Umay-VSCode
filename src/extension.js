// Umay for VS Code and the editors built on it (Cursor, Windsurf, VSCodium...): the chat in the side bar, the
// editor's right-click menu, a quick fix on every error and a status bar button.
const vscode = require('vscode');
const path = require('node:path');
const { UmayView, VIEW_ID, PROPOSAL_SCHEME } = require('./panel');
const { SECRET } = require('./keystore');

const PROMPTS = {
  explain: 'Bu kodu açıkla: ne yaptığını, nasıl çalıştığını ve dikkat edilmesi gereken noktaları anlat.',
  fix: 'Bu koddaki hataları bul ve düzelt. Düzeltmeyi dosyaya uygula ve mümkünse çalıştırarak doğrula.',
  tests: 'Bu kod için birim testleri yaz. Projedeki test yapısını ve araçlarını kullan; testleri çalıştırıp sonucu söyle.',
  document: 'Bu koda açıklama satırları ve belge yorumları (docstring, JSDoc vb.) ekle. Kodun davranışını değiştirme.',
};

let view;

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'umay.focus';
  const showState = state => {
    status.text = { busy: '$(sync~spin) Umay', approval: '$(bell-dot) Umay onay bekliyor' }[state] ?? '☾★ Umay';
    status.tooltip = { busy: 'Umay çalışıyor', approval: 'Umay bir değişiklik veya komut için onayını bekliyor' }[state] ?? 'Umay\'ı aç (Ctrl+Alt+U)';
    status.backgroundColor = state === 'approval' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  };
  showState('idle');
  status.show();

  view = new UmayView(context, { onState: showState });
  const editor = () => vscode.window.activeTextEditor;
  const ask = (text, options) => view.prompt(text, options);
  const needsEditor = run => () => {
    if (!editor()) { vscode.window.showInformationMessage('Önce bir dosya aç; istersen bir kısmını seç.'); return undefined; }
    return run();
  };

  context.subscriptions.push(
    status,
    vscode.window.registerWebviewViewProvider(VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, view),

    vscode.commands.registerCommand('umay.focus', () => view.reveal()),
    vscode.commands.registerCommand('umay.newChat', () => view.command('newChat')),
    vscode.commands.registerCommand('umay.history', () => view.command('history')),
    vscode.commands.registerCommand('umay.setKey', () => view.command('key')),
    vscode.commands.registerCommand('umay.undo', async () => vscode.window.showInformationMessage(view.undo())),
    vscode.commands.registerCommand('umay.ask', async () => {
      const text = await vscode.window.showInputBox({ title: 'Umay\'a sor', prompt: editor() ? 'Açık dosya ve seçili kod mesaja eklenir.' : undefined, placeHolder: 'Ör. Bu fonksiyon neden yavaş?', ignoreFocusOut: true });
      if (text?.trim()) await ask(text.trim());
    }),
    vscode.commands.registerCommand('umay.explain', needsEditor(() => ask(PROMPTS.explain, { whole: editor().selection.isEmpty }))),
    vscode.commands.registerCommand('umay.fix', needsEditor(() => ask(PROMPTS.fix))),
    vscode.commands.registerCommand('umay.tests', needsEditor(() => ask(PROMPTS.tests))),
    vscode.commands.registerCommand('umay.document', needsEditor(() => ask(PROMPTS.document))),
    vscode.commands.registerCommand('umay.fixDiagnostic', fixDiagnostic),

    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, { provideCodeActions }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),

    vscode.window.onDidChangeActiveTextEditor(() => view.pushEditor()),
    vscode.window.onDidChangeTextEditorSelection(event => { if (event.textEditor === editor()) view.pushEditor(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => view.pushEditor()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => view.pushEditor()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('umay.baseUrl')) view.models = null;
      if (event.affectsConfiguration('umay.includeActiveFile')) view.pushEditor();
    }),
    context.secrets.onDidChange(event => { if (event.key === SECRET) view.keyChanged(); }),
    { dispose: () => view.stopEverything() },
  );

  // Right after installing, Umay opens itself once: the key screen is the first thing to see.
  if (!context.globalState.get('umay.welcomed')) {
    context.globalState.update('umay.welcomed', true);
    setTimeout(() => view.reveal(), 800);
  }
  return { view };
}

// "Umay ile düzelt" in the light bulb menu of every error and warning.
function provideCodeActions(document, range, context) {
  const problems = context.diagnostics.filter(item => item.severity <= vscode.DiagnosticSeverity.Warning);
  if (!problems.length) return [];
  const problem = problems[0];
  const action = new vscode.CodeAction('☾★ Umay ile düzelt', vscode.CodeActionKind.QuickFix);
  action.command = { command: 'umay.fixDiagnostic', title: 'Umay ile düzelt', arguments: [document.uri, problem.range, problem.message, problem.source, codeOf(problem)] };
  return [action];
}

const codeOf = problem => (typeof problem.code === 'object' && problem.code ? String(problem.code.value) : problem.code === undefined ? undefined : String(problem.code));

async function fixDiagnostic(uri, range, message, source, code) {
  if (!uri || !range?.start || !range?.end) return;
  // The arguments may come back from the editor as plain objects.
  const target = uri instanceof vscode.Uri ? uri : vscode.Uri.from(uri);
  range = new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
  const document = await vscode.workspace.openTextDocument(target);
  const editor = await vscode.window.showTextDocument(document, { preserveFocus: true });
  // The lines around the problem, so Umay sees it without a read first.
  const from = Math.max(0, range.start.line - 8);
  const to = Math.min(document.lineCount - 1, range.end.line + 8);
  const around = new vscode.Range(from, 0, to, document.lineAt(to).text.length);
  const where = `${path.basename(document.fileName)} satır ${range.start.line + 1}`;
  const origin = [source, code].filter(Boolean).join(' ');
  await view.prompt(`Şu hatayı düzelt (${where}): ${String(message)}${origin ? ` [${origin}]` : ''}\nDüzeltmeyi dosyaya uygula ve mümkünse doğrula.`, { editor, range: around });
}

function deactivate() {
  return view?.stopEverything();
}

module.exports = { activate, deactivate };
