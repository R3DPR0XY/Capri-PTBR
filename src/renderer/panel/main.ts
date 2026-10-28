import type { ActionRequest, ActionResult, AssistantPhase, ChatMessage, ConnectionStatus, Diagnostics, MemoryItem, Note, Reminder } from '../../shared/ipc';
import { TOOL_NAMES, type Settings, type ToolName } from '../../shared/settings';
import type { CapriApi } from '../../preload/preload';
import { icon } from './icons';

declare global { interface Window { capri: CapriApi } }
const api = window.capri;

// ---------------------------------------------------------------- tiny DOM helper (no innerHTML → no injection)
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ---------------------------------------------------------------- state
let S: Settings;
let secretStatus: Record<string, boolean> = {};
let phase: AssistantPhase = 'idle';
let phaseDetail = '';
let conn: ConnectionStatus | null = null;
let tab = location.hash.slice(1) || 'chat';
const TABS: { id: string; label: string; icon: string }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'model', label: 'Modelo', icon: 'model' },
  { id: 'voice', label: 'Voz', icon: 'voice' },
  { id: 'character', label: 'Personagem', icon: 'eye' },
  { id: 'memory', label: 'Memória', icon: 'memory' },
  { id: 'privacy', label: 'Privacidade', icon: 'shield' },
  { id: 'system', label: 'Sistema', icon: 'pulse' },
];
// older entry points (tray menu, shortcuts, tests) still land somewhere sensible
const ALIASES: Record<string, string> = { settings: 'model', look: 'character', move: 'character', behavior: 'character', permissions: 'privacy', diagnostics: 'system' };
const view = document.getElementById('view')!;

function setByPath(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const patch: Record<string, unknown> = {};
  let cur = patch;
  keys.forEach((k, i) => { if (i === keys.length - 1) cur[k] = value; else { cur[k] = {}; cur = cur[k] as Record<string, unknown>; } });
  return patch;
}
const getByPath = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], S);
async function save(path: string, value: unknown) {
  const r = await api.invoke('settings:set', setByPath(path, value));
  S = r.settings;
  if (r.repaired.length) toast(`Valor inválido em ${r.repaired.join(', ')}; voltou ao padrão.`, true);
}
const timers: Record<string, number> = {};
function saveDebounced(path: string, value: unknown, ms = 400) {
  clearTimeout(timers[path]);
  timers[path] = window.setTimeout(() => void save(path, value), ms);
}

// ---------------------------------------------------------------- components
const field = (label: string, control: Node, hint?: string, wide = false) =>
  h('div', { class: `field${wide ? ' wide' : ''}` }, h('label', {}, label), h('div', { class: 'control' }, control), hint ? h('div', { class: 'hint' }, hint) : null);
const toggle = (path: string, label: string, onChange?: (v: boolean) => void) =>
  h('input', { type: 'checkbox', class: 'switch', checked: !!getByPath(path), role: 'switch', 'aria-label': label, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).checked; void save(path, v).then(() => onChange?.(v)); } });
const sw = (label: string, path: string, onChange?: (v: boolean) => void) => field(label, toggle(path, label, onChange));
function range(path: string, label: string, min: number, max: number, step: number, fmt = (v: number) => v.toFixed(2)) {
  const val = h('span', { class: 'val' }, fmt(Number(getByPath(path))));
  const input = h('input', { type: 'range', min, max, step, value: Number(getByPath(path)), 'aria-label': label,
    oninput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); val.textContent = fmt(v); saveDebounced(path, v, 120); } });
  return h('span', { class: 'row' }, input, val);
}
const select = (path: string, label: string, options: [string, string][], onChange?: (v: string) => void, coerce: (v: string) => unknown = (v) => v) => {
  const cur = String(getByPath(path));
  return h('select', { 'aria-label': label, onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; void save(path, coerce(v)).then(() => onChange?.(v)); } },
    ...options.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
};
const text = (path: string, label: string, placeholder = '', listId?: string) => {
  const el = h('input', { type: 'text', value: String(getByPath(path) ?? ''), placeholder, spellcheck: false, 'aria-label': label, oninput: (e: Event) => saveDebounced(path, (e.target as HTMLInputElement).value.trim(), 600) });
  if (listId) el.setAttribute('list', listId);
  return el;
};
const timeIn = (path: string, label: string) => h('input', { type: 'time', value: String(getByPath(path)), 'aria-label': label, onchange: (e: Event) => void save(path, (e.target as HTMLInputElement).value) });
const num = (path: string, label: string, min: number, max: number) => h('input', { type: 'number', min, max, value: Number(getByPath(path)), 'aria-label': label, onchange: (e: Event) => void save(path, Number((e.target as HTMLInputElement).value)) });
const group = (title: string, ...kids: Child[]) => h('section', { class: 'group' }, h('span', { class: 'label' }, title), ...kids);
const btn = (label: string, onclick: () => unknown, cls = '', ic?: string, title?: string) =>
  h('button', { class: `btn ${cls}`, onclick, title, type: 'button' }, ic ? icon(ic) : null, label);
const viewHead = (title: string) => h('div', { class: 'view-head' }, h('h1', {}, title));
const emptyLine = (t: string) => h('div', { class: 'empty-line' }, t);
const pct = (v: number) => `${Math.round(v * 100)}%`;

function toast(msg: string, err = false) {
  const t = h('div', { class: `toast${err ? ' err' : ''}`, role: 'status' }, msg);
  document.getElementById('toasts')!.append(t);
  setTimeout(() => t.remove(), 3800);
}

