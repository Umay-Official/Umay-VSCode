// The chat webview, from Umay Code's renderer: messages with Markdown, a fold-out thought, tool cards with
// approval buttons, the conversation history and the key screen. Anything that needs the key, the files or the
// editor goes to the extension (src/panel.js) through postMessage; this page never sees the key.
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const post = (type, data = {}) => vscode.postMessage({ type, ...data });
  let sequence = 0;
  const waiting = new Map();
  // A request the extension answers with { type: 'reply', reqId, result }.
  const ask = (type, data = {}) => new Promise(resolve => {
    const reqId = ++sequence;
    waiting.set(reqId, resolve);
    post(type, { ...data, reqId });
  });
  const state = () => vscode.getState() ?? {};
  const remember = patch => vscode.setState({ ...state(), ...patch });

  const messagesEl = $('messages');
  const emptyEl = $('empty');
  const input = $('input');
  const sendButton = $('send');
  const modelSelect = $('model');
  const thinkingSelect = $('thinking');
  const contextChip = $('ctx-chip');

  const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const seconds = value => `${value.toFixed(1).replace('.', ',')} sn`;
  const size = chars => (chars < 1024 ? `${chars} karakter` : `${(chars / 1024).toFixed(1).replace('.', ',')} KB`);
  const baseName = folder => folder?.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const sameFolder = (a, b) => Boolean(a && b) && a.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() === b.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  // The folder followed by a separator, whichever slash and letter case a path uses.
  const folderPattern = folder => new RegExp(`${folder.split(/[\\/]+/).filter(Boolean).map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]')}[\\\\/]`, 'gi');
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = name => el('i', `codicon codicon-${name}`);
  const button = (className, content, title, onClick) => {
    const node = el('button', className);
    node.type = 'button';
    if (title) node.title = title;
    node.append(...[].concat(content).map(part => (typeof part === 'string' ? document.createTextNode(part) : part)));
    node.addEventListener('click', onClick);
    return node;
  };

  let chats = [];
  let current = { id: newId(), title: 'Yeni sohbet', messages: [] };
  let busy = null;
  let modelNames = {};
  let workspace = { hasFolder: false, trusted: true };
  let editorInfo = null;
  let useContext = true;
  let keyState = { saved: false };

  // ---------- Markdown ----------

  marked.use({ gfm: true, breaks: false });
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  });

  function markdown(target, text) {
    target.innerHTML = DOMPurify.sanitize(marked.parse(text ?? ''), { FORBID_TAGS: ['style', 'img', 'form', 'input'], FORBID_ATTR: ['style'] });
    for (const pre of target.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      const language = /language-([\w+#.-]+)/.exec(code?.className ?? '')?.[1];
      const head = el('div', 'code-head');
      const copy = button('icon-button', icon('copy'), 'Kopyala', () => copyText(code?.textContent ?? '', copy));
      const insert = button('icon-button', icon('insert'), 'Editöre ekle (seçili kodun yerine veya imlecin olduğu yere)', () => post('insertCode', { code: code?.textContent ?? '', language }));
      head.append(el('span', 'code-lang', language ?? 'kod'), el('span', 'grow'), insert, copy);
      const wrap = el('div', 'code');
      pre.before(wrap);
      wrap.append(head, pre);
    }
  }

  function copyText(text, node) {
    post('copy', { text });
    node.classList.add('done');
    setTimeout(() => node.classList.remove('done'), 1200);
  }

  // ---------- Tool cards ----------

  const LABELS = { read_file: 'Oku', list_dir: 'Listele', search_files: 'Ara', write_file: 'Yaz', append_file: 'Ekle', edit_file: 'Düzenle', run_command: 'Komut', run_python: 'Python',
    start_process: 'Başlat', process_output: 'Süreç çıktısı', stop_process: 'Süreci durdur', check_url: 'Adresi kontrol et' };
  const FILE_TOOLS = new Set(['read_file', 'write_file', 'append_file', 'edit_file']);
  function summary(part) {
    const { name, args = {} } = part;
    if (name === 'run_command' || name === 'start_process') return String(args.command ?? '').split('\n')[0];
    if (name === 'check_url') return String(args.url ?? '');
    if (name === 'process_output' || name === 'stop_process') return String(args.id ?? '');
    if (name === 'run_python') return `${String(args.code ?? '').split('\n').length} satır kod`;
    if (name === 'search_files') return `"${args.pattern ?? ''}"${args.path && args.path !== '.' ? ` · ${args.path}` : ''}`;
    if (name === 'list_dir') return `${args.path ?? '.'}${args.pattern && args.pattern !== '*' ? ` · ${args.pattern}` : ''}${args.recursive ? ' · alt klasörler' : ''}`;
    return String(args.path ?? '');
  }

  function previewView(preview) {
    const box = el('div', 'preview');
    if (!preview) return box;
    if (preview.warning) box.append(el('div', 'preview-warning', preview.warning));
    const pre = el('pre');
    if (preview.kind === 'diff') {
      for (const line of preview.text.split('\n')) {
        if (/^(---|\+\+\+) [ab]\//.test(line)) continue;
        const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+++') ? 'file' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
        pre.append(el('span', `line ${kind}`, `${line}\n`));
      }
    } else pre.textContent = preview.kind === 'command' ? `> ${preview.text}` : preview.text;
    box.append(pre);
    return box;
  }

  function toolCard(part, requestId, folder) {
    const card = el('div', `tool ${part.status}${part.status === 'done' ? (part.ok ? ' ok' : ' fail') : ''}`);
    const head = el('div', 'tool-head');
    const mark = { running: 'loading', approval: 'question', done: part.ok ? 'check' : 'close' }[part.status] ?? 'circle-small';
    const what = summary(part);
    // A file the tool touched opens in the editor.
    const arg = FILE_TOOLS.has(part.name) && part.args?.path
      ? button('link tool-arg', what, 'Editörde aç', () => post('openFile', { path: part.args.path, folder }))
      : el('span', 'tool-arg', what);
    head.append(icon(mark), el('strong', '', LABELS[part.name] ?? part.name), arg);
    card.append(head);
    if (part.status === 'approval') {
      card.append(previewView(part.preview));
      const actions = el('div', 'tool-actions');
      const answer = verdict => () => {
        for (const node of actions.querySelectorAll('button')) node.disabled = true;
        post('approve', { id: requestId, callId: part.callId, verdict });
      };
      actions.append(
        button('primary small', [icon('check'), ' Onayla'], 'Bu işlemi yap', answer('yes')),
        button('secondary small', 'Reddet', 'Bu işlemi yapma', answer('no')),
      );
      if (part.preview?.canDiff) actions.append(button('link', [icon('diff'), ' Farkı aç'], 'Değişikliği editörde yan yana göster', () => post('openDiff', { id: requestId, callId: part.callId })));
      actions.append(el('span', 'grow'), button('link', 'Hep onayla', 'Bu sohbette bu araç için bir daha sorma', answer('always')));
      card.append(actions);
      if (!requestId) for (const node of actions.querySelectorAll('button')) node.disabled = true;
    } else if (part.status === 'done' && part.result) {
      const details = el('details', 'tool-result');
      // Paths in results are absolute; inside the project folder its own name is enough.
      const short = folder ? part.result.replace(folderPattern(folder), '') : part.result;
      details.append(el('summary', '', short.split('\n')[0].slice(0, 160)), el('pre', '', part.result));
      card.append(details);
    }
    return card;
  }

  // ---------- Messages ----------

  function userView(message) {
    const box = el('article', 'message user');
    const bubble = el('div', 'bubble');
    const draw = () => {
      bubble.replaceChildren(el('div', 'bubble-text', message.content));
      if (message.contextLabel) {
        const chip = el('div', 'bubble-context');
        chip.title = 'Editörden mesaja eklenen bağlam';
        chip.append(icon('file-code'), el('span', '', message.contextLabel));
        bubble.append(chip);
      }
    };
    draw();
    box.append(bubble);
    return { box, update: draw };
  }

  function messageView(message, requestId, folder) {
    if (message.role === 'user') return userView(message);
    const box = el('article', 'message assistant');
    const thought = el('details', 'thought');
    const thoughtTitle = el('summary');
    const thoughtText = el('div', 'thought-text');
    thought.append(thoughtTitle, thoughtText);
    const body = el('div', 'parts');
    const meta = el('div', 'meta');
    // While Umay works: what it is doing and for how long. Tool calls are hidden while they stream, so without
    // this line nothing on screen moves while a long file is being written.
    const activity = el('div', 'activity');
    box.append(thought, body, activity, meta);
    const drawActivity = () => {
      activity.hidden = !message.pending;
      if (!message.pending) return;
      const elapsed = Math.floor((Date.now() - (message.startedAt ?? Date.now())) / 1000);
      activity.replaceChildren(el('span', 'activity-dot'), el('span', 'activity-text', message.activity ?? 'Umay yanıtlıyor'), el('span', 'activity-time', `${elapsed} sn`));
    };

    const draw = () => {
      thought.hidden = !message.reasoning;
      thoughtTitle.textContent = message.pending && !message.content && !message.parts?.length ? 'Düşünüyor…' : 'Düşündü';
      thoughtText.textContent = message.reasoning ?? '';
      body.replaceChildren();
      const parts = message.parts ?? (message.content ? [{ type: 'text', text: message.content }] : []);
      parts.forEach((part, index) => {
        if (part.type === 'tool') body.append(toolCard(part, message.pending ? requestId() : null, folder));
        else if (part.type === 'notice') body.append(el('div', 'notice', part.text));
        else {
          const text = el('div', 'md');
          const last = index === parts.length - 1;
          markdown(text, part.text + (message.pending && last && message.activity === 'Yazıyor' ? ' ▍' : ''));
          body.append(text);
        }
      });
      if (message.error) {
        const error = el('div', 'md error');
        error.append(el('span', '', message.error));
        if (/anahtar/i.test(message.error)) error.append(button('link', ' Anahtarı gir', '', () => openKeyView(true)));
        body.append(error);
      }
      drawActivity();
      meta.replaceChildren();
      if (!message.pending) {
        const info = [modelNames[message.model] ?? String(message.model ?? '').split('/').pop(), message.seconds ? seconds(message.seconds) : '', message.stopped ? 'durduruldu' : ''].filter(Boolean);
        meta.append(el('span', '', info.join(' · ')));
        if (message.content) {
          const copy = button('icon-button', icon('copy'), 'Yanıtı kopyala', () => copyText(message.content, copy));
          meta.append(copy);
        }
        const changed = (message.parts ?? []).some(part => part.type === 'tool' && part.ok && ['write_file', 'append_file', 'edit_file'].includes(part.name));
        if (changed && folder) {
          const undo = button('link', [icon('discard'), ' Son değişikliği geri al'], 'Umay\'ın yaptığı son dosya değişikliğini geri al', async () => {
            undo.disabled = true;
            undo.replaceChildren(document.createTextNode(await ask('undo', { folder })));
          });
          meta.append(undo);
        }
      }
    };
    draw();
    let scheduled = false;
    // Pieces arrive many times a second; drawing every 30 ms is enough.
    return {
      box,
      update: () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => { scheduled = false; draw(); stickToBottom(); }, 30);
      },
      tick: drawActivity,
    };
  }

  let pinned = true;
  messagesEl.addEventListener('scroll', () => {
    pinned = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  });
  const stickToBottom = () => { if (pinned) messagesEl.scrollTop = messagesEl.scrollHeight; };

  function renderMessages() {
    for (const node of [...messagesEl.children]) if (node !== emptyEl) node.remove();
    emptyEl.hidden = current.messages.length > 0;
    for (const message of current.messages) messagesEl.append(messageView(message, () => null, current.folder).box);
    pinned = true;
    stickToBottom();
    remember({ chatId: current.messages.length ? current.id : null });
  }

  // ---------- Sending ----------

  // What Umay sees of the conversation: the user's messages (with the editor context they carried) and, for each
  // answer, everything the turn exchanged (tool calls and results), so a later turn knows what was done.
  const apiHistory = messages => messages.flatMap(message => {
    if (message.role === 'user') return [{ role: 'user', content: message.context ? `${message.content}\n\n${message.context}` : message.content }];
    if (message.transcript?.length) return message.transcript;
    return !message.error && message.content.trim() ? [{ role: 'assistant', content: message.content }] : [];
  });

  function send(text, preset) {
    text = text.trim();
    if (!text || busy) return;
    if (!keyState.saved && !keyState.env) { input.value = text; resize(); openKeyView(false); return; }
    const user = { role: 'user', content: text };
    const history = apiHistory(current.messages);
    const reply = { role: 'assistant', content: '', reasoning: '', parts: [], pending: true, model: modelSelect.value, startedAt: Date.now(), activity: 'Umay yanıtlıyor' };
    current.messages.push(user, reply);
    if (workspace.path) current.folder = workspace.path;
    if (current.messages.length === 2) current.title = text.replace(/\s+/g, ' ').slice(0, 60);
    emptyEl.hidden = true;
    showView('chat');
    const shownUser = userView(user);
    messagesEl.append(shownUser.box);
    const requestId = newId();
    const view = messageView(reply, () => requestId, current.folder);
    messagesEl.append(view.box);
    pinned = true;
    stickToBottom();
    input.value = '';
    resize();
    remember({ draft: '' });

    busy = { id: requestId, reply, view, user, shownUser, timer: setInterval(view.tick, 1000) };
    setBusy(true);
    saveCurrent();
    post('send', {
      id: requestId, chatId: current.id, text, model: modelSelect.value, thinking: thinkingSelect.value,
      useContext: !preset && useContext, preset: preset ?? undefined, history,
    });
  }

  function onEvent(id, event) {
    if (!busy || id !== busy.id) return;
    const { reply, view } = busy;
    const last = reply.parts.at(-1);
    switch (event.type) {
      case 'context':
        busy.user.context = event.context;
        busy.user.contextLabel = event.label;
        busy.shownUser.update();
        return;
      case 'text':
        if (last?.type === 'text') last.text += event.text; else reply.parts.push({ type: 'text', text: event.text });
        reply.content += event.text;
        reply.activity = 'Yazıyor';
        break;
      case 'reasoning':
        reply.reasoning += event.text;
        reply.activity = 'Düşünüyor';
        break;
      case 'drafting': {
        // Only the status line changes, except when writing turns into drafting: then the typing cursor goes.
        const wasWriting = reply.activity === 'Yazıyor';
        reply.activity = event.done ? 'Yazıyor' : `${LABELS[event.name] ?? 'Araç çağrısı'} hazırlanıyor${event.path ? `: ${event.path}` : ''} · ${size(event.chars)}`;
        if (wasWriting !== (reply.activity === 'Yazıyor')) break;
        view.tick();
        return;
      }
      case 'step':
        if (reply.content && !reply.content.endsWith('\n')) reply.content += '\n\n';
        reply.activity = 'Sonraki adımı düşünüyor';
        break;
      case 'notice': reply.parts.push({ type: 'notice', text: event.text }); break;
      case 'tool': {
        const { type, ...tool } = event;
        const existing = reply.parts.find(part => part.type === 'tool' && part.callId === event.callId);
        if (existing) Object.assign(existing, tool); else reply.parts.push({ type: 'tool', ...tool });
        const label = LABELS[event.name] ?? event.name;
        reply.activity = { running: `${label}: ${summary(event).slice(0, 80)}`, approval: `${label} için onayını bekliyor`, done: 'Sonuç Umay\'a gönderiliyor' }[event.status] ?? reply.activity;
        break;
      }
      case 'done': case 'stopped': case 'error': {
        clearInterval(busy.timer);
        reply.pending = false;
        if (event.transcript?.length) reply.transcript = event.transcript;
        if (event.type === 'done') Object.assign(reply, { model: event.model, seconds: event.seconds });
        if (event.type === 'stopped') Object.assign(reply, { stopped: true, seconds: event.seconds });
        if (event.type === 'error') reply.error = event.message;
        // A card still waiting for an answer when the turn ended was never run.
        for (const part of reply.parts) if (part.type === 'tool' && part.status !== 'done') Object.assign(part, { status: 'done', ok: false, result: 'Çalıştırılmadı (yanıt durduruldu).' });
        busy = null;
        setBusy(false);
        saveCurrent();
        break;
      }
      default: return;
    }
    view.update();
  }

  function setBusy(on) {
    sendButton.replaceChildren(icon(on ? 'debug-stop' : 'send'));
    sendButton.title = on ? 'Durdur' : 'Gönder (Enter)';
    sendButton.setAttribute('aria-label', on ? 'Durdur' : 'Gönder');
    sendButton.classList.toggle('stop', on);
    modelSelect.disabled = on;
    thinkingSelect.disabled = on;
  }

  async function saveCurrent() {
    chats = await ask('saveChat', { chat: { ...current, messages: current.messages.map(({ pending, startedAt, activity, ...rest }) => rest) } });
    remember({ chatId: current.id });
    if (!$('history-view').hidden) renderHistory();
  }

  $('composer').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) post('stop', { id: busy.id });
    else send(input.value);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!busy) send(input.value);
    }
  });
  const resize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
  input.addEventListener('input', () => { resize(); remember({ draft: input.value }); });

  // ---------- Editor context and workspace ----------

  function drawContext() {
    contextChip.hidden = !editorInfo;
    if (!editorInfo) return;
    $('ctx-label').textContent = editorInfo.label;
    contextChip.classList.toggle('off', !useContext);
    contextChip.title = useContext
      ? `${editorInfo.title}\nMesaja eklenecek. Eklememek için tıkla.`
      : `${editorInfo.title}\nMesaja eklenmeyecek. Eklemek için tıkla.`;
  }
  contextChip.addEventListener('click', () => { useContext = !useContext; drawContext(); input.focus(); });

  function drawWorkspace() {
    const ideas = workspace.hasFolder && workspace.trusted
      ? ['Bu projeyi incele ve kısaca anlat', 'Açık dosyadaki olası hataları bul', 'Bu proje için bir README dosyası yaz']
      : ['Python\'da bir CSV dosyasını okuyup sütun ortalamalarını hesapla', 'REST ile GraphQL arasındaki farkları bir tabloyla anlat', 'Bu hata ne demek: TypeError: Cannot read properties of undefined'];
    $('ideas').replaceChildren(...ideas.map(idea => button('idea', idea, '', () => send(idea))));
    const hint = $('hint');
    hint.replaceChildren();
    if (!workspace.hasFolder) {
      hint.append('Bir klasör açarsan Umay oradaki dosyaları okur, düzenler ve komut çalıştırır; her değişiklik için önce onayını ister. ',
        button('link', 'Klasör aç', '', () => post('run', { name: 'openFolder' })));
    } else if (!workspace.trusted) {
      hint.append('Bu klasöre güvenmediğin için Umay yalnızca sohbet eder; dosya araçları kapalı. ',
        button('link', 'Klasöre güven', '', () => post('run', { name: 'trust' })));
    } else {
      hint.append(`Umay ${workspace.name} klasöründe dosya okur, düzenler ve komut çalıştırır; her değişiklik ve komut için önce onayını ister. Seçtiğin kod mesaja kendiliğinden eklenir.`);
    }
    input.placeholder = workspace.hasFolder ? `${workspace.name} için ne yapalım?` : 'Umay\'a yaz…';
    input.title = 'Enter gönderir, Shift+Enter yeni satır açar';
  }

  // ---------- Background processes ----------

  // The servers and watchers Umay started, above the message box: what runs, where it answers, a stop button.
  const procsEl = $('procs');
  function renderProcesses(list = []) {
    const running = list.filter(item => item.status === 'running');
    procsEl.hidden = !running.length;
    procsEl.replaceChildren(...running.map(item => {
      const row = el('div', 'proc');
      row.append(el('span', 'proc-dot'), el('span', 'proc-name', item.name));
      if (!sameFolder(item.folder, workspace.path)) row.append(el('span', 'proc-folder', baseName(item.folder)));
      if (item.url) row.append(button('link proc-url', item.url.replace(/^https?:\/\//, ''), 'Tarayıcıda aç', () => post('openUrl', { url: item.url })));
      const stop = button('icon-button', icon('debug-stop'), 'Durdur', () => { stop.disabled = true; post('stopProcess', { folder: item.folder, id: item.id }); });
      row.append(stop);
      return row;
    }));
  }

  // ---------- Views: chat, history, key ----------

  function showView(name) {
    $('chat-view').hidden = name !== 'chat';
    $('history-view').hidden = name !== 'history';
    $('key-view').hidden = name !== 'key';
    if (name === 'chat') input.focus();
  }

  function renderHistory() {
    const list = $('history-list');
    list.replaceChildren();
    if (!chats.length) { list.append(el('p', 'muted center', 'Henüz sohbet yok.')); return; }
    for (const chat of chats) {
      const row = el('div', `history-item${chat.id === current.id ? ' active' : ''}`);
      const open = button('history-open', [], chat.folder ? `${chat.title}\n${chat.folder}` : chat.title, () => openChat(chat.id));
      const when = new Date(chat.updated).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      open.append(el('span', 'history-title', chat.title), el('span', 'history-sub', [baseName(chat.folder), when].filter(Boolean).join(' · ')));
      const remove = button('icon-button history-remove', icon('trash'), 'Sil', async () => {
        chats = await ask('deleteChat', { id: chat.id });
        if (current.id === chat.id) newChat(false);
        renderHistory();
      });
      row.append(open, remove);
      list.append(row);
    }
  }

  async function openChat(id) {
    if (busy) return;
    const chat = await ask('loadChat', { id });
    if (!chat) return;
    current = chat;
    renderMessages();
    showView('chat');
  }

  function newChat(focus = true) {
    if (busy) return;
    current = { id: newId(), title: 'Yeni sohbet', messages: [] };
    renderMessages();
    if (focus) showView('chat');
  }

  $('history-back').addEventListener('click', () => showView('chat'));
  $('history-new').addEventListener('click', () => newChat());

  const keyMessage = $('key-message');
  const keyInput = $('key-input');

  async function openKeyView(fromSettings) {
    keyState = await ask('keyStatus');
    showView('key');
    $('key-actions').hidden = !keyState.saved && !keyState.env && !fromSettings;
    $('key-delete').hidden = !keyState.saved;
    $('key-cli').hidden = !keyState.cli;
    keyMessage.textContent = keyState.saved ? 'Kayıtlı bir anahtar var. Yenisini girersen onun yerine geçer.'
      : keyState.env ? 'Şu an UMAY_API_KEY ortam değişkenindeki anahtar kullanılıyor. Buraya girdiğin anahtar onun yerine geçer.' : '';
    keyMessage.className = 'key-message';
    keyInput.value = '';
    keyInput.focus();
  }
  const keyResult = (result, saved) => {
    keyMessage.textContent = result.ok ? saved : result.message;
    keyMessage.className = `key-message ${result.ok ? 'good' : 'bad'}`;
    if (result.ok) {
      keyState = result.status ?? { saved: true };
      setTimeout(() => showView('chat'), 800);
    }
  };

  $('key-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!keyInput.value.trim()) return;
    $('key-save').disabled = true;
    keyMessage.textContent = 'Anahtar Umay\'a soruluyor…';
    keyMessage.className = 'key-message';
    try { keyResult(await ask('saveKey', { key: keyInput.value }), 'Anahtar doğrulandı ve kaydedildi. Hazırsın!'); }
    finally { $('key-save').disabled = false; keyInput.value = ''; }
  });
  $('key-cli').addEventListener('click', async () => {
    keyMessage.textContent = 'Umay CLI\'deki anahtar okunuyor…';
    keyMessage.className = 'key-message';
    keyResult(await ask('importCliKey'), 'Umay CLI\'deki anahtar alındı. Hazırsın!');
  });
  $('key-delete').addEventListener('click', async () => {
    keyState = await ask('deleteKey');
    await openKeyView(false);
    keyMessage.textContent = 'Anahtar silindi.';
  });
  $('key-close').addEventListener('click', () => showView('chat'));
  $('key-get').addEventListener('click', event => { event.preventDefault(); post('getKey'); });

  // ---------- Models ----------

  function drawModels(models, prefs) {
    modelSelect.replaceChildren(...models.map(model => new Option(model.name, model.id)));
    modelSelect.value = models.some(model => model.id === prefs.model) ? prefs.model : models[0]?.id;
    thinkingSelect.value = ['auto', 'on', 'off'].includes(prefs.thinking) ? prefs.thinking : 'auto';
  }
  modelSelect.addEventListener('change', () => post('setPref', { name: 'model', value: modelSelect.value }));
  thinkingSelect.addEventListener('change', () => post('setPref', { name: 'thinking', value: thinkingSelect.value }));

  // ---------- Messages from the extension ----------

  async function init(message) {
    modelNames = { ...message.modelNames, ...Object.fromEntries(message.models.map(model => [model.id, model.name])) };
    drawModels(message.models, message.prefs);
    chats = message.chats ?? [];
    workspace = message.workspace ?? workspace;
    editorInfo = message.editor;
    keyState = message.key ?? keyState;
    drawWorkspace();
    drawContext();
    renderProcesses(message.processes);
    // The conversation that was open before the editor reloaded the view.
    const { chatId, draft } = state();
    if (chatId && !busy) {
      const chat = await ask('loadChat', { id: chatId });
      if (chat) current = chat;
    }
    renderMessages();
    if (draft && !input.value) { input.value = draft; resize(); }
    if (!keyState.saved && !keyState.env) openKeyView(false);
    else showView('chat');
  }

  function command(name) {
    if (name === 'newChat') newChat();
    else if (name === 'history') {
      if ($('history-view').hidden) { renderHistory(); showView('history'); } else showView('chat');
    } else if (name === 'key') {
      if ($('key-view').hidden) openKeyView(true); else showView('chat');
    }
  }

  // A request from the editor's menu or a quick fix: sent at once, unless Umay is still busy.
  function prompt({ text, preset }) {
    if (busy) {
      input.value = text;
      resize();
      showView('chat');
      return;
    }
    send(text, preset);
  }

  window.addEventListener('message', ({ data }) => {
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'reply') {
      const resolve = waiting.get(data.reqId);
      waiting.delete(data.reqId);
      resolve?.(data.result);
      return;
    }
    switch (data.type) {
      case 'init': init(data); break;
      case 'event': onEvent(data.id, data.event); break;
      case 'editor':
        editorInfo = data.editor;
        if (data.workspace) workspace = data.workspace;
        drawContext();
        drawWorkspace();
        break;
      case 'processes': renderProcesses(data.processes); break;
      case 'key':
        keyState = data.key;
        if (!keyState.saved && !keyState.env) openKeyView(false);
        break;
      case 'command': command(data.name); break;
      case 'prompt': prompt(data); break;
      default:
    }
  });

  post('ready');
})();
