import type { Settings } from '../../shared/settings';
import { GeminiProvider } from './gemini';
import { ClaudeAccountProvider } from './claudeAccount';

export interface LLMMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface GenOptions { temperature: number; maxTokens: number; timeoutMs: number; signal: AbortSignal }

export interface LLMProvider {
  readonly name: string;
  readonly local: boolean;
  stream(messages: LLMMessage[], opts: GenOptions): AsyncGenerator<string>;
  test(signal?: AbortSignal): Promise<{ ok: boolean; detail: string; latencyMs?: number }>;
  listModels(): Promise<string[]>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'rate_limit' | 'network' | 'timeout' | 'server' | 'bad_request' | 'aborted' | 'config' | 'model', readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
  }
  get retryable() { return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'network'; }
}

export function friendlyError(e: unknown): string {
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case 'auth': return `${e.message.startsWith('Gemini') ? e.message + ' ' : 'O provedor recusou a chave de API. '}Confira na aba Modelo.`;
      case 'model': return `${e.message} Escolha outro modelo na aba Modelo.`;
      case 'rate_limit': return `O provedor está limitando as requisições${e.retryAfterMs ? ` (tente em ~${Math.ceil(e.retryAfterMs / 1000)} s)` : ''}. Tente de novo daqui a pouco.`;
      case 'network': return 'Não consegui falar com o servidor do modelo. Confira sua conexão ou se o servidor local está rodando.';
      case 'timeout': return 'O modelo demorou demais para responder (tempo esgotado).';
      case 'server': return `O servidor do modelo deu erro (${e.status ?? '?'}).`;
      case 'config': return e.message;
      case 'aborted': return 'Interrompido.';
      default: return `A requisição falhou: ${e.message}`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new ProviderError('aborted', 'aborted')); }, { once: true });
  });

/** fetch with timeout + abort + error classification. */
export async function httpFetch(url: string, init: RequestInit & { timeoutMs: number; signal?: AbortSignal }): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new ProviderError('timeout', 'timeout')), init.timeoutMs);
  const onAbort = () => ctrl.abort(new ProviderError('aborted', 'aborted'));
  init.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      const ra = Number(res.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : undefined;
      const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'server' : 'bad_request';
      throw new ProviderError(`HTTP ${res.status}: ${body}`, kind, res.status, retryAfterMs);
    }
    return res;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (ctrl.signal.aborted) throw ctrl.signal.reason instanceof ProviderError ? ctrl.signal.reason : new ProviderError('aborted', 'aborted');
    throw new ProviderError((e as Error).message, 'network');
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

/** Retry only before any bytes are streamed (so we never duplicate partial output). */
export async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!(e instanceof ProviderError) || !e.retryable || i === attempts - 1) throw e;
      await sleep(e.retryAfterMs ?? 600 * 2 ** i, signal);
    }
  }
  throw last;
}