// ---------------------------------------------------------------- status (one indicator: connection, plus what she's doing when busy)
const phaseChip = document.getElementById('phaseChip')!;
const phaseText = document.getElementById('phaseText')!;
const connChip = document.getElementById('connChip')!;
const connText = document.getElementById('connText')!;
const PHASE_LABEL: Record<AssistantPhase, string> = { idle: 'pronta', listening: 'ouvindo', transcribing: 'transcrevendo', thinking: 'pensando', speaking: 'falando', error: 'erro', offline: 'offline' };
let statusEl: HTMLElement | null = null;
let stopBtn: HTMLButtonElement | null = null;
function renderPhase() {
  phaseChip.dataset.phase = phase;
  phaseText.textContent = PHASE_LABEL[phase];
  if (statusEl) {
    statusEl.textContent = phase === 'idle' ? phaseDetail : phaseDetail || `${PHASE_LABEL[phase]}…`;
    statusEl.className = `status${phase === 'error' ? ' err' : ''}`;
  }
  if (stopBtn) stopBtn.hidden = !(phase === 'thinking' || phase === 'speaking');
}
const CONN_LABEL: Record<ConnectionStatus['state'], string> = { connecting: 'Conectando', connected: 'Online', disconnected: 'Offline', error: 'Erro' };
function renderConn() {
  if (!conn) return;
  connChip.dataset.state = conn.state;
  connText.textContent = conn.provider === 'offline' ? 'Sem IA' : CONN_LABEL[conn.state];
  connChip.title = `${conn.provider}${conn.model ? ` · ${conn.model}` : ''}: ${conn.detail}`;
}

// ---------------------------------------------------------------- navigation
function renderRail() {
  const rail = document.getElementById('rail')!;
  rail.replaceChildren(...TABS.map((t) => h('button', { role: 'tab', 'aria-selected': String(t.id === tab), 'aria-label': t.label, onclick: () => go(t.id) }, icon(t.icon), h('span', { class: 'tip' }, t.label))));
}
function go(t: string) {
  t = ALIASES[t] ?? t;
  if (t !== 'welcome' && !TABS.some((x) => x.id === t)) t = 'chat';
  tab = t;
  renderRail();
  statusEl = null; stopBtn = null;
  view.replaceChildren();
  view.className = 'enter';
  void (RENDER[t] ?? renderChat)();
  setTimeout(() => (view.className = ''), 200);
}

// ---------------------------------------------------------------- chat
let messagesEl: HTMLElement;
let scroller: HTMLElement;
const streamBubbles = new Map<string, { el: HTMLElement; text: string }>();

function richText(content: string): Node[] {
  const out: Node[] = [];
  content.split(/```(?:[\w-]*)\n?([\s\S]*?)```/g).forEach((part, i) => {
    if (i % 2 === 1) { out.push(h('pre', {}, h('code', {}, part))); return; }
    part.split(/`([^`\n]+)`/g).forEach((seg, j) => out.push(j % 2 ? h('code', {}, seg) : document.createTextNode(seg)));
  });
  return out;
}
function msgEl(m: ChatMessage): HTMLElement {
  if (m.role === 'action') {
    const st = m.meta?.actionStatus ?? '';
    const cls = st === 'done' ? 'ok' : ['failed', 'blocked', 'rejected', 'declined'].includes(st) ? 'bad' : '';
    return h('div', { class: 'msg action' }, h('span', { class: `tag ${cls}` }, st || 'ação'), h('span', {}, m.content));
  }
  const el = h('div', { class: `msg ${m.role}${m.meta?.error ? ' err' : ''}`, 'data-id': m.id },
    m.role === 'assistant' ? h('span', { class: 'who' }, 'Capri') : null, ...richText(m.content));
  if (m.meta?.interrupted) el.append(h('span', { class: 'meta' }, '— interrompida'));
  if (m.meta?.error && m.content !== m.meta.error) el.append(h('span', { class: 'meta' }, m.meta.error));
  return el;
}
const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
const scrollDown = (force = false) => { if (scroller && (force || atBottom())) scroller.scrollTop = scroller.scrollHeight; };

const pendingConfirm = new Map<string, ActionRequest>();
function confirmCard(req: ActionRequest): HTMLElement {
  const c = h('div', { class: 'confirm', 'data-confirm': req.id });
  const respond = async (approved: boolean) => {
    pendingConfirm.delete(req.id);
    c.remove(); // the main process logs the outcome as an action message
    await api.invoke('action:respond', { id: req.id, approved });
  };
  c.append(h('div', {}, req.summary));
  if (req.tainted) c.append(h('div', { class: 'why' }, 'Pedido logo depois de ler nomes de arquivos ou notas. Confira se é isso mesmo que você quer.'));
  c.append(h('div', { class: 'row' }, btn('Permitir', () => respond(true), 'primary', 'check'), btn('Negar', () => respond(false), '', 'close')));
  return c;
}
let chatReady = false;
function showConfirm(req: ActionRequest) {
  if (!chatReady || !messagesEl || messagesEl.querySelector(`[data-confirm="${CSS.escape(req.id)}"]`)) return;
  messagesEl.append(confirmCard(req));
  scrollDown(true);
}

let mic = false;
async function renderChat() {
  chatReady = false;
  scroller = h('div', { class: 'scroll' });
  messagesEl = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
  scroller.append(messagesEl);
  const ta = h('textarea', { placeholder: 'Mensagem para a Capri', rows: 1, 'aria-label': 'Mensagem' });
  const send = async (value?: string) => {
    const v = (value ?? ta.value).trim();
    if (!v) return;
    ta.value = ''; autosize();
    try { await api.invoke('chat:send', { text: v }); } catch (e) { toast((e as Error).message, true); }
  };
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, Math.max(34, ta.scrollHeight + 2))}px`; };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } });
  const micBtn = h('button', { class: 'btn icon-only', type: 'button', title: S.voice.micPermission ? 'Segure para falar (Ctrl+Alt+T)' : 'Microfone desligado (aba Voz)', 'aria-label': 'Apertar para falar' }, icon('mic'));
  micBtn.disabled = !S.voice.micPermission;
  const micStart = () => { if (mic) return; mic = true; micBtn.classList.add('rec'); void api.invoke('voice:ptt', 'start'); };
  const micStop = () => { if (!mic) return; mic = false; micBtn.classList.remove('rec'); void api.invoke('voice:ptt', 'stop'); };
  micBtn.addEventListener('pointerdown', micStart);
  micBtn.addEventListener('pointerup', micStop);
  micBtn.addEventListener('pointerleave', micStop);
  micBtn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); mic ? micStop() : micStart(); } });
  stopBtn = h('button', { class: 'btn icon-only', type: 'button', title: 'Parar (Esc)', 'aria-label': 'Parar', onclick: () => api.invoke('chat:stop') }, icon('stop'));
  const sendBtn = h('button', { class: 'btn primary icon-only', type: 'button', title: 'Enviar (Enter)', 'aria-label': 'Enviar', onclick: () => send() }, icon('send'));
  statusEl = h('div', { class: 'status' });
  view.append(h('div', { class: 'chat' }, scroller, statusEl, h('div', { class: 'composer' }, ta, micBtn, stopBtn, sendBtn)));

  const hist = await api.invoke('chat:history', { limit: 200 });
  if (!hist.length) {
    messagesEl.append(h('div', { class: 'empty' }, h('div', {}, 'Diz alguma coisa.'),
      h('div', { class: 'try' }, ...['Quem é você?', 'Teletransporta', 'Timer de 5 minutos'].map((q) => h('button', { type: 'button', onclick: () => send(q) }, q)))));
  }
  const shownIds = new Set(hist.map((m) => m.id));
  const early = [...messagesEl.children].filter((el) => !shownIds.has((el as HTMLElement).dataset.id ?? ''));
  messagesEl.replaceChildren(...hist.map(msgEl), ...early);
  for (const [id, b] of streamBubbles) if (!shownIds.has(id)) messagesEl.append(b.el);
  chatReady = true;
  for (const req of pendingConfirm.values()) showConfirm(req);
  renderPhase();
  scrollDown(true);
  ta.focus();
}

