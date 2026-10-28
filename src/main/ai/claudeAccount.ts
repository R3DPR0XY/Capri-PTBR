// Claude through the user's own Claude account: no API key. Capri runs the Claude Code CLI (`claude -p`),
// which is signed in to the user's Claude subscription, as a plain one-turn conversation: no tools, no
// MCP servers, no slash commands, none of the user's Claude Code settings, hooks or plugins, and an
// empty working folder, so nothing but her persona and the chat reaches the model.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderError, type GenOptions, type LLMMessage, type LLMProvider } from './providers';

/** The Claude Code executable, wherever the user installed it (npm or the native installer). */
export function findClaude(): string | null {
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const candidates = [
    process.env.CAPRI_CLAUDE_PATH,
    path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

export interface ClaudeStatus { installed: boolean; loggedIn: boolean; account?: string; detail: string }

/** Whether the CLI is installed and signed in (`claude auth status --json`). */
export function claudeStatus(): Promise<ClaudeStatus> {
  const exe = findClaude();
  if (!exe) return Promise.resolve({ installed: false, loggedIn: false, detail: 'O Claude Code não está instalado.' });
  return new Promise((resolve) => {
    execFile(exe, ['auth', 'status', '--json'], { timeout: 20_000, windowsHide: true }, (err, stdout) => {
      try {
        const j = JSON.parse(String(stdout)) as { loggedIn?: boolean; email?: string; account?: { email?: string }; subscriptionType?: string };
        const account = j.email ?? j.account?.email;
        resolve({ installed: true, loggedIn: !!j.loggedIn, account, detail: j.loggedIn ? `Conectado${account ? ` como ${account}` : ''}` : 'Não conectado.' });
      } catch {
        resolve({ installed: true, loggedIn: false, detail: err ? `Não deu para verificar o login: ${err.message.slice(0, 120)}` : 'Não deu para verificar o login.' });
      }
    });
  });
}

/** Open Claude's own sign-in (browser) in a visible window. The app polls claudeStatus() until it's done. */
// Claude's sign-in shows a code in the browser that the CLI then waits for on stdin, so the CLI runs
// inside the app: we pull the sign-in link from its output, open it, and hand it the code the user pastes.
let login: ReturnType<typeof spawn> | null = null;

/** Start sign-in. Resolves with the sign-in link once the CLI prints it (the caller opens it). */
export function claudeSignIn(): Promise<{ ok: boolean; url?: string; detail?: string }> {
  const exe = findClaude();
  if (!exe) return Promise.resolve({ ok: false, detail: 'O Claude Code não está instalado.' });
  login?.kill();
  const child = spawn(exe, ['auth', 'login', '--claudeai'], { cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' } });
  login = child;
  return new Promise((resolve) => {
    let out = '';
    const timer = setTimeout(() => resolve({ ok: false, detail: 'O Claude Code não iniciou o login.' }), 20_000);
    const onData = (b: Buffer) => {
      out += b.toString('utf8');
      const m = /https:\/\/\S+oauth\/authorize\S+/.exec(out);
      if (m) { clearTimeout(timer); resolve({ ok: true, url: m[0] }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', () => { if (login === child) login = null; });
  });
}

/** Give the waiting CLI the code from the browser, then report whether sign-in worked. */
export async function claudeSubmitCode(code: string): Promise<ClaudeStatus> {
  const child = login;
  if (!child || child.exitCode !== null) return { installed: true, loggedIn: false, detail: 'O login expirou. Clique em Entrar de novo.' };
  child.stdin?.write(code.trim() + '\n');
  await new Promise<void>((r) => { const t = setTimeout(r, 30_000); child.once('close', () => { clearTimeout(t); r(); }); });
  if (child.exitCode === null) child.kill();
  return claudeStatus();
}

export function claudeSignOut(): Promise<void> {
  const exe = findClaude();
  return new Promise((resolve) => { if (!exe) return resolve(); execFile(exe, ['auth', 'logout'], { timeout: 20_000, windowsHide: true }, () => resolve()); });
}

/** The chat as one prompt: the CLI takes a single message, so earlier turns ride along as a transcript. */
export function transcript(messages: LLMMessage[]): string {
  const turns = messages.filter((m) => m.role !== 'system');
  if (turns.length === 1) return turns[0].content;
  const last = turns[turns.length - 1];
  const before = turns.slice(0, -1).map((m) => `${m.role === 'user' ? 'User' : 'Capri'}: ${m.content}`).join('\n\n');
  return `Conversation so far:\n\n${before}\n\nUser: ${last.content}\n\nReply to the user's last message as Capri.`;
}

export class ClaudeAccountProvider implements LLMProvider {
  readonly name = 'claude';
  readonly local = false;
  constructor(private model: string) {}

  async *stream(messages: LLMMessage[], o: GenOptions): AsyncGenerator<string> {
    const exe = findClaude();
    if (!exe) throw new ProviderError('O Claude Code não está instalado. Instale em claude.com/code e entre na aba Modelo.', 'config');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-claude-'));
    const sysFile = path.join(dir, 'system.txt');
    fs.writeFileSync(sysFile, messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'));
    const args = [
      '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--model', this.model, '--system-prompt-file', sysFile,
      '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
      '--no-session-persistence', '--max-turns', '1',
    ];
    const child = spawn(exe, args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => { if (!child.killed) child.kill(); };
    o.signal.addEventListener('abort', kill, { once: true });
    child.stdin.end(transcript(messages));

    // stdout → lines → events, handed to the generator through a small queue
    const queue: string[] = [];
    let done = false, failure: ProviderError | null = null, wake: (() => void) | null = null, buf = '', stderr = '', gotText = false;
    const push = () => { const w = wake; wake = null; w?.(); };
    child.stdout.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let ev: { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } }; message?: { content?: { type?: string; text?: string }[] }; is_error?: boolean; result?: string; subtype?: string; api_error_status?: number };
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta' && ev.event.delta.text) {
          queue.push(ev.event.delta.text); gotText = true; push();
        } else if (ev.type === 'assistant' && !gotText) {
          // no partial deltas came through: take the whole message
          const text = (ev.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
          if (text) { queue.push(text); gotText = true; push(); }
        } else if (ev.type === 'result' && !ev.is_error && !gotText && ev.result) {
          queue.push(ev.result); gotText = true; push();
        } else if (ev.type === 'result' && ev.is_error) {
          const msg = `${ev.result ?? ''} ${ev.subtype ?? ''}`;
          failure = /log ?in|auth|401|403|credential/i.test(msg) || ev.api_error_status === 401
            ? new ProviderError('Não conectado ao Claude. Entre em Modelo → Claude.', 'auth')
            : /rate|limit|429|usage/i.test(msg) || ev.api_error_status === 429
              ? new ProviderError('Seu limite de uso do Claude acabou por enquanto. Tente mais tarde.', 'rate_limit')
              : new ProviderError(`O Claude não conseguiu responder: ${msg.trim().slice(0, 160) || 'erro desconhecido'}`, 'server');
          push();
        }
      }
    });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on('error', (e) => { failure = new ProviderError(`Não deu para iniciar o Claude Code: ${e.message}`, 'config'); done = true; push(); });
    child.on('close', (code) => {
      if (!failure && !gotText && code !== 0 && !o.signal.aborted) {
        failure = /log ?in|auth/i.test(stderr) ? new ProviderError('Não conectado ao Claude. Entre em Modelo → Claude.', 'auth') : new ProviderError(`O Claude Code fechou (${code}). ${stderr.trim().slice(0, 160)}`, 'server');
      }
      done = true; push();
    });

    let timer = setTimeout(kill, o.timeoutMs);
    try {
      for (;;) {
        if (o.signal.aborted) throw new ProviderError('aborted', 'aborted');
        if (queue.length) { clearTimeout(timer); timer = setTimeout(kill, o.timeoutMs); yield queue.shift()!; continue; }
        if (failure) throw failure;
        if (done) { if (!gotText && !o.signal.aborted) throw new ProviderError('O Claude não respondeu (tempo esgotado?).', 'timeout'); return; }
        await new Promise<void>((r) => { wake = r; });
      }
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', kill);
      kill();
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  async test() {
    const t0 = Date.now();
    const s = await claudeStatus();
    return { ok: s.loggedIn, detail: s.installed ? s.detail : 'O Claude Code não está instalado.', latencyMs: Date.now() - t0 };
  }

  async listModels() { return ['sonnet', 'opus', 'haiku']; }
}
