// Umay API client, from Umay Code (src/umay.js). It runs in the extension host; the key never reaches the
// webview, which gets the reply piece by piece.
// Observed behaviour (Umay CLI, docs/API-GOZLEMLERI.md, 11-12 Nov 2026): OpenAI-compatible chat completions,
// reasoning arrives in delta.reasoning_content, `enable_thinking` switches thinking, GET /models needs no key,
// three requests a second at most, unknown model names fall back silently to umay-akilli.
const BASE_URL = 'https://umayzeka.com/v1';
const DEFAULT_MODEL = 'umay-akilli';

const MODEL_NAMES = {
  'umay-akilli': 'Umay Akıllı', 'umay-hizli': 'Umay Hızlı', 'umay-ultra-hizli': 'Umay Ultra Hızlı', 'umay-daha-zeki': 'Umay Daha Zeki',
  'umay-mistral-large': 'Mistral Large 4', 'umay-deepseek-flash': 'DeepSeek v4.1 Flash', 'umay-minimax-flash': 'MiniMax M3.1 Flash', 'umay-glm-flash': 'GLM 5.3 Flash',
  // The answer's `model` field names the provider's model behind Umay's name (13 Nov 2026).
  'mistralai/mistral-large-4-1t-a52b': 'Mistral Large 4', 'deepseek-ai/deepseek-v4.1-flash': 'DeepSeek v4.1 Flash',
  'minimaxai/minimax-m3.1-flash': 'MiniMax M3.1 Flash', 'z-ai/glm-5.3-flash': 'GLM 5.3 Flash',
};
const FALLBACK_MODELS = ['umay-akilli', 'umay-hizli', 'umay-ultra-hizli', 'umay-daha-zeki'];
// A name not in the table is shown without its provider prefix: "acme/model-x" → "model-x".
const modelName = id => MODEL_NAMES[id] ?? String(id ?? '').split('/').pop();

// AbortSignal.any arrived in Node 20.3; editors built on older Electron (VS Code 1.85, some forks) lack it.
function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