api.on('chat:message', (p) => {
  const { message } = p as { message: ChatMessage };
  if (tab !== 'chat' || !messagesEl) return;
  messagesEl.querySelector('.empty')?.remove();
  messagesEl.append(msgEl(message));
  scrollDown(message.role === 'user');
});
api.on('chat:delta', (p) => {
  const { messageId, delta } = p as { messageId: string; delta: string };
  if (tab !== 'chat' || !messagesEl) return;
  let b = streamBubbles.get(messageId);
  if (!b) {
    const el = h('div', { class: 'msg assistant cursor', 'data-id': messageId });
    messagesEl.append(el);
    b = { el, text: '' };
    streamBubbles.set(messageId, b);
  }
  b.text += delta;
  b.el.replaceChildren(h('span', { class: 'who' }, 'Capri'), b.text);
  scrollDown();
});
api.on('chat:done', (p) => {
  const { message } = p as { message: ChatMessage };
  const b = streamBubbles.get(message.id);
  streamBubbles.delete(message.id);
  if (tab !== 'chat' || !messagesEl) return;
  const fresh = msgEl(message);
  if (b) { if (message.content) b.el.replaceWith(fresh); else b.el.remove(); }
  else if (message.content) messagesEl.append(fresh);
  scrollDown();
});
api.on('chat:phase', (p) => { const x = p as { phase: AssistantPhase; detail?: string }; phase = x.phase; phaseDetail = x.detail ?? ''; renderPhase(); });
api.on('connection:status', (c) => { conn = c as ConnectionStatus; renderConn(); if (tab === 'model') refreshConn(); });
api.on('action:confirm', (p) => {
  const req = p as ActionRequest;
  pendingConfirm.set(req.id, req);
  if (tab !== 'chat') go('chat'); else showConfirm(req);
  window.focus();
});
api.on('action:result', (p) => { const r = p as ActionResult; if (!r.ok) toast(r.summary, true); });
api.on('transcript', (p) => { const t = p as { text: string }; if (t.text) toast(`Ouvi: “${t.text}”`); });
api.on('reminder:fired', (p) => { const r = p as Reminder; toast(r.text); });
api.on('settings:changed', (s) => { S = s as Settings; if (tab === 'chat') renderPhase(); });
api.on('panel:tab', (t) => { const target = ALIASES[String(t)] ?? String(t); if (target !== tab) go(target); });
api.on('memory:changed', () => { if (tab === 'memory') go('memory'); });

