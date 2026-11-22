// Conversations, kept as one JSON file in the extension's storage folder (from Umay Code). Small and simple on purpose: a few hundred
// conversations of text fit easily; the file is replaced in one write so a crash cannot leave half of it.
const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 300;

function createChatStore({ dir }) {
  const file = path.join(dir, 'sohbetler.json');

  function list() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data) ? data.filter(chat => chat && typeof chat.id === 'string' && Array.isArray(chat.messages)) : [];
    } catch { return []; }
  }

  function write(chats) {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.yeni`;
    fs.writeFileSync(temp, JSON.stringify(chats));
    fs.renameSync(temp, file);
  }

  // Inserts or replaces one conversation; the most recent comes first.
  function save(chat) {
    if (!chat || typeof chat.id !== 'string' || !Array.isArray(chat.messages)) throw new Error('Geçersiz sohbet.');
    const clean = {
      id: chat.id,
      title: String(chat.title ?? 'Yeni sohbet').slice(0, 80),
      updated: Date.now(),
      model: typeof chat.model === 'string' ? chat.model : undefined,
      folder: typeof chat.folder === 'string' ? chat.folder : undefined,
      messages: chat.messages
        .filter(message => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
        .map(({ role, content, context, contextLabel, reasoning, model, seconds, stopped, error, parts, transcript }) => ({ role, content, context, contextLabel, reasoning, model, seconds, stopped, error, parts, transcript })),
    };
    write([clean, ...list().filter(item => item.id !== chat.id)].slice(0, LIMIT));
    return clean;
  }

  function remove(id) { write(list().filter(item => item.id !== id)); }

  return { list, save, remove, file };
}

module.exports = { createChatStore };
