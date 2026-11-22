// The chat in the side bar. The webview (media/chat.js) draws the conversation; this half, in the extension
// host, holds the key, runs Umay's turns with the project's tools and answers the webview's requests.
// Messages from the webview are untrusted input: every path, address and command name is checked here.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const umay = require('./umay');
const { runTurn } = require('./agent');
const { createToolbox, ToolError } = require('./tools');
const { createChatStore } = require('./chats');
const { createKeyStore, hasCliKey, readCliKey } = require('./keystore');
const { editorContext, describeEditor, inside } = require('./context');

const VIEW_ID = 'umay.chat';
const PROPOSAL_SCHEME = 'umay-oneri';
const KEY_PAGE = 'https://umayzeka.com';
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file']);
const COMMAND_TOOLS = new Set(['run_command', 'run_python', 'start_process']);
const LABELS = { write_file: 'Yaz', edit_file: 'Düzenle', append_file: 'Ekle', run_command: 'Komut', run_python: 'Python', start_process: 'Süreç başlat' };
const THINKING = { on: true, off: false };
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const config = () => vscode.workspace.getConfiguration('umay');
const samePath = file => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

class UmayView {
  constructor(context, { onState = () => {} } = {}) {
    this.context = context;
    this.onState = onState;
    this.view = undefined;
    this.ready = false;
    // Prompts and commands that arrive before the webview has loaded wait here.
    this.outbox = [];
    this.chats = createChatStore({ dir: context.globalStorageUri.fsPath });
    this.keys = createKeyStore(context.secrets);
    this.toolboxes = new Map();
    this.running = new Map();
    this.approvals = new Map();
    this.proposals = new Map();
    this.alwaysByChat = new Map();
    this.models = null;
    this.editorTimer = undefined;
  }

  // ---------- Webview ----------