// ---------------------------------------------------------------- model
let connBody: HTMLElement | null = null;
function refreshConn() {
  if (!connBody || !conn) return;
  const tone = conn.state === 'connected' ? 'ok' : conn.state === 'error' ? 'bad' : conn.state === 'connecting' ? 'info' : '';
  connBody.replaceChildren(h('dl', { class: 'kv' },
    h('dt', {}, 'Status'), h('dd', {}, h('span', { class: `tag ${tone}` }, CONN_LABEL[conn.state])),
    conn.model ? h('dt', {}, 'Modelo') : null, conn.model ? h('dd', { class: 'mono' }, `${conn.model}${conn.usingFallback ? ' (reserva)' : ''}`) : null,
    conn.state !== 'connected' ? h('dt', {}, 'Detalhe') : null, conn.state !== 'connected' ? h('dd', {}, conn.detail) : null,
    conn.provider === 'gemini' ? h('dt', {}, 'Chave de API') : null,
    conn.provider === 'gemini' ? h('dd', {}, conn.keySource === 'secure-store' ? 'Salva na Capri' : conn.keySource === 'environment' ? 'GEMINI_API_KEY' : 'Não definida') : null,
    h('dt', {}, 'Verificado'), h('dd', {}, conn.checkedAt ? new Date(conn.checkedAt).toLocaleTimeString('pt-BR') : '—')));
}
/** Claude through the user's own account: sign-in state, sign in / out, and the model. */
function claudeAccountFields() {
  const state = h('span', { class: 'sub' }, 'Verificando…');
  const actions = h('span', { class: 'row' });
  const render = async () => {
    const s = await api.invoke('claude:status');
    state.textContent = !s.installed ? 'Instale o Claude Code (claude.com/code) e abra isto de novo.' : s.loggedIn ? s.detail : 'Não conectado';
    actions.replaceChildren(
      !s.installed ? '' :
      s.loggedIn ? btn('Sair', async () => { await api.invoke('claude:signout'); await render(); }, 'quiet') :
      btn('Entrar no Claude', async () => {
        state.textContent = 'Abrindo o login do Claude…';
        const r = await api.invoke('claude:signin');
        if (!r.ok) { state.textContent = r.detail ?? 'Não deu para iniciar o login.'; return; }
        state.textContent = 'Faça login no navegador e cole aqui o código que aparecer.';
        const code = h('input', { type: 'text', placeholder: 'Cole o código', autocomplete: 'off', spellcheck: false, 'aria-label': 'Código de login do Claude' }) as HTMLInputElement;
        const submit = btn('Conectar', async () => {
          if (!code.value.trim()) { code.focus(); return; }
          state.textContent = 'Conectando…';
          const s = await api.invoke('claude:code', code.value.trim());
          if (s.loggedIn) { toast('Conectada ao Claude'); go('model'); }
          else { state.textContent = s.detail === 'Não conectado.' ? 'Esse código não funcionou. Clique em Entrar para tentar de novo.' : s.detail; await render(); }
        }, 'primary');
        code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click(); });
        actions.replaceChildren(code, submit);
        code.focus();
      }, 'primary'),
    );
  };
  void render();
  return h('div', {},
    field('Conta', h('span', { class: 'row' }, state, actions)),
    field('Modelo', select('ai.claude.model', 'Modelo do Claude', [['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']])));
}

async function renderModel() {
  secretStatus = await api.invoke('secrets:status');
  conn = await api.invoke('connection:get');
  const sc = h('div', { class: 'scroll' });
  const result = h('div', { class: 'sub' });
  const datalist = h('datalist', { id: 'models' });
  const keyField = (key: 'gemini' | 'openai' | 'anthropic', label: string) => {
    const input = h('input', { type: 'password', placeholder: secretStatus[key] ? 'Salva' : 'Cole a chave', autocomplete: 'off', spellcheck: false, 'aria-label': label });
    return field(label, h('span', { class: 'row' }, input,
      btn('Salvar', async () => { if (!input.value.trim()) return; try { await api.invoke('secrets:set', { key, value: input.value.trim() }); input.value = ''; toast('Chave salva'); go('model'); } catch (e) { result.textContent = (e as Error).message; } }),
      secretStatus[key] ? btn('Remover', async () => { await api.invoke('secrets:delete', key); go(tab); }, 'danger') : null),
      secretStatus._persistent ? undefined : 'Criptografia indisponível: a chave fica só nesta sessão.');
  };
  connBody = h('div', {});
  refreshConn();
  const prov = S.ai.provider;
  sc.append(
    group('Conexão', connBody, h('div', { class: 'row' },
      btn('Verificar', async () => { conn = await api.invoke('connection:check'); renderConn(); refreshConn(); }, '', 'refresh'),
      btn('Testar', async () => { result.textContent = 'Testando…'; const r = await api.invoke('provider:test'); result.textContent = `${r.ok ? 'OK' : 'Falhou'}: ${r.detail}${r.latencyMs !== undefined ? ` · ${r.latencyMs} ms` : ''}`; const list = await api.invoke('provider:models'); datalist.replaceChildren(...list.map((m) => h('option', { value: m }))); })),
    result, datalist),
    group('Provedor',
      field('Provedor', select('ai.provider', 'Provedor', [['claude', 'Claude (sua conta)'], ['gemini', 'Google Gemini'], ['ollama', 'Ollama (local)'], ['openai', 'Compatível com OpenAI'], ['anthropic', 'Anthropic'], ['offline', 'Nenhum (só comandos)']], () => go('model'))),
      prov === 'gemini' ? h('div', {},
        field('Modelo', text('ai.gemini.model', 'Modelo', 'gemini-3.5-flash-lite', 'models')),
        field('Reserva', text('ai.gemini.fallbackModel', 'Modelo reserva', 'nenhum', 'models')),
        field('Raciocínio', select('ai.gemini.thinkingLevel', 'Raciocínio', [['minimal', 'Mínimo'], ['low', 'Baixo'], ['medium', 'Médio'], ['high', 'Alto']])),
        keyField('gemini', 'Chave de API')) : null,
      prov === 'claude' ? claudeAccountFields() : null,
      prov === 'ollama' ? h('div', {}, field('Servidor', text('ai.ollama.baseUrl', 'URL do servidor')), field('Modelo', text('ai.ollama.model', 'Modelo', 'llama3.2', 'models'))) : null,
      prov === 'openai' ? h('div', {}, field('URL base', text('ai.openai.baseUrl', 'URL base')), field('Modelo', text('ai.openai.model', 'Modelo', 'gpt-4o-mini', 'models')), keyField('openai', 'Chave de API')) : null,
      prov === 'anthropic' ? h('div', {}, field('URL base', text('ai.anthropic.baseUrl', 'URL base')), field('Modelo', text('ai.anthropic.model', 'Modelo', 'claude-haiku-5-5', 'models')), keyField('anthropic', 'Chave de API')) : null,
    ),
    group('Respostas',
      field('Tamanho', select('ai.responseLength', 'Tamanho da resposta', [['short', 'Curta'], ['medium', 'Média'], ['long', 'Longa']])),
      prov !== 'gemini' ? field('Criatividade', range('ai.temperature', 'Criatividade', 0, 1.5, 0.05)) : null,
      field('Máx. de tokens', num('ai.maxTokens', 'Máx. de tokens', 32, 8192)),
      field('Turnos de contexto', num('ai.historyTurns', 'Turnos de contexto', 0, 100)),
      field('Tempo limite (s)', num('ai.requestTimeoutSec', 'Tempo limite', 5, 600))),
  );
  view.append(viewHead('Modelo'), sc);
}