/** Iterate lines of a streamed body; idle timeout guards stalled streams. */
export async function* readLines(res: Response, signal: AbortSignal, idleMs: number): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const onAbort = () => reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      let idle: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => { idle = setTimeout(() => rej(new ProviderError('stream stalled', 'timeout')), idleMs); }),
      ]).finally(() => clearTimeout(idle));
      if (signal.aborted) throw new ProviderError('aborted', 'aborted');
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        yield line;
      }
    }
    if (buf.trim()) yield buf;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly local = true;
  constructor(private baseUrl: string, private model: string) {}
  async *stream(messages: LLMMessage[], o: GenOptions) {
    const res = await withRetry(() => httpFetch(`${trimSlash(this.baseUrl)}/api/chat`, {
      method: 'POST', timeoutMs: o.timeoutMs, signal: o.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: true, options: { temperature: o.temperature, num_predict: o.maxTokens } }),
    }), o.signal);
    for await (const line of readLines(res, o.signal, o.timeoutMs)) {
      if (!line.trim()) continue;
      let j: { message?: { content?: string }; done?: boolean; error?: string };
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new ProviderError(j.error, 'server');
      if (j.message?.content) yield j.message.content;
      if (j.done) return;
    }
  }
  async listModels() {
    const res = await httpFetch(`${trimSlash(this.baseUrl)}/api/tags`, { timeoutMs: 5000 });
    const j = (await res.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  }
  async test() {
    const t0 = Date.now();
    try {
      const models = await this.listModels();
      const has = models.some((m) => m === this.model || m.split(':')[0] === this.model);
      return has
        ? { ok: true, detail: `Ollama acessível, modelo "${this.model}" instalado`, latencyMs: Date.now() - t0 }
        : { ok: false, detail: `Ollama acessível, mas o modelo "${this.model}" não está instalado. Rode: ollama pull ${this.model}` };
    } catch (e) { return { ok: false, detail: friendlyError(e) }; }
  }
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  get local() { return /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])/.test(this.baseUrl); }
  constructor(private baseUrl: string, private model: string, private key: string | undefined) {}
  private headers() {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.key) h.authorization = `Bearer ${this.key}`;
    return h;
  }
  async *stream(messages: LLMMessage[], o: GenOptions) {
    if (!this.key && !this.local) throw new ProviderError('Nenhuma chave de API para o provedor compatível com OpenAI (aba Modelo).', 'config');
    const res = await withRetry(() => httpFetch(`${trimSlash(this.baseUrl)}/chat/completions`, {
      method: 'POST', timeoutMs: o.timeoutMs, signal: o.signal, headers: this.headers(),
      body: JSON.stringify({ model: this.model, messages, stream: true, temperature: o.temperature, max_tokens: o.maxTokens }),
    }), o.signal);
    for await (const line of readLines(res, o.signal, o.timeoutMs)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; error?: { message: string } };
        if (j.error) throw new ProviderError(j.error.message, 'server');
        const d = j.choices?.[0]?.delta?.content;
        if (d) yield d;
      } catch (e) { if (e instanceof ProviderError) throw e; }
    }
  }
  async listModels() {
    const res = await httpFetch(`${trimSlash(this.baseUrl)}/models`, { timeoutMs: 8000, headers: this.headers() });
    const j = (await res.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id).sort();
  }
  async test() {
    const t0 = Date.now();
    if (!this.key && !this.local) return { ok: false, detail: 'Nenhuma chave de API definida.' };
    try { await this.listModels(); return { ok: true, detail: `Endpoint acessível (${this.baseUrl})`, latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, detail: friendlyError(e) }; }
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly local = false;
  constructor(private baseUrl: string, private model: string, private key: string | undefined) {}
  async *stream(messages: LLMMessage[], o: GenOptions) {
    if (!this.key) throw new ProviderError('Nenhuma chave de API da Anthropic (aba Modelo).', 'config');
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const convo = messages.filter((m) => m.role !== 'system');
    const res = await withRetry(() => httpFetch(`${trimSlash(this.baseUrl)}/v1/messages`, {
      method: 'POST', timeoutMs: o.timeoutMs, signal: o.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': this.key!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.model, system, messages: convo, stream: true, max_tokens: o.maxTokens, temperature: Math.min(1, o.temperature) }),
    }), o.signal);
    for await (const line of readLines(res, o.signal, o.timeoutMs)) {
      if (!line.startsWith('data:')) continue;
      try {
        const j = JSON.parse(line.slice(5)) as { type: string; delta?: { type: string; text?: string }; error?: { message: string } };
        if (j.type === 'error') throw new ProviderError(j.error?.message ?? 'error', 'server');
        if (j.type === 'content_block_delta' && j.delta?.text) yield j.delta.text;
        if (j.type === 'message_stop') return;
      } catch (e) { if (e instanceof ProviderError) throw e; }
    }
  }
  async listModels() {
    if (!this.key) return [];
    const res = await httpFetch(`${trimSlash(this.baseUrl)}/v1/models`, { timeoutMs: 8000, headers: { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' } });
    const j = (await res.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id);
  }
  async test() {
    const t0 = Date.now();
    if (!this.key) return { ok: false, detail: 'Nenhuma chave de API da Anthropic.' };
    try { await this.listModels(); return { ok: true, detail: 'API da Anthropic acessível, chave aceita', latencyMs: Date.now() - t0 }; }
    catch (e) { return { ok: false, detail: friendlyError(e) }; }
  }
}

export function createProvider(s: Settings['ai'], secret: (k: 'openai' | 'anthropic' | 'gemini') => string | undefined, offline: LLMProvider, extra: { onModelUsed?: (m: string, fallback: boolean) => void; geminiServerUrl?: string } = {}): LLMProvider {
  switch (s.provider) {
    case 'gemini': return new GeminiProvider({ apiKey: secret('gemini'), model: s.gemini.model, fallbackModel: s.gemini.fallbackModel, thinkingLevel: s.gemini.thinkingLevel, onModelUsed: extra.onModelUsed, serverUrl: extra.geminiServerUrl });
    case 'claude': return new ClaudeAccountProvider(s.claude.model);
    case 'ollama': return new OllamaProvider(s.ollama.baseUrl, s.ollama.model);
    case 'openai': return new OpenAIProvider(s.openai.baseUrl, s.openai.model, secret('openai'));
    case 'anthropic': return new AnthropicProvider(s.anthropic.baseUrl, s.anthropic.model, secret('anthropic'));
    default: return offline;
  }
}