// The API address from the settings: HTTPS, or HTTP only on this computer (for tests and local proxies).
function checkBaseURL(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '') || BASE_URL;
  let url;
  try { url = new URL(text); } catch { throw new Error(`Geçersiz Umay API adresi: ${text}`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Umay API adresi HTTPS olmalı (HTTP yalnızca localhost için).');
  return text;
}

// Umay's own names; the providers' names on the list (mistralai/...) lead to the same models.
async function listModels({ baseURL = BASE_URL, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${baseURL}/models`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !/json/i.test(response.headers.get('content-type') ?? '')) throw new Error('no list');
    const items = (await response.json())?.data ?? [];
    const own = items.filter(item => typeof item?.id === 'string' && item.owned_by === 'umay').map(item => item.id);
    if (!own.length) throw new Error('empty');
    return own.map(id => ({ id, name: modelName(id) }));
  } catch {
    return FALLBACK_MODELS.map(id => ({ id, name: modelName(id) }));
  }
}

// true: accepted, false: refused (401/403), null: could not tell. A request without messages reaches no model:
// Umay checks the key first and answers 400 for a good one.
async function verifyKey(apiKey, { baseURL = BASE_URL, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${baseURL}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: DEFAULT_MODEL, messages: [] }), signal: AbortSignal.timeout(20_000),
    });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) return false;
    return response.status === 400 || response.ok ? true : null;
  } catch { return null; }
}

// Splits a server-sent event stream into the JSON payloads of its `data:` lines.
function sseParser(onData) {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { onData(JSON.parse(data)); } catch { /* a broken line is skipped */ }
    }
  };
}

function friendlyStatus(status, body = '') {
  if (status === 401) return 'Umay API anahtarı kabul edilmedi. Anahtarı panelin üstündeki anahtar düğmesinden yeniden gir.';
  if (status === 403) return 'Erişim reddedildi. Anahtarının API yetkisini kontrol et.';
  if (status === 429) return /burst|patlama/i.test(body)
    ? 'Çok hızlı istek gönderildi (saniyede en fazla 3). Birkaç saniye sonra tekrar dene.'
    : 'İstek sınırı veya kota doldu. Biraz bekleyip tekrar dene.';
  if (status === 503) return 'Umay şu anda bakımda veya yoğun. Biraz sonra tekrar dene.';
  if ([502, 504, 520, 521, 522, 523, 524].includes(status)) return 'Umay sunucusuna ulaşılamadı (ağ geçidi hatası). Biraz sonra tekrar dene.';
  if (status >= 500) return `Umay sunucusunda hata oluştu (HTTP ${status}).`;
  return `Umay isteği kabul etmedi (HTTP ${status}).`;
}

// Streams one reply. Calls onReasoning/onText with each piece; resolves with { text, reasoning, model, seconds }.
// thinking: true (on), false (off) or null (Umay decides).
async function streamChat({ apiKey, messages, model = DEFAULT_MODEL, thinking = null, signal, onText = () => {}, onReasoning = () => {},
  baseURL = BASE_URL, fetchImpl = fetch, silence = 120_000 }) {
  const started = Date.now();
  // The clock only counts silence: a long answer that keeps arriving is never cut.
  const watchdog = new AbortController();
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => watchdog.abort(), silence); };
  const abort = anySignal([watchdog.signal, ...(signal ? [signal] : [])]);
  const body = { model, messages, stream: true };
  if (typeof thinking === 'boolean') Object.assign(body, { enable_thinking: thinking, chat_template_kwargs: { enable_thinking: thinking } });
  let text = '';
  let reasoning = '';
  let routed = model;
  arm();
  try {
    let response;
    try {
      response = await fetchImpl(`${baseURL}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: abort, redirect: 'manual',
      });
    } catch (error) {
      if (signal?.aborted) throw stopped();
      if (watchdog.signal.aborted) throw new Error('Umay zamanında yanıt vermedi. Tekrar deneyebilirsin.');
      throw new Error('Umay\'a bağlanılamadı. İnternet bağlantını kontrol et.');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(friendlyStatus(response.status, detail));
    }
    const decoder = new TextDecoder();
    const feed = sseParser(data => {
      if (typeof data.model === 'string') routed = data.model;
      if (data.error) throw new Error(`Umay hata bildirdi: ${String(data.error.message ?? data.error).slice(0, 200)}`);
      const delta = data.choices?.[0]?.delta ?? {};
      const thought = delta.reasoning_content ?? delta.reasoning;
      if (thought) { reasoning += thought; onReasoning(thought); }
      if (delta.content) { text += delta.content; onText(delta.content); }
    });
    try {
      for await (const chunk of response.body) { arm(); feed(decoder.decode(chunk, { stream: true })); }
    } catch (error) {
      if (signal?.aborted) throw stopped(text, reasoning);
      if (watchdog.signal.aborted) throw new Error('Yanıt yarıda kesildi: Umay bir süredir veri göndermiyor.');
      if (/Umay hata bildirdi/.test(error?.message)) throw error;
      throw new Error('Bağlantı yanıt tamamlanmadan koptu. Tekrar deneyebilirsin.');
    }
    if (!text.trim() && !reasoning.trim()) throw new Error('Umay boş yanıt döndürdü. Başka bir modelle veya düşünmeyi değiştirerek tekrar dene.');
    return { text, reasoning, model: routed, seconds: (Date.now() - started) / 1000 };
  } finally { clearTimeout(timer); }
}

function stopped(text = '', reasoning = '') {
  const error = new Error('Durduruldu.');
  error.stopped = true;
  error.partial = { text, reasoning };
  return error;
}

module.exports = { BASE_URL, DEFAULT_MODEL, MODEL_NAMES, modelName, listModels, verifyKey, streamChat, sseParser, friendlyStatus, checkBaseURL, anySignal };