// ---------------------------------------------------------------- voice
async function renderVoice() {
  secretStatus = await api.invoke('secrets:status');
  const sc = h('div', { class: 'scroll' });
  const voiceSel = h('select', { 'aria-label': 'Voz', onchange: (e: Event) => void save('voice.systemVoice', (e.target as HTMLSelectElement).value) });
  const fillVoices = () => {
    const vs = speechSynthesis.getVoices();
    voiceSel.replaceChildren(h('option', { value: '' }, 'Automática'), ...vs.map((v) => h('option', { value: v.name, selected: v.name === S.voice.systemVoice }, v.name)));
  };
  fillVoices();
  speechSynthesis.onvoiceschanged = fillVoices;
  const testVoice = () => {
    const u = new SpeechSynthesisUtterance('E aí, choom.');
    u.lang = 'pt-BR';
    const v = speechSynthesis.getVoices().find((x) => x.name === S.voice.systemVoice);
    if (v) u.voice = v;
    u.rate = S.voice.rate; u.pitch = S.voice.pitch; u.volume = S.voice.volume;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  };
  const keyIn = h('input', { type: 'password', placeholder: secretStatus.openaiVoice ? 'Salva' : 'Opcional', autocomplete: 'off', 'aria-label': 'Chave de API de voz' });
  sc.append(
    group('Microfone',
      sw('Permitir microfone', 'voice.micPermission', () => go('voice')),
      field('Fala para texto', select('voice.sttEngine', 'Fala para texto', [['windows', 'Windows (no aparelho, só inglês)'], ['openai', 'Compatível com Whisper (recomendado p/ PT)']], () => go('voice'))),
      S.voice.sttEngine === 'openai' ? h('div', {}, field('Endpoint', text('voice.openaiStt.baseUrl', 'Endpoint de fala para texto')), field('Modelo', text('voice.openaiStt.model', 'Modelo de fala para texto'))) : null,
      field('Palavra de ativação “Ei Capri”', toggle('voice.wakeWord', 'Palavra de ativação'), S.voice.micPermission ? undefined : 'Precisa do microfone.'),
    ),
    group('Fala',
      sw('Falar as respostas', 'voice.ttsEnabled'),
      field('Mecanismo', select('voice.ttsEngine', 'Mecanismo de fala', [['system', 'Vozes do Windows'], ['openai', 'Compatível com OpenAI']], () => go('voice'))),
      S.voice.ttsEngine === 'system' ? field('Voz', h('span', { class: 'row' }, voiceSel, btn('Testar', testVoice))) : h('div', {},
        field('Endpoint', text('voice.openaiTts.baseUrl', 'Endpoint de fala')), field('Modelo', text('voice.openaiTts.model', 'Modelo de fala')), field('Voz', text('voice.openaiTts.voice', 'Nome da voz'))),
      field('Velocidade', range('voice.rate', 'Velocidade', 0.5, 2, 0.05)),
      field('Tom', range('voice.pitch', 'Tom', 0, 2, 0.05)),
      field('Volume', range('voice.volume', 'Volume', 0, 1, 0.05, pct)),
    ),
    (S.voice.ttsEngine === 'openai' || S.voice.sttEngine === 'openai') ? group('Chave de API de voz',
      field('Chave', h('span', { class: 'row' }, keyIn, btn('Salvar', async () => { if (keyIn.value.trim()) { await api.invoke('secrets:set', { key: 'openaiVoice', value: keyIn.value.trim() }); go('voice'); } }),
        secretStatus.openaiVoice ? btn('Remover', async () => { await api.invoke('secrets:delete', 'openaiVoice'); go('voice'); }, 'danger') : null))) : '',
  );
  view.append(viewHead('Voz'), sc);
}

