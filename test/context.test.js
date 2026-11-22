const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { editorContext, describeEditor, fenced } = require('../src/context');

const root = path.resolve('/proje');
// A stand-in for the editor's objects: a document with lines and a selection.
function editor(text, { file = path.join(root, 'src', 'hesap.js'), language = 'javascript', selection, untitled = false, scheme } = {}) {
  const lines = text.split('\n');
  const offset = ({ line, character }) => lines.slice(0, line).join('\n').length + (line ? 1 : 0) + character;
  const sel = selection ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, active: { line: 0, character: 0 } };
  sel.isEmpty = sel.start.line === sel.end.line && sel.start.character === sel.end.character;
  sel.active ??= sel.end;
  return {
    selection: sel,
    document: {
      uri: { scheme: scheme ?? (untitled ? 'untitled' : 'file'), path: untitled ? 'Untitled-1' : file.replace(/\\/g, '/') },
      fileName: untitled ? 'Untitled-1' : file,
      isUntitled: untitled,
      languageId: language,
      getText: range => (range ? text.slice(offset(range.start), offset(range.end)) : text),
    },
  };
}
const select = (startLine, startChar, endLine, endChar) => ({ start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } });
const code = 'function topla(a, b) {\n  return a - b;\n}\n';

test('the chip names the file, and the lines when something is selected', () => {
  assert.deepEqual(describeEditor(editor(code), root), { label: 'hesap.js', title: 'src/hesap.js' });
  assert.equal(describeEditor(editor(code, { selection: select(1, 0, 1, 15) }), root).label, 'hesap.js:2');
  // A whole-line selection ends at the start of the next line, which is not part of it.
  assert.equal(describeEditor(editor(code, { selection: select(0, 0, 2, 0) }), root).label, 'hesap.js:1-2');
  assert.equal(describeEditor(editor(code, { scheme: 'output' }), root), null, 'output panels and other views are not files');
  assert.equal(describeEditor(undefined, root), null);
});

test('with tools the context carries the path and the selection, not the whole file', () => {
  const context = editorContext(editor(code, { selection: select(1, 0, 1, 15) }), { root, tools: true });
  assert.equal(context.label, 'hesap.js:2');
  assert.match(context.text, /^\[Editör bağlamı\]\nAçık dosya: src\/hesap\.js \(javascript\), imleç satır 2\nSeçili kod, satır 2-2:\n```javascript\n {2}return a - b;\n```$/);
  const plain = editorContext(editor(code), { root, tools: true });
  assert.doesNotMatch(plain.text, /function topla/, 'Umay can read the file itself');
  assert.match(editorContext(editor(code), { root, tools: true, whole: true }).text, /Dosyanın içeriği:\n```javascript\nfunction topla/);
});

test('without tools, outside the folder or unsaved, the file text comes along', () => {
  assert.match(editorContext(editor(code), { root, tools: false }).text, /Dosyanın içeriği:\n```javascript\nfunction topla/);
  const outside = editorContext(editor(code, { file: path.resolve('/baska/x.js') }), { root, tools: true });
  assert.match(outside.text, /Açık dosya: .*baska.*x\.js/);
  assert.match(outside.text, /function topla/);
  const fresh = editorContext(editor('print(1)\n', { untitled: true, language: 'python' }), { root, tools: true });
  assert.match(fresh.text, /Açık dosya: Untitled-1 \(python\)/);
  assert.match(fresh.text, /print\(1\)/);
});

test('a diagnostic range is sent as the relevant part; long text is cut; fences outgrow the code', () => {
  const context = editorContext(editor(code), { root, tools: true, range: select(0, 0, 2, 1) });
  assert.match(context.text, /İlgili kısım, satır 1-3:/);
  const long = 'x'.repeat(30_000);
  assert.match(editorContext(editor(long), { root, tools: false }).text, /ilk 20000 karakter; dosya daha uzun/);
  assert.equal(fenced('a ``` b', 'md'), '````md\na ``` b\n````');
});
