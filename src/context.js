// What the user is looking at in the editor, added to a message so "bu fonksiyon" or "şu hata" needs no
// explaining: the open file, the cursor line and the selected code. The file's whole text is added only when
// Umay cannot read it itself (no tools, or a file outside the project folder, or one never saved).
// Pure functions over the editor's objects, so they can be tested without the editor.
const path = require('node:path');

const SELECTION_LIMIT = 12_000;
const FILE_LIMIT = 20_000;
const SCHEMES = new Set(['file', 'untitled']);

const inside = (root, file) => {
  if (!root || !file) return false;
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// A fence longer than any run of backticks in the code, so code holding ``` cannot end the block early.
function fenced(code, language) {
  const longest = Math.max(0, ...(String(code).match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language ?? ''}\n${code}${code.endsWith('\n') ? '' : '\n'}${fence}`;
}

const cut = (text, limit) => (text.length <= limit ? { text, cut: false } : { text: text.slice(0, limit), cut: true });

// The name Umay and the user see: relative inside the project folder, the full path outside it.
function displayName(document, root) {
  if (document.isUntitled) return path.basename(document.uri.path) || 'Adsız';
  return inside(root, document.fileName) ? path.relative(root, document.fileName).replace(/\\/g, '/') : document.fileName;
}

function usable(editor) {
  return Boolean(editor?.document && SCHEMES.has(editor.document.uri.scheme));
}

// The short label for the chip above the message box, or null when no file is open.
function describeEditor(editor, root) {
  if (!usable(editor)) return null;
  const { document, selection } = editor;
  const name = displayName(document, root);
  const base = path.basename(name);
  if (selection && !selection.isEmpty) {
    const from = selection.start.line + 1;
    const to = selection.end.line + (selection.end.character === 0 && selection.end.line > selection.start.line ? 0 : 1);
    return { label: `${base}:${from}${to > from ? `-${to}` : ''}`, title: `${name} · seçili satırlar ${from}-${to}` };
  }
  return { label: base, title: name };
}

// { text, label } for the API message, or null. `range` replaces the selection (a diagnostic's lines);
// `whole` adds the file's text even when Umay could read it (the editor commands without a selection).
function editorContext(editor, { root, tools, range, whole = false } = {}) {
  if (!usable(editor)) return null;
  const { document } = editor;
  const selection = range ?? editor.selection;
  const name = displayName(document, root);
  const language = document.languageId;
  const lines = ['[Editör bağlamı]', `Açık dosya: ${name} (${language}), imleç satır ${(editor.selection?.active?.line ?? 0) + 1}`];
  let label = path.basename(name);
  if (selection && !selection.isEmpty) {
    const from = selection.start.line + 1;
    const to = selection.end.line + (selection.end.character === 0 && selection.end.line > selection.start.line ? 0 : 1);
    const chosen = cut(document.getText(selection), SELECTION_LIMIT);
    lines.push(`${range ? 'İlgili kısım' : 'Seçili kod'}, satır ${from}-${to}${chosen.cut ? ` (ilk ${SELECTION_LIMIT} karakter)` : ''}:`, fenced(chosen.text, language));
    label += `:${from}${to > from ? `-${to}` : ''}`;
  } else if (whole || !tools || document.isUntitled || !inside(root, document.fileName)) {
    const content = cut(document.getText(), FILE_LIMIT);
    if (content.text.trim()) lines.push(`Dosyanın içeriği${content.cut ? ` (ilk ${FILE_LIMIT} karakter; dosya daha uzun)` : ''}:`, fenced(content.text, language));
  }
  return { text: lines.join('\n'), label };
}

module.exports = { editorContext, describeEditor, displayName, fenced, inside };