// ---------------------------------------------------------------- character: appearance, behavior, movement
async function renderCharacter() {
  const d = await api.invoke('diagnostics:get');
  const t = d.teleport;
  const sc = h('div', { class: 'scroll' });
  const tp = (where: string, label: string) => btn(label, async () => { const r = await api.invoke('teleport:now', where); if (!r.ok) toast(r.detail, true); }, '', 'teleport');
  sc.append(
    group('Aparência',
      field('Tamanho', range('character.scale', 'Tamanho', 0.4, 2.5, 0.05, pct)),
      field('Opacidade', range('character.opacity', 'Opacidade', 0.2, 1, 0.05, pct)),
      field('Animação', range('character.animationIntensity', 'Intensidade da animação', 0, 1.5, 0.05, pct)),
      field('Taxa de quadros', select('character.fpsCap', 'Taxa de quadros', [['15', '15 fps'], ['30', '30 fps'], ['60', '60 fps'], ['120', '120 fps']], undefined, Number)),
      sw('Efeitos de glitch', 'character.glitchEffects')),
    group('Na área de trabalho',
      sw('Sempre no topo', 'character.alwaysOnTop'),
      field('Clique atravessa', toggle('character.clickThrough', 'Clique atravessa'), 'Ctrl+Alt+C para interagir por 15 s.'),
      sw('Esconder em apps em tela cheia', 'character.hideOnFullscreen'),
      field('Posição', btn('Redefinir', () => save('character.position', null)))),
    group('Movimento',
      field('Teletransportar agora', h('span', { class: 'row' }, tp('auto', 'Qualquer lugar'), tp('near_cursor', 'Até o cursor'), tp('perch', 'Na janela')), undefined, true),
      field('Teletransportar sozinha', toggle('teleport.auto', 'Teletransportar sozinha'), t.auto ? (t.armed ? `Próximo em ${t.nextInSec !== null ? Math.max(1, Math.ceil(t.nextInSec / 60)) : '—'} min` : `Aguardando: ${t.blockedReason ?? 'IA offline'}`) : undefined),
      field('A cada (minutos)', h('span', { class: 'row' }, num('teleport.minMinutes', 'Mínimo de minutos', 1, 240), h('span', { class: 'sub' }, 'a'), num('teleport.maxMinutes', 'Máximo de minutos', 1, 480))),
      sw('Evitar a janela ativa', 'teleport.avoidActiveWindow'),
      sw('Efeitos de teletransporte', 'teleport.effects')),
    group('Comportamento',
      sw('Não perturbe', 'behavior.doNotDisturb'),
      field('Dormir depois de (minutos)', num('behavior.sleepAfterMinutes', 'Dormir depois de', 1, 240)),
      sw('Horário de silêncio', 'behavior.quietHours.enabled'),
      field('Das', h('span', { class: 'row' }, timeIn('behavior.quietHours.start', 'Início do silêncio'), h('span', { class: 'sub' }, 'às'), timeIn('behavior.quietHours.end', 'Fim do silêncio'))),
      sw('Comentários quando ociosa', 'behavior.idleRemarks'),
      S.behavior.idleRemarks ? sw('Falar os comentários em voz alta', 'behavior.proactiveVoice') : null,
      S.behavior.idleRemarks ? field('Comentar a cada (minutos)', num('behavior.remarkIntervalMinutes', 'Intervalo dos comentários', 5, 480)) : null,
      sw('Explorar sozinha enquanto eu estiver fora', 'behavior.explore'),
      S.behavior.explore ? field('Depois de eu ficar parado por (minutos)', num('behavior.exploreAfterMinutes', 'Explorar depois de', 2, 120)) : null),
  );
  view.append(viewHead('Personagem'), sc);
}

// ---------------------------------------------------------------- memory
async function renderMemory() {
  const [mem, notes, rems] = await Promise.all([api.invoke('memory:list'), api.invoke('notes:list'), api.invoke('reminders:list')]);
  const sc = h('div', { class: 'scroll' });
  const add = h('input', { type: 'text', placeholder: 'Algo para lembrar', maxLength: 300, 'aria-label': 'Nova memória', style: 'flex:1;width:auto' });
  const memItem = (m: MemoryItem) => h('div', { class: 'item' },
    h('div', { class: 'txt' }, m.text, h('div', { class: 'sub' }, `${m.source === 'model' ? 'Sugerida pela Capri' : 'Adicionada por você'} · ${new Date(m.createdAt).toLocaleDateString('pt-BR')}`)),
    m.status === 'pending' ? btn('Aprovar', () => api.invoke('memory:approve', m.id).then(() => go('memory')), 'primary') : null,
    btn('Excluir', () => api.invoke('memory:delete', m.id).then(() => go('memory')), 'quiet'));
  sc.append(
    group('Longo prazo',
      sw('Usar nas conversas', 'memory.enabled'),
      h('div', { class: 'list' }, ...mem.map(memItem), mem.length ? null : emptyLine('Nada ainda.')),
      h('div', { class: 'row', style: 'margin:8px 0' }, add,
        btn('Adicionar', async () => { if (add.value.trim()) { try { await api.invoke('memory:add', add.value.trim()); go('memory'); } catch (e) { toast((e as Error).message, true); } } }, '', 'plus'),
        mem.length ? btn('Esquecer tudo', async () => { if (confirm('Apagar todas as memórias?')) { await api.invoke('memory:clear'); go('memory'); } }, 'danger') : null)),
    group('Histórico',
      sw('Salvar conversas', 'privacy.saveHistory'),
      field('Guardar por (dias, 0 = sempre)', num('memory.historyRetentionDays', 'Dias para guardar o histórico', 0, 3650)),
      field('Limpar', btn('Limpar histórico', async () => { if (confirm('Apagar todo o histórico de conversas?')) { await api.invoke('chat:clear'); toast('Histórico apagado'); } }, 'danger', 'trash'))),
    group('Notas', h('div', { class: 'list' }, ...notes.map((n: Note) => h('div', { class: 'item' },
      h('div', { class: 'txt' }, n.title, h('div', { class: 'sub' }, n.body.slice(0, 200))),
      btn('Excluir', () => api.invoke('notes:delete', n.id).then(() => go('memory')), 'quiet'))), notes.length ? null : emptyLine('Nenhuma nota.'))),
    group('Timers e lembretes', h('div', { class: 'list' }, ...rems.map((r: Reminder) => h('div', { class: 'item' },
      h('div', { class: 'txt' }, r.text, h('div', { class: 'sub' }, `${r.kind === 'timer' ? 'Timer' : 'Lembrete'} · ${new Date(r.dueAt).toLocaleString('pt-BR')}`)),
      r.fired ? h('span', { class: 'tag ok' }, 'concluído') : btn('Cancelar', () => api.invoke('reminders:cancel', r.id).then(() => go('memory')), 'quiet'))), rems.length ? null : emptyLine('None.'))),
  );
  view.append(viewHead('Memória'), sc);
}