  resolveWebviewView(view) {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage(message => {
      this.receive(message).catch(error => console.error('[Umay]', error));
    });
    view.onDidDispose(() => {
      if (this.view !== view) return;
      this.view = undefined;
      this.ready = false;
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.pushEditor(); });
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const src = file => webview.asWebviewUri(vscode.Uri.joinPath(media, file));
    const csp = webview.cspSource;
    return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; style-src ${csp}; font-src ${csp}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${src('vendor/codicon.css')}">
<link rel="stylesheet" href="${src('chat.css')}">
<title>Umay</title>
</head>
<body>
<section class="key-view" id="key-view" hidden>
  <div class="card">
    <img src="${src('icon.png')}" alt="" width="56" height="56">
    <h2>Umay'a hoş geldin</h2>
    <p class="muted">Başlamak için Umay API anahtarını gir. Anahtar bu bilgisayarın güvenli kasasında saklanır ve bir daha sorulmaz.</p>
    <button class="secondary wide" id="key-cli" type="button" hidden><i class="codicon codicon-terminal"></i> Umay CLI'deki anahtarı kullan</button>
    <form id="key-form" autocomplete="off">
      <input id="key-input" type="password" placeholder="umay-sk-..." spellcheck="false" aria-label="Umay API anahtarı">
      <button class="primary" id="key-save" type="submit">Kaydet</button>
    </form>
    <p class="key-message" id="key-message" role="status"></p>
    <p class="muted small-text">Anahtarın yok mu? <a href="#" id="key-get">umayzeka.com</a> → Geliştirici &amp; API Paneli → Yeni Anahtar Oluştur.</p>
    <div class="key-actions" id="key-actions" hidden>
      <button class="link" id="key-delete" type="button">Kayıtlı anahtarı sil</button>
      <button class="link" id="key-close" type="button">Kapat</button>
    </div>
  </div>
</section>

<section class="history-view" id="history-view" hidden>
  <div class="history-head">
    <button class="link" id="history-back" type="button"><i class="codicon codicon-arrow-left"></i> Sohbete dön</button>
    <button class="secondary small" id="history-new" type="button"><i class="codicon codicon-add"></i> Yeni</button>
  </div>
  <div class="history-list" id="history-list"></div>
</section>

<section class="chat-view" id="chat-view">
  <div class="messages" id="messages">
    <div class="empty" id="empty">
      <img class="logo" src="${src('icon.png')}" alt="" width="64" height="64">
      <h1>Umay</h1>
      <p class="lead">Türkiye'nin yapay zekası, editörünün içinde.</p>
      <div class="ideas" id="ideas"></div>
      <p class="hint" id="hint"></p>
    </div>
  </div>
  <div class="procs" id="procs" hidden></div>
  <form class="composer" id="composer">
    <div class="context-row">
      <button class="ctx-chip" id="ctx-chip" type="button" hidden><i class="codicon codicon-file-code"></i><span id="ctx-label"></span></button>
    </div>
    <textarea id="input" rows="1" placeholder="Umay'a yaz…" aria-label="Mesaj"></textarea>
    <div class="composer-bar">
      <select id="model" aria-label="Model" title="Model"></select>
      <select id="thinking" aria-label="Düşünme" title="Düşünme: açık en iyi sonucu verir, kapalı hızlıdır, otomatikte Umay karar verir">
        <option value="auto">Düşünme: oto</option>
        <option value="on">Düşünme: açık</option>
        <option value="off">Düşünme: kapalı</option>
      </select>
      <span class="grow"></span>
      <button class="send" id="send" type="submit" title="Gönder (Enter)" aria-label="Gönder"><i class="codicon codicon-send"></i></button>
    </div>
  </form>
</section>
<script nonce="${nonce}" src="${src('vendor/marked.umd.js')}"></script>
<script nonce="${nonce}" src="${src('vendor/purify.min.js')}"></script>
<script nonce="${nonce}" src="${src('chat.js')}"></script>
</body>
</html>`;
  }

  // Messages for a running turn are dropped while the webview is gone; prompts and commands wait for it.
  post(message) {
    if (this.view && this.ready) { this.view.webview.postMessage(message); return; }
    if (message.type === 'prompt' || message.type === 'command') this.outbox.push(message);
  }

  async reveal() {
    try { await vscode.commands.executeCommand(`${VIEW_ID}.focus`); } catch { /* the view is gone */ }
  }

  // ---------- Requests from the webview ----------

  async receive(message) {
    if (!message || typeof message.type !== 'string') return;
    const reply = result => this.view?.webview.postMessage({ type: 'reply', reqId: message.reqId, result });
    switch (message.type) {
      case 'ready':
        this.ready = true;
        await this.sendInit();
        for (const waiting of this.outbox.splice(0)) this.post(waiting);
        return;
      case 'send': return this.send(message);
      case 'stop': this.running.get(String(message.id))?.controller.abort(); return;
      case 'approve': return this.answer(String(message.id), String(message.callId), message.verdict);
      case 'openDiff': return this.openDiff(String(message.id), String(message.callId));
      case 'openFile': return this.openFile(message.path, message.folder);
      case 'insertCode': return this.insertCode(String(message.code ?? ''), message.language);
      case 'copy': await vscode.env.clipboard.writeText(String(message.text ?? '')); return;
      case 'undo': return reply(this.undo(message.folder));
      case 'loadChat': return reply(this.chats.list().find(chat => chat.id === message.id) ?? null);
      case 'saveChat':
        try { this.chats.save(message.chat); } catch (error) { console.error('[Umay] sohbet kaydedilemedi', error); }
        return reply(this.summaries());
      case 'deleteChat': this.chats.remove(String(message.id)); return reply(this.summaries());
      case 'keyStatus': return reply(await this.keyStatus());
      case 'saveKey': return reply(await this.saveKey(message.key));
      case 'importCliKey': return reply(await this.importCliKey());
      case 'deleteKey': await this.keys.remove(); return reply(await this.keyStatus());
      case 'setPref':
        if (['model', 'thinking'].includes(message.name)) await this.context.globalState.update(`umay.${message.name}`, String(message.value));
        return;
      case 'stopProcess': return this.stopProcess(message.folder, message.id);
      case 'openUrl': return this.openLocal(message.url);
      case 'getKey': vscode.env.openExternal(vscode.Uri.parse(KEY_PAGE)); return;
      case 'run': return this.runCommand(message.name);
      default:
    }
  }

  async sendInit() {
    const prefs = {
      model: this.context.globalState.get('umay.model', umay.DEFAULT_MODEL),
      thinking: this.context.globalState.get('umay.thinking', 'auto'),
    };
    this.post({
      type: 'init', prefs, modelNames: umay.MODEL_NAMES, models: await this.loadModels(), key: await this.keyStatus(),
      chats: this.summaries(), workspace: this.workspaceInfo(), editor: this.editorInfo(), processes: this.allProcesses(),
      app: vscode.env.appName,
    });
  }

  async loadModels() {
    if (!this.models) {
      let baseURL = umay.BASE_URL;
      try { baseURL = umay.checkBaseURL(config().get('baseUrl')); } catch { /* the default list */ }
      this.models = await umay.listModels({ baseURL });
    }
    return this.models;
  }

  summaries() {
    return this.chats.list().map(({ id, title, updated, folder }) => ({ id, title, updated, folder }));
  }

  // ---------- Key ----------

  async keyStatus() {
    const stored = await this.keys.load();
    return { saved: stored?.source === 'saved', env: stored?.source === 'env', cli: stored?.source !== 'saved' && await hasCliKey() };
  }

  baseURL() {
    return umay.checkBaseURL(config().get('baseUrl'));
  }

  async saveKey(key) {
    key = String(key ?? '').trim();
    if (!key) return { ok: false, message: 'Anahtar boş olamaz.' };
    try {
      const accepted = await umay.verifyKey(key, { baseURL: this.baseURL() });
      if (accepted === false) return { ok: false, message: 'Umay bu anahtarı kabul etmedi. Panelden kopyalayıp tekrar yapıştır.' };
      await this.keys.save(key);
      return { ok: true, checked: accepted === true, status: await this.keyStatus() };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  async importCliKey() {
    const key = await readCliKey();
    if (!key) return { ok: false, message: 'Umay CLI\'nin kayıtlı anahtarı okunamadı.' };
    try {
      if ((await umay.verifyKey(key, { baseURL: this.baseURL() })) === false) return { ok: false, message: 'Umay CLI\'deki anahtar artık kabul edilmiyor. Yeni bir anahtar gir.' };
      await this.keys.save(key);
      return { ok: true, status: await this.keyStatus() };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  async keyChanged() {
    this.keys.forget();
    this.post({ type: 'key', key: await this.keyStatus() });
  }

  // ---------- Workspace and editor ----------

  // The folder the tools work in: the one holding the active file, else the first folder of the window.
  folder() {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(item => item.uri.scheme === 'file');
    const active = vscode.window.activeTextEditor?.document.uri;
    const owner = active && vscode.workspace.getWorkspaceFolder(active);
    return (owner?.uri.scheme === 'file' ? owner : folders[0])?.uri.fsPath ?? null;
  }

  workspaceInfo() {
    const folder = this.folder();
    return { hasFolder: Boolean(folder), name: folder ? path.basename(folder) : null, path: folder, trusted: vscode.workspace.isTrusted };
  }

  editorInfo() {
    if (!config().get('includeActiveFile', true)) return null;
    return describeEditor(vscode.window.activeTextEditor, this.folder());
  }

  // The chip above the message box follows the active file and selection, a few times a second at most.
  pushEditor() {
    clearTimeout(this.editorTimer);
    this.editorTimer = setTimeout(() => this.post({ type: 'editor', editor: this.editorInfo(), workspace: this.workspaceInfo() }), 150);
  }

  // ---------- A turn ----------

  async send({ id, chatId, text, model, thinking, useContext, preset, history }) {
    id = String(id);
    chatId = String(chatId);
    const emit = event => this.forward(id, event);
    const stored = await this.keys.load();
    if (!stored) { emit({ type: 'error', message: 'Önce Umay API anahtarını gir.' }); return; }
    let baseURL;
    try { baseURL = this.baseURL(); } catch (error) { emit({ type: 'error', message: error.message }); return; }
    if (this.running.size) { emit({ type: 'error', message: 'Umay başka bir yanıt üzerinde çalışıyor. Bitmesini bekle veya durdur.' }); return; }

    // Umay should see what is on screen, not an older copy on disk.
    if (config().get('saveBeforeSend', true)) { try { await vscode.workspace.saveAll(false); } catch { /* not important */ } }
    const folder = this.folder();
    let toolbox = null;
    if (folder && vscode.workspace.isTrusted) {
      try { toolbox = this.toolboxFor(folder); } catch (error) { emit({ type: 'error', message: error.message }); return; }
    }
    let added = null;
    if (preset && typeof preset.text === 'string') added = { text: preset.text.slice(0, 40_000), label: String(preset.label ?? '') };
    else if (useContext && config().get('includeActiveFile', true)) added = editorContext(vscode.window.activeTextEditor, { root: folder, tools: Boolean(toolbox) });
    if (added) emit({ type: 'context', context: added.text, label: added.label });

    const user = { role: 'user', content: added ? `${String(text)}\n\n${added.text}` : String(text) };
    const controller = new AbortController();
    this.running.set(id, { controller, chatId });
    this.state();
    try {
      const result = await runTurn({
        apiKey: stored.key, baseURL, model: typeof model === 'string' && model ? model : umay.DEFAULT_MODEL,
        thinking: THINKING[thinking] ?? null, toolbox, signal: controller.signal, always: this.alwaysFor(chatId),
        system: this.systemPrompt(toolbox), history: [...cleanHistory(history), user], emit,
        approve: ({ callId }) => new Promise(resolve => {
          this.approvals.set(`${id}:${callId}`, resolve);
          controller.signal.addEventListener('abort', () => resolve('no'), { once: true });
          this.state();
        }),
      });
      emit({ type: 'done', model: result.model, seconds: result.seconds, transcript: result.transcript });
    } catch (error) {
      if (controller.signal.aborted) emit({ type: 'stopped', transcript: error.transcript, seconds: error.seconds });
      else emit({ type: 'error', message: error.message, transcript: error.transcript });
    } finally {
      this.running.delete(id);
      for (const key of [...this.approvals.keys()]) if (key.startsWith(`${id}:`)) this.approvals.delete(key);
      for (const key of [...this.proposals.keys()]) {
        if (!key.startsWith(`${id}:`)) continue;
        this.proposals.delete(key);
        this.closeDiffs(key);
      }
      this.state();
    }
  }

  // Each turn event goes to the webview. An approval keeps the proposed file content here (for the side-by-side
  // diff) and sends only the short diff; when the view is not on screen, a notification asks the user to look.
  forward(id, event) {
    if (event.type === 'tool' && event.status === 'approval') {
      if (event.preview && event.preview.after !== undefined) {
        const { after, ...rest } = event.preview;
        this.proposals.set(`${id}:${event.callId}`, { file: rest.file, after, isNew: Boolean(rest.isNew) });
        event = { ...event, preview: { ...rest, canDiff: true } };
      }
      if (!this.view?.visible) {
        const what = `${LABELS[event.name] ?? event.name}${event.args?.path ? `: ${event.args.path}` : event.args?.command ? `: ${String(event.args.command).split('\n')[0].slice(0, 60)}` : ''}`;
        vscode.window.showInformationMessage(`Umay onayını bekliyor (${what})`, 'Göster').then(choice => { if (choice) this.reveal(); });
      }
    }
    this.post({ type: 'event', id, event });
  }

  answer(id, callId, verdict) {
    const key = `${id}:${callId}`;
    const resolve = this.approvals.get(key);
    this.approvals.delete(key);
    resolve?.(['yes', 'no', 'always'].includes(verdict) ? verdict : 'no');
    this.state();
    this.closeDiffs(key);
  }

  // Once answered, the side-by-side view of that proposal has done its job.
  closeDiffs(key) {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => tab.input?.modified?.scheme === PROPOSAL_SCHEME && (key === undefined || tab.input.modified.query === key));
    if (tabs.length) vscode.window.tabGroups.close(tabs).then(undefined, () => {});
  }

  state() {
    this.onState(this.approvals.size ? 'approval' : this.running.size ? 'busy' : 'idle');
  }

  // "Always" answers last for the conversation; the settings can approve writes or commands everywhere.
  alwaysFor(chatId) {
    if (!this.alwaysByChat.has(chatId)) this.alwaysByChat.set(chatId, new Set());
    const chosen = this.alwaysByChat.get(chatId);
    return {
      has: name => chosen.has(name)
        || (WRITE_TOOLS.has(name) && config().get('autoApprove.writes', false) === true)
        || (COMMAND_TOOLS.has(name) && config().get('autoApprove.commands', false) === true),
      add: name => chosen.add(name),
    };
  }

  systemPrompt(toolbox) {
    const today = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    let text = `Sen Umay'sın: Türkiye'nin bağımsız yapay zeka asistanı. ${vscode.env.appName} editörünün içinde, Umay eklentisinde çalışıyorsun; çoğunlukla yazılımcılarla konuşuyorsun. Kullanıcının dilinde açık, doğru ve anlaşılır yanıt ver; kod bloklarında dili belirt; uygun olduğunda Markdown başlıkları, maddeler ve tablolar kullan.
Kullanıcının mesajının sonunda "[Editör bağlamı]" bölümü olabilir: o an editörde açık olan dosyayı, imlecin satırını ve seçili kodu gösterir. "Bu kod", "bu fonksiyon", "buradaki hata" gibi ifadeler oraya işaret eder. Bugünün tarihi: ${today}.`;
    if (!toolbox) {
      text += vscode.workspace.isTrusted
        ? '\nŞu an dosya araçların yok, çünkü editörde açık bir klasör yok: dosya okuyamaz, yazamaz, komut çalıştıramazsın. Kodu kod bloğu olarak ver; kullanıcı bloğun üstündeki "Ekle" düğmesiyle kodu editöre ekleyebilir. Araçlar için kullanıcı bir klasör açmalı.'
        : '\nKullanıcı bu klasöre henüz güvenmediği için dosya araçların kapalı: dosya okuyamaz, yazamaz, komut çalıştıramazsın. Kodu kod bloğu olarak ver. Araçlar için kullanıcı klasöre güvenmeli (Workspace Trust).';
    }
    return text;
  }

  // ---------- Tools ----------

  toolboxFor(folder) {
    const key = samePath(folder);
    if (!this.toolboxes.has(key)) {
      this.toolboxes.set(key, createToolbox(folder, {
        onProcessChange: () => this.post({ type: 'processes', processes: this.allProcesses() }),
        guard: file => this.guard(file),
      }));
    }
    return this.toolboxes.get(key);
  }

  // A file with unsaved changes in the editor is not overwritten: the user's typing would be lost.
  guard(file) {
    const target = samePath(file);
    const document = vscode.workspace.textDocuments.find(item => item.uri.scheme === 'file' && samePath(item.uri.fsPath) === target);
    if (document?.isDirty) {
      throw new ToolError(`${path.basename(file)} editörde kaydedilmemiş değişiklikler içeriyor, üzerine yazılmadı. Kullanıcıdan dosyayı kaydetmesini (Ctrl+S) iste, sonra tekrar dene.`);
    }
  }

  undo(folder) {
    const target = typeof folder === 'string' && folder ? folder : this.folder();
    if (!target) return 'Geri alınacak bir değişiklik yok.';
    const toolbox = this.toolboxes.get(samePath(target));
    return toolbox?.undoLast() ?? 'Geri alınacak bir değişiklik yok.';
  }

  allProcesses() {
    return [...this.toolboxes.values()].flatMap(toolbox => toolbox.processes.list());
  }

  async stopProcess(folder, id) {
    const toolbox = typeof folder === 'string' ? this.toolboxes.get(samePath(folder)) : null;
    try { await toolbox?.processes.stop(String(id)); } catch { /* already gone */ }
  }

  stopEverything() {
    for (const { controller } of this.running.values()) controller.abort();
    return Promise.all([...this.toolboxes.values()].map(toolbox => toolbox.processes.stopAll()));
  }

  // ---------- Editor actions ----------

  // The side-by-side diff of a proposed change: the file on disk on the left, Umay's version on the right.
  async openDiff(id, callId) {
    const key = `${id}:${callId}`;
    const proposal = this.proposals.get(key);
    if (!proposal) { vscode.window.showInformationMessage('Bu önerinin farkı artık açılamıyor.'); return; }
    const filePath = vscode.Uri.file(proposal.file).path;
    const right = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: filePath, query: key });
    const left = proposal.isNew || !fs.existsSync(proposal.file) ? vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: filePath, query: 'bos' }) : vscode.Uri.file(proposal.file);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(proposal.file)} ↔ Umay'ın önerisi`, { preview: true });
  }

  // For the diff editor (registered under PROPOSAL_SCHEME).
  provideTextDocumentContent(uri) {
    if (uri.query === 'bos') return '';
    return this.proposals.get(uri.query)?.after ?? '(Bu öneri artık yok: onaylandı, reddedildi veya yanıt durduruldu.)';
  }

  async openFile(file, folder) {
    if (typeof file !== 'string' || !file.trim()) return;
    const root = typeof folder === 'string' && folder ? folder : this.folder();
    const target = path.resolve(root ?? '', file.trim());
    // Only files inside a folder the user opened, or the conversation's folder.
    const roots = [root, ...(vscode.workspace.workspaceFolders ?? []).map(item => item.uri.fsPath)].filter(Boolean);
    if (!roots.some(item => inside(item, target)) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  // "Ekle" on a code block: replaces the selection or goes in at the cursor; with no editor, a new file.
  async insertCode(code, language) {
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find(item => item.document.uri.scheme === 'file' || item.document.isUntitled);
    if (editor) {
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      await editor.edit(builder => builder.replace(editor.selection, code));
      return;
    }
    let document;
    try { document = await vscode.workspace.openTextDocument({ content: code, language: typeof language === 'string' ? language : undefined }); }
    catch { document = await vscode.workspace.openTextDocument({ content: code }); }
    await vscode.window.showTextDocument(document);
  }

  openLocal(url) {
    try {
      const target = new URL(String(url));
      if (!['http:', 'https:'].includes(target.protocol) || !LOCAL_HOSTS.has(target.hostname)) return;
      vscode.env.openExternal(vscode.Uri.parse(target.href));
    } catch { /* not an address */ }
  }

  runCommand(name) {
    const commands = {
      openFolder: ['vscode.openFolder'],
      trust: ['workbench.trust.manage'],
      settings: ['workbench.action.openSettings', `@ext:${this.context.extension?.id ?? 'umay-official.umay'}`],
    };
    if (Object.hasOwn(commands, name)) vscode.commands.executeCommand(...commands[name]);
  }

  // ---------- From the editor's commands ----------

  // Sends `text` as a new message with the editor's file and selection (or a diagnostic's lines) attached.
  async prompt(text, { editor = vscode.window.activeTextEditor, range, whole = false } = {}) {
    const folder = this.folder();
    const preset = editorContext(editor, { root: folder, tools: Boolean(folder && vscode.workspace.isTrusted), range, whole });
    await this.reveal();
    this.post({ type: 'prompt', text, preset });
  }

  async command(name) {
    await this.reveal();
    this.post({ type: 'command', name });
  }
}

// History from the webview: only user and assistant messages with text are passed on.
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
    .map(({ role, content }) => ({ role, content }));
}

module.exports = { UmayView, VIEW_ID, PROPOSAL_SCHEME, cleanHistory };
