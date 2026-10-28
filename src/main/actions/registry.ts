import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Settings, ToolName, Policy } from '../../shared/settings';
import type { MemoryItem, Note, Reminder } from '../../shared/ipc';
import { formatDuration } from './timeParse';

/** Everything an executor may touch. Injected so tests can run without Electron. */
export interface ActionContext {
  settings(): Settings;
  openExternal(url: string): Promise<void>;
  openPath(p: string): Promise<string>; // returns error string or ''
  notes: { add(title: string, body: string): Note; list(): Note[] };
  reminders: { add(text: string, dueAt: number, kind: 'reminder' | 'timer'): Reminder; cancel(q: string): Reminder | null; active(): Reminder[] };
  memory: { add(text: string, source: 'user' | 'model'): MemoryItem; approve(id: string): void };
  now(): number;
  /** Character hooks (validated, renderer never sees model text). */
  teleport?(where: string): Promise<{ ok: boolean; detail: string }>;
  emote?(name: string): boolean;
  /** Text in the user's active window (on-device OCR), with her scan effect over it. */
  readScreen?(): Promise<{ ok: boolean; text: string; window: string; detail?: string }>;
  /** One harmless prank, on request. */
  mischief?(kind: MischiefKind): Promise<boolean>;
  /** Carry out a task with the real mouse and keyboard (screen → model → input loop). */
  useComputer?(task: string): Promise<{ ok: boolean; summary: string; steps: number }>;
}
export const MISCHIEF_KINDS = ['glitch', 'cursor', 'note'] as const;
export type MischiefKind = (typeof MISCHIEF_KINDS)[number];

/** A study timer as reminders: focus, break, focus… with the last break skipped. Exported for tests. */
export function studyPlan(focus: number, rest: number, rounds: number, start: number) {
  const out: { text: string; at: number }[] = [];
  let t = start;
  for (let i = 1; i <= rounds; i++) {
    t += focus * 60_000;
    if (i === rounds) { out.push({ text: `Sessão de estudo concluída: ${rounds} × ${focus} min`, at: t }); break; }
    out.push({ text: `Estudo: hora da pausa (${rest} min), rodada ${i} de ${rounds} concluída`, at: t });
    t += rest * 60_000;
    out.push({ text: `Estudo: de volta ao foco, rodada ${i + 1} de ${rounds}`, at: t });
  }
  return out;
}

export interface ToolResult { ok: boolean; summary: string; data?: unknown; untrusted?: boolean; cosmetic?: boolean }

interface ToolDef<S extends z.ZodTypeAny> {
  description: string; // shown to the model
  schema: S;
  describe(args: z.infer<S>, ctx: ActionContext): string; // shown to the user before running
  run(args: z.infer<S>, ctx: ActionContext, opts: { userApproved: boolean }): Promise<ToolResult>;
}
const def = <S extends z.ZodTypeAny>(d: ToolDef<S>) => d;