// ---------------------------------------------------------------- privacy: permissions + data
const TOOL_INFO: Record<ToolName, string> = {
  open_url: 'Abrir páginas da web', launch_app: 'Abrir apps aprovados', search_files: 'Buscar nomes de arquivos',
  create_note: 'Salvar notas', list_notes: 'Ler notas', set_reminder: 'Criar lembretes', start_timer: 'Iniciar timers', cancel_timer: 'Cancelar timers',
  get_time: 'Ver as horas', remember: 'Lembrar fatos', teleport: 'Teletransportar quando pedido', emote: 'Expressões',
  read_screen: 'Ler sua tela', study_timer: 'Timers de estudo', mischief: 'Pegadinhas quando pedido', use_computer: 'Usar seu computador',
};
async function renderPrivacy() {
  const d = await api.invoke('diagnostics:get');
  const sc = h('div', { class: 'scroll' });
  const pol = (t: ToolName) => select(`actions.policies.${t}`, TOOL_INFO[t], [['allow', 'Permitir'], ['confirm', 'Perguntar antes'], ['deny', 'Nunca']]);
  sc.append(
    group('O que a Capri pode fazer', ...TOOL_NAMES.map((t) => field(TOOL_INFO[t], pol(t)))),
    group('Apps aprovados',
      h('div', { class: 'list' }, ...S.actions.approvedApps.map((a, i) => h('div', { class: 'item' }, h('div', { class: 'txt' }, a.name, h('div', { class: 'sub mono' }, a.path)),
        btn('Remover', () => save('actions.approvedApps', S.actions.approvedApps.filter((_, j) => j !== i)).then(() => go('privacy')), 'quiet'))),
        S.actions.approvedApps.length ? null : emptyLine('None.')),
      h('div', { class: 'row', style: 'margin:8px 0' }, btn('Adicionar app', async () => {
        const a = await api.invoke('apps:pick');
        if (a) { await save('actions.approvedApps', [...S.actions.approvedApps, a]); go('privacy'); }
      }, '', 'plus'))),
    group('Pastas de busca',
      h('div', { class: 'list' }, ...S.actions.searchRoots.map((r, i) => h('div', { class: 'item' }, h('div', { class: 'txt mono' }, r),
        btn('Remover', () => save('actions.searchRoots', S.actions.searchRoots.filter((_, j) => j !== i)).then(() => go('privacy')), 'quiet'))),
        S.actions.searchRoots.length ? null : emptyLine('None.')),
      h('div', { class: 'row', style: 'margin:8px 0' }, btn('Adicionar pasta', async () => {
        const f = await api.invoke('folders:pick');
        if (f && !S.actions.searchRoots.includes(f)) { await save('actions.searchRoots', [...S.actions.searchRoots, f]); go('privacy'); }
      }, '', 'folder'))),
    group('Seus dados',
      h('dl', { class: 'kv' },
        h('dt', {}, 'Local'), h('dd', { class: 'mono' }, d.userData),
        h('dt', {}, 'Chaves de API'), h('dd', {}, d.safeStorage ? 'Criptografadas (DPAPI do Windows)' : 'Só na memória'),
        h('dt', {}, 'Áudio'), h('dd', {}, 'Nunca é guardado'),
        h('dt', {}, 'Telemetria'), h('dd', {}, 'Nenhuma')),
      field('Nível de log', select('privacy.logLevel', 'Nível de log', [['error', 'Erros'], ['warn', 'Avisos'], ['info', 'Normal'], ['debug', 'Depuração']])),
      h('div', { class: 'row', style: 'margin:8px 0' }, btn('Abrir pasta', () => api.invoke('app:openDataFolder'), '', 'folder'),
        btn('Apagar todos os dados', async () => {
          if (confirm('Apagar todos os dados da Capri (configurações, chaves, histórico, memória, notas)? Não dá para desfazer.') && confirm('Apagar tudo mesmo?')) await api.invoke('app:resetAll');
        }, 'danger', 'trash'))),
  );
  view.append(viewHead('Privacidade'), sc);
}

// ---------------------------------------------------------------- system: startup, shortcuts, health, logs
async function renderSystem() {
  const sc = h('div', { class: 'scroll' });
  view.append(viewHead('Sistema'), sc);
  sc.append(
    group('Inicialização',
      sw('Abrir ao entrar no Windows', 'startup.launchOnLogin'),
      sw('Notificações de lembretes', 'notifications.reminders'),
      sw('Som das notificações', 'notifications.sound')),
    group('Atalhos', ...([['Abrir chat', 'Ctrl+Alt+Space'], ['Apertar para falar', 'Ctrl+Alt+T'], ['Teletransportar', 'Ctrl+Alt+P'], ['Parar', 'Ctrl+Alt+X'], ['Esconder / mostrar', 'Ctrl+Alt+H'], ['Interagir (clique atravessa)', 'Ctrl+Alt+C']] as const)
      .map(([d, k]) => field(d, h('span', { class: 'kbd' }, k)))),
  );
  const health = group('Saúde', emptyLine('Verificando…'));
  const logs = h('div', { class: 'logs' });
  sc.append(health, group('Logs', logs, h('div', { class: 'row', style: 'margin:8px 0' },
    btn('Atualizar', () => loadLogs(), '', 'refresh'), btn('Copiar', () => navigator.clipboard.writeText(logs.textContent ?? '').then(() => toast('Copiado'))),
    btn('Reiniciar', () => api.invoke('app:restart')), btn('Fechar a Capri', () => api.invoke('app:quit'), 'danger'))));
  const loadLogs = async () => { logs.textContent = (await api.invoke('logs:tail', 200)).join('\n'); logs.scrollTop = logs.scrollHeight; };
  let d: Diagnostics;
  try { d = await api.invoke('diagnostics:get'); } catch (e) { health.replaceChildren(h('span', { class: 'label' }, 'Saúde'), h('div', { class: 'err-text' }, (e as Error).message)); return; }
  const ok = (b: boolean, t: string) => h('span', { class: `tag ${b ? 'ok' : 'bad'}` }, t);
  health.replaceChildren(h('span', { class: 'label' }, 'Saúde'), h('dl', { class: 'kv' },
    h('dt', {}, 'IA'), h('dd', {}, ok(d.connection.state === 'connected', `${CONN_LABEL[d.connection.state]}${d.connection.state === 'connected' ? '' : ` · ${d.connection.detail}`}`)),
    h('dt', {}, 'Reconhecimento de fala'), h('dd', {}, ok(d.speechRecognizer.available, d.speechRecognizer.available ? 'Disponível' : d.speechRecognizer.detail)),
    h('dt', {}, 'Armazenamento de chaves'), h('dd', {}, ok(d.safeStorage, d.safeStorage ? 'Criptografado' : 'Só na memória')),
    h('dt', {}, 'Detecção de tela cheia'), h('dd', {}, ok(d.fullscreenWatcher !== 'unavailable', d.fullscreenWatcher)),
    h('dt', {}, 'Taxa de quadros'), h('dd', { class: 'mono' }, `${d.perf.fps ?? '—'} fps`),
    h('dt', {}, 'Inicialização'), h('dd', { class: 'mono' }, `${d.perf.startupMs} ms`),
    h('dt', {}, 'Memória'), h('dd', { class: 'mono' }, `${d.perf.processes.reduce((s, p) => s + p.memMB, 0)} MB`),
    h('dt', {}, 'Atalhos'), h('dd', { class: 'mono' }, Object.entries(d.shortcuts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'Desligados'),
    h('dt', {}, 'Último fechamento inesperado'), h('dd', {}, d.lastCrash ?? 'Nenhum'),
    h('dt', {}, 'Versão'), h('dd', { class: 'mono' }, `${d.version} · Electron ${d.electron}`),
    h('dt', {}, 'Créditos'), h('dd', {}, 'Versão PT-BR por R3DPR0XY · baseada no Capri Companion (MIT, código aberto)'),
    h('dt', {}, 'Monitores'), h('dd', { class: 'mono' }, d.displays.map((x) => `${x.bounds.width}×${x.bounds.height} @${Math.round(x.scaleFactor * 100)}%`).join(', '))));
  void loadLogs();
}

// ---------------------------------------------------------------- first run
function renderWelcome() {
  const finish = async (provider?: string) => {
    if (provider) await save('ai.provider', provider);
    await save('firstRunComplete', true);
    go(provider && provider !== 'offline' && provider !== 'gemini' ? 'model' : provider === 'gemini' ? 'model' : 'chat');
  };
  const choice = (title: string, sub: string, provider: string) => h('div', { class: 'choice', role: 'button', tabIndex: 0, onclick: () => finish(provider), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void finish(provider); } },
    h('b', {}, title), h('span', { class: 'sub' }, sub), h('span', { class: 'go' }, '→'));
  view.append(h('div', { class: 'scroll' }, h('div', { class: 'welcome' },
    h('h2', {}, 'Escolha o cérebro dela'),
    choice('Claude', 'Entre com a sua conta Claude', 'claude'),
    choice('Google Gemini', 'Precisa de uma chave de API', 'gemini'),
    choice('Ollama', 'Local, neste PC (mais privado)', 'ollama'),
    choice('Outra API', 'Compatível com OpenAI ou Anthropic', 'openai'),
    choice('Sem IA', 'Só comandos', 'offline'),
    h('div', { class: 'sub', style: 'margin-top:12px;text-align:center' }, 'Capri PT-BR · versão por R3DPR0XY · projeto de fã não oficial'))));
}

const RENDER: Record<string, () => unknown> = {
  chat: renderChat, model: renderModel, voice: renderVoice, character: renderCharacter, memory: renderMemory, privacy: renderPrivacy, system: renderSystem, welcome: renderWelcome,
};

// ---------------------------------------------------------------- boot
document.getElementById('closeBtn')!.append(icon('close'));
document.getElementById('closeBtn')!.addEventListener('click', () => api.invoke('panel:close'));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (phase === 'thinking' || phase === 'speaking') void api.invoke('chat:stop');
  else void api.invoke('panel:close');
});
(async () => {
  S = await api.invoke('settings:get');
  conn = await api.invoke('connection:get');
  renderConn();
  renderPhase();
  if (!S.firstRunComplete && tab !== 'welcome') tab = 'welcome';
  go(tab);
})();