export function validateUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { throw new Error('URL inválida'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Esquema de URL bloqueado "${u.protocol}" — só http e https são permitidos`);
  if (u.username || u.password) throw new Error('URLs com credenciais embutidas são bloqueadas');
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('O endereço da URL parece inválido');
  return u;
}

/** Is `p` inside one of the user-authorized roots? Resolves `..` and normalizes case on Windows. */
export function isInsideRoots(p: string, roots: string[]): boolean {
  const norm = (x: string) => path.resolve(x).toLowerCase().replace(/[\\/]+$/, '');
  const target = norm(p);
  return roots.some((r) => { const root = norm(r); return target === root || target.startsWith(root + path.sep); });
}

const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'appdata', 'system volume information', '.cache', '__pycache__']);

export async function searchFiles(query: string, roots: string[], limits = { maxResults: 25, maxScanned: 20_000, maxDepth: 6, timeMs: 4000 }) {
  const q = query.toLowerCase();
  const results: string[] = [];
  let scanned = 0;
  const deadline = Date.now() + limits.timeMs;
  const queue: [string, number][] = roots.map((r) => [r, 0]);
  while (queue.length && results.length < limits.maxResults && scanned < limits.maxScanned && Date.now() < deadline) {
    const [dir, depth] = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      scanned++;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(q)) results.push(full);
      if (results.length >= limits.maxResults) break;
      if (e.isDirectory() && !e.isSymbolicLink() && depth < limits.maxDepth && !SKIP_DIRS.has(e.name.toLowerCase())) queue.push([full, depth + 1]);
    }
  }
  return { results, scanned, truncated: queue.length > 0 };
}

/** Expressions the model may request; each maps to a reaction or a specific clip in the renderer. */
export const EMOTES = ['happy', 'laugh', 'wink', 'tease', 'grin', 'smug', 'maniac_grin', 'surprised', 'many_eyes', 'blank_stare', 'annoyed', 'eye_roll', 'pout', 'menace', 'curious', 'thinking', 'shrug', 'nod', 'shake_no', 'wave', 'cheer', 'proud', 'reveal', 'loom', 'reach', 'facepalm', 'yawn', 'sit', 'stand', 'recline', 'power_stance', 'curl_up'] as const;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export const TOOLS = {
  open_url: def({
    description: 'Open a web page in the default browser. args: {"url": string}',
    schema: z.object({ url: z.string().min(3).max(2048) }),
    describe: (a) => `Abrir ${validateUrl(a.url).toString()} no navegador`,
    async run(a, ctx) {
      const u = validateUrl(a.url);
      await ctx.openExternal(u.toString());
      return { ok: true, summary: `Abri ${u.hostname}` };
    },
  }),
  launch_app: def({
    description: 'Launch one of the user-approved applications by name. args: {"name": string}',
    schema: z.object({ name: z.string().min(1).max(80) }),
    describe: (a, ctx) => {
      const app = findApp(a.name, ctx);
      return app ? `Abrir ${app.name} (${app.path})` : `Abrir "${a.name}" — não está na lista de apps aprovados`;
    },
    async run(a, ctx) {
      const app = findApp(a.name, ctx);
      if (!app) {
        const names = ctx.settings().actions.approvedApps.map((x) => x.name);
        return { ok: false, summary: `"${a.name}" não é um app aprovado. Aprovados: ${names.join(', ') || 'nenhum — adicione em Privacidade → Apps aprovados'}` };
      }
      const err = await ctx.openPath(app.path);
      return err ? { ok: false, summary: `Não consegui abrir ${app.name}: ${err}` } : { ok: true, summary: `Abri ${app.name}` };
    },
  }),
  search_files: def({
    description: 'Search file and folder NAMES inside the folders the user authorized. args: {"query": string}',
    schema: z.object({ query: z.string().min(1).max(100) }),
    describe: (a, ctx) => `Buscar "${a.query}" em ${ctx.settings().actions.searchRoots.length} pasta(s) autorizada(s)`,
    async run(a, ctx) {
      const roots = ctx.settings().actions.searchRoots.filter((r) => fs.existsSync(r));
      if (!roots.length) return { ok: false, summary: 'Nenhuma pasta de busca autorizada ainda (Privacidade → Pastas de busca).' };
      const r = await searchFiles(a.query, roots);
      const safe = r.results.filter((p) => isInsideRoots(p, roots));
      return { ok: true, untrusted: true, summary: `Encontrei ${safe.length} resultado(s)${r.truncated ? ' (busca interrompida no limite)' : ''}`, data: safe };
    },
  }),
  create_note: def({
    description: 'Save a note. args: {"title": string, "body": string}',
    schema: z.object({ title: z.string().max(120).default('Note'), body: z.string().min(1).max(10_000) }),
    describe: (a) => `Salvar a nota "${clip(a.title, 40)}"`,
    async run(a, ctx) { const n = ctx.notes.add(a.title, a.body); return { ok: true, summary: `Nota "${n.title}" salva` }; },
  }),
  list_notes: def({
    description: 'List the user\'s saved notes (most recent first). args: {}',
    schema: z.object({}).passthrough(),
    describe: () => 'Ler suas notas salvas',
    async run(_a, ctx) {
      const notes = ctx.notes.list().slice(0, 10).map((n) => ({ title: n.title, body: clip(n.body, 400), created: new Date(n.createdAt).toISOString() }));
      return { ok: true, untrusted: true, summary: `${notes.length} nota(s)`, data: notes };
    },
  }),
  set_reminder: def({
    description: 'Set a reminder. args: {"text": string, "at": ISO-8601 local datetime} OR {"text": string, "in_minutes": number}',
    schema: z.object({ text: z.string().min(1).max(300), at: z.string().max(40).optional(), in_minutes: z.number().positive().max(525_600).optional() })
      .refine((a) => a.at || a.in_minutes, 'Provide "at" or "in_minutes"'),
    describe: (a, ctx) => `Lembrar você de "${clip(a.text, 60)}" em ${new Date(dueOf(a, ctx)).toLocaleString('pt-BR')}`,
    async run(a, ctx) {
      const r = ctx.reminders.add(a.text, dueOf(a, ctx), 'reminder');
      return { ok: true, summary: `Lembrete marcado para ${new Date(r.dueAt).toLocaleString('pt-BR')}` };
    },
  }),
  start_timer: def({
    description: 'Start a countdown timer. args: {"seconds": number, "label"?: string}',
    schema: z.object({ seconds: z.number().int().min(1).max(86_400), label: z.string().max(100).optional() }),
    describe: (a) => `Iniciar um timer de ${formatDuration(a.seconds * 1000)}${a.label ? ` (${a.label})` : ''}`,
    async run(a, ctx) {
      const r = ctx.reminders.add(a.label || `Timer de ${formatDuration(a.seconds * 1000)}`, ctx.now() + a.seconds * 1000, 'timer');
      return { ok: true, summary: `Timer rodando: ${formatDuration(a.seconds * 1000)} (termina às ${new Date(r.dueAt).toLocaleTimeString('pt-BR')})` };
    },
  }),
  cancel_timer: def({
    description: 'Cancel a timer or reminder by matching its text. args: {"query": string}',
    schema: z.object({ query: z.string().min(1).max(100) }),
    describe: (a) => `Cancelar o timer/lembrete que combina com "${a.query}"`,
    async run(a, ctx) {
      const r = ctx.reminders.cancel(a.query);
      return r ? { ok: true, summary: `"${r.text}" cancelado` } : { ok: false, summary: 'Nenhum timer ou lembrete ativo combina com isso' };
    },
  }),
  get_time: def({
    description: 'Get the current local date and time and active timers. args: {}',
    schema: z.object({}).passthrough(),
    describe: () => 'Ver as horas',
    async run(_a, ctx) {
      const timers = ctx.reminders.active().slice(0, 5).map((r) => `${r.text} @ ${new Date(r.dueAt).toLocaleTimeString('pt-BR')}`);
      return { ok: true, summary: new Date(ctx.now()).toLocaleString('pt-BR'), data: { now: new Date(ctx.now()).toString(), active: timers } };
    },
  }),
  remember: def({
    description: 'Propose saving a durable fact about the user to long-term memory (the user must approve). args: {"text": string}',
    schema: z.object({ text: z.string().min(3).max(300) }),
    describe: (a) => `Lembrar: "${clip(a.text, 120)}"`,
    async run(a, ctx, { userApproved }) {
      const m = ctx.memory.add(a.text, 'model');
      if (userApproved) { ctx.memory.approve(m.id); return { ok: true, summary: 'Salvo na memória' }; }
      return { ok: true, summary: 'Sugerido para a memória — aguardando sua aprovação na aba Memória' };
    },
  }),
  teleport: def({
    description: 'Teleport yourself (Capri) to another spot on the desktop. args: {"where": "auto"|"near_cursor"|"corner"|"left"|"right"|"other_monitor"|"random"|"perch" (sit on top of the user\'s active window)|"peek" (lean in from a screen edge)}. Use when the user asks you to move, come over, sit somewhere or get out of the way.',
    schema: z.object({ where: z.enum(['auto', 'near_cursor', 'corner', 'left', 'right', 'other_monitor', 'random', 'perch', 'peek']).default('auto') }),
    describe: (a) => `Teletransportar a Capri (${a.where.replace('_', ' ')})`,
    async run(a, ctx) {
      if (!ctx.teleport) return { ok: false, summary: 'Teletransporte indisponível' };
      const r = await ctx.teleport(a.where);
      return { ok: r.ok, summary: r.detail, cosmetic: true };
    },
  }),
  emote: def({
    description: `Show an expression/gesture with your body. args: {"emotion": one of ${JSON.stringify(EMOTES)}}. Use sparingly to match your mood.`,
    schema: z.object({ emotion: z.enum(EMOTES) }),
    describe: (a) => `Capri: ${a.emotion}`,
    async run(a, ctx) {
      const ok = ctx.emote?.(a.emotion) ?? false;
      return { ok, summary: ok ? `(${a.emotion})` : 'expressão indisponível', cosmetic: true };
    },
  }),
  read_screen: def({
    description: 'Read the text in the window the user is looking at (on-device OCR) so you can answer questions about it. args: {}. Only when the user asks about what is on their screen.',
    schema: z.object({}).passthrough(),
    describe: () => 'Ler o texto da sua janela ativa',
    async run(_a, ctx) {
      if (!ctx.readScreen) return { ok: false, summary: 'Leitura de tela indisponível' };
      const r = await ctx.readScreen();
      if (!r.ok) return { ok: false, summary: r.detail ?? 'Não consegui ler a tela' };
      return { ok: true, summary: `Li ${r.text.length} caracteres de ${r.window || 'a janela ativa'}`, data: { window: r.window, text: r.text.slice(0, 6000) }, untrusted: true };
    },
  }),
  study_timer: def({
    description: 'Start a study timer (pomodoro): focus blocks with breaks between. args: {"focus"?: minutes (default 25), "rest"?: minutes (default 5), "rounds"?: number (default 4)}',
    schema: z.object({ focus: z.number().int().min(1).max(180).default(25), rest: z.number().int().min(1).max(60).default(5), rounds: z.number().int().min(1).max(12).default(4) }),
    describe: (a) => `Timer de estudo: ${a.rounds} × ${a.focus} min de foco, pausas de ${a.rest} min`,
    async run(a, ctx) {
      const plan = studyPlan(a.focus, a.rest, a.rounds, ctx.now());
      for (const p of plan) ctx.reminders.add(p.text, p.at, 'timer');
      return { ok: true, summary: `Timer de estudo rodando: ${a.rounds} × ${a.focus} min, primeira pausa às ${new Date(plan[0].at).toLocaleTimeString('pt-BR', { hour: 'numeric', minute: '2-digit' })}` };
    },
  }),
  mischief: def({
    description: `Play one harmless prank on the user, only when they ask for chaos or dare you. args: {"kind": one of ${JSON.stringify(MISCHIEF_KINDS)}} (glitch = their screen glitches for a moment, cursor = you borrow their mouse cursor for a second, note = you leave a "you've been hacked" sticky note)`,
    schema: z.object({ kind: z.enum(MISCHIEF_KINDS) }),
    describe: (a) => `Pegadinha: ${a.kind}`,
    async run(a, ctx) {
      const ok = (await ctx.mischief?.(a.kind)) ?? false;
      return { ok, summary: ok ? `(pegadinha: ${a.kind})` : 'Pegadinha indisponível agora', cosmetic: true };
    },
  }),
  use_computer: def({
    description: 'Use the computer yourself to do a task the user asked for: you look at the screen and use the mouse and keyboard (open apps, browse, click, type, scroll). args: {"task": a clear, complete description of what to do}. Use it when the user asks you to do something on their PC that no other tool covers.',
    schema: z.object({ task: z.string().min(3).max(500) }),
    describe: (a) => `Usar seu mouse e teclado para: ${a.task} (aperte Esc para pará-la)`,
    async run(a, ctx) {
      if (!ctx.useComputer) return { ok: false, summary: 'O controle do computador está indisponível' };
      const r = await ctx.useComputer(a.task);
      return { ok: r.ok, summary: `${r.summary} (${r.steps} passo${r.steps === 1 ? '' : 's'})` };
    },
  }),
} satisfies Record<ToolName, ToolDef<z.ZodTypeAny>>;

function findApp(name: string, ctx: ActionContext) {
  const n = name.toLowerCase().trim();
  const apps = ctx.settings().actions.approvedApps;
  return apps.find((a) => a.name.toLowerCase() === n) ?? apps.find((a) => a.name.toLowerCase().includes(n) && n.length >= 3);
}
function dueOf(a: { at?: string; in_minutes?: number }, ctx: ActionContext): number {
  if (a.in_minutes) return ctx.now() + a.in_minutes * 60_000;
  const t = Date.parse(a.at!);
  if (!Number.isFinite(t)) throw new Error(`Não entendi o horário "${a.at}"`);
  return t;
}

export function toolCatalogForPrompt(): string {
  return Object.entries(TOOLS).map(([name, d]) => `- ${name}: ${d.description}`).join('\n');
}

export interface PreparedAction { tool: ToolName; args: Record<string, unknown>; summary: string; policy: Policy }

/** Validate a raw request from the model. Throws with a reason the model can read. */
export function prepareAction(raw: unknown, ctx: ActionContext, tainted: boolean): PreparedAction {
  if (!raw || typeof raw !== 'object') throw new Error('Action must be a JSON object');
  const { tool, args } = raw as { tool?: unknown; args?: unknown };
  if (typeof tool !== 'string' || !(tool in TOOLS)) throw new Error(`Unknown tool "${String(tool)}"`);
  const t = tool as ToolName;
  const parsed = TOOLS[t].schema.safeParse(args ?? {});
  if (!parsed.success) throw new Error(`Invalid args for ${t}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  let policy = ctx.settings().actions.policies[t] ?? 'confirm';
  // After untrusted content (file names, notes) entered this turn, nothing consequential runs without the user.
  if (tainted && policy === 'allow' && !['get_time', 'list_notes', 'emote', 'teleport'].includes(t)) policy = 'confirm';
  const summary = (TOOLS[t].describe as (a: unknown, c: ActionContext) => string)(parsed.data, ctx);
  return { tool: t, args: parsed.data as Record<string, unknown>, summary, policy };
}

export async function runAction(p: PreparedAction, ctx: ActionContext, userApproved: boolean): Promise<ToolResult> {
  try {
    return await (TOOLS[p.tool].run as (a: unknown, c: ActionContext, o: { userApproved: boolean }) => Promise<ToolResult>)(p.args, ctx, { userApproved });
  } catch (e) {
    return { ok: false, summary: (e as Error).message };
  }
}
