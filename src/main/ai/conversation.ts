import type { Settings } from '../../shared/settings';
import type { ActionRequest, ActionResult, AssistantPhase, CharacterCue, ChatMessage, MemoryItem } from '../../shared/ipc';
import type { LLMMessage, LLMProvider } from './providers';
import { friendlyError, ProviderError } from './providers';
import { ActionStreamParser, SentenceChunker, speakable } from './actionStream';
import { buildSystemPrompt } from './persona';
import { prepareAction, runAction, type ActionContext } from '../actions/registry';
import { newId } from '../store/jsonFile';
import type { Logger } from '../log';

export interface ConversationDeps {
  settings(): Settings;
  provider(): LLMProvider;
  history: { append(m: ChatMessage): void; recent(n: number): ChatMessage[] };
  memories(): MemoryItem[];
  actionCtx: ActionContext;
  emit(channel: 'chat:delta' | 'chat:done' | 'chat:message' | 'chat:phase' | 'action:result', payload: unknown): void;
  cue(c: CharacterCue): void;
  confirm(req: ActionRequest): Promise<boolean>;
  log: Logger;
  onProviderResult?(ok: boolean, provider: string, err?: unknown): void;
}

const MAX_ACTION_ROUNDS = 3;
const MAX_ACTIONS_PER_ROUND = 4;

export class Conversation {
  private ctrl: AbortController | null = null;
  private turn: Promise<void> | null = null;
  phase: AssistantPhase = 'idle';

  constructor(private d: ConversationDeps) {}

  get busy() { return !!this.ctrl; }

  private setPhase(p: AssistantPhase, detail?: string) {
    this.phase = p;
    this.d.emit('chat:phase', { phase: p, detail });
    this.d.cue({ type: 'phase', phase: p });
  }

  /** Stop generation and speech. Safe to call any time. */
  stop() {
    this.ctrl?.abort();
    this.d.cue({ type: 'stopSpeech' });
    this.onSpeechCleared();
  }

  async send(text: string, opts: { viaVoice?: boolean } = {}): Promise<string> {
    const clean = text.replace(/\u0000/g, '').trim().slice(0, 20_000);
    if (!clean) throw new Error('Empty message');
    if (this.ctrl) { this.stop(); await this.turn?.catch(() => {}); }
    const userMsg: ChatMessage = { id: newId('u'), role: 'user', content: clean, ts: Date.now() };
    this.d.history.append(userMsg);
    this.d.emit('chat:message', { message: userMsg });
    const replyId = newId('a');
    this.turn = this.run(clean, replyId, !!opts.viaVoice);
    return replyId;
  }

  /** Await the in-flight turn (tests, shutdown). */
  async settle() { await this.turn?.catch(() => {}); }

  private buildMessages(userText: string): LLMMessage[] {
    const s = this.d.settings();
    const past = this.d.history
      .recent(s.ai.historyTurns * 2 + 1)
      .slice(0, -1) // exclude the user message we just appended
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.meta?.error)
      .map<LLMMessage>((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    // providers like Anthropic require alternating roles beginning with user
    while (past.length && past[0].role !== 'user') past.shift();
    return [{ role: 'system', content: buildSystemPrompt(s, this.d.memories()) }, ...past, { role: 'user', content: userText }];
  }

  private async run(userText: string, replyId: string, viaVoice: boolean) {
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const s = this.d.settings();
    const speak = s.voice.ttsEnabled;
    const messages = this.buildMessages(userText);
    let visible = '';
    let tainted = false;
    let utterance = 0;
    const provider = this.d.provider();
    this.setPhase('thinking');
    this.d.cue({ type: 'react', reaction: viaVoice ? 'nod' : 'curious' });
    try {
      for (let round = 0; round <= MAX_ACTION_ROUNDS; round++) {
        const parser = new ActionStreamParser();
        const chunker = new SentenceChunker();
        const actions: { parsed: unknown; error?: string }[] = [];
        let roundText = '';
        const handle = (pieces: ReturnType<ActionStreamParser['push']>) => {
          for (const p of pieces) {
            if (p.type === 'text') {
              roundText += p.text;
              visible += p.text;
              this.d.emit('chat:delta', { messageId: replyId, delta: p.text });
              if (speak) for (const sentence of chunker.push(p.text)) this.say(replyId, utterance++, sentence);
            } else actions.push(p);
          }
        };
        const stream = provider.stream(messages, {
          temperature: s.ai.temperature, maxTokens: s.ai.maxTokens, timeoutMs: s.ai.requestTimeoutSec * 1000, signal: ctrl.signal,
        });
        for await (const chunk of stream) {
          if (ctrl.signal.aborted) throw new ProviderError('aborted', 'aborted');
          handle(parser.push(chunk));
        }
        handle(parser.end());
        if (speak) for (const sentence of chunker.end()) this.say(replyId, utterance++, sentence);
        if (!actions.length) break;
        if (round === MAX_ACTION_ROUNDS) { this.d.log.warn('action round limit reached'); break; }

        const results: string[] = [];
        let allCosmetic = true;
        for (const a of actions.slice(0, MAX_ACTIONS_PER_ROUND)) {
          const r = await this.execute(a, tainted, ctrl.signal);
          if (r.untrusted) tainted = true;
          if (!r.cosmetic) allCosmetic = false;
          results.push(r.line);
        }
        if (actions.length > MAX_ACTIONS_PER_ROUND) results.push(`- (ignored ${actions.length - MAX_ACTIONS_PER_ROUND} extra actions: limit ${MAX_ACTIONS_PER_ROUND} per reply)`);
        // pure body language (emote/teleport) that succeeded needs no follow-up model round
        if (allCosmetic && actions.length <= MAX_ACTIONS_PER_ROUND) break;
        messages.push({ role: 'assistant', content: roundText || '(requested actions)' });
        messages.push({ role: 'user', content: `[action results]\n${results.join('\n')}` });
        if (!visible.endsWith('\n') && visible) { visible += '\n'; this.d.emit('chat:delta', { messageId: replyId, delta: '\n' }); }
        this.setPhase('thinking');
      }
      this.d.onProviderResult?.(true, provider.name);
      const msg: ChatMessage = { id: replyId, role: 'assistant', content: visible.trim(), ts: Date.now(), meta: { provider: provider.name } };
      this.d.history.append(msg);
      this.d.emit('chat:done', { message: msg });
      // with speech queued, the character's speech events move the phase to speaking → idle
      if (!speak || utterance === 0 || this.pendingSpeech === 0) {
        if (this.phase !== 'speaking') this.setPhase('idle');
      }
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e instanceof ProviderError && e.kind === 'aborted');
      const err = aborted ? undefined : friendlyError(e);
      if (!aborted) { this.d.log.warn('turn failed', { provider: provider.name, error: e as Error }); this.d.onProviderResult?.(false, provider.name, e); }
      const content = visible.trim() || (aborted ? '' : err!);
      const msg: ChatMessage = { id: replyId, role: 'assistant', content, ts: Date.now(), meta: { provider: provider.name, error: err, interrupted: aborted } };
      if (content) this.d.history.append(msg);
      this.d.emit('chat:done', { message: msg });
      this.setPhase(aborted ? 'idle' : 'error', err);
      if (!aborted) this.d.cue({ type: 'react', reaction: 'annoyed' });
    } finally {
      if (this.ctrl === ctrl) this.ctrl = null;
    }
  }

  private pendingSpeech = 0;
  private say(replyId: string, n: number, sentence: string) {
    const text = speakable(sentence);
    if (!text) return;
    this.pendingSpeech++;
    this.d.cue({ type: 'speak', utteranceId: `${replyId}:${n}`, text });
  }

  /** Speech events from the character renderer. */
  onSpeechEvent(state: 'start' | 'end' | 'error') {
    if (state === 'start') { if (this.phase !== 'speaking') this.setPhase('speaking'); return; }
    this.pendingSpeech = Math.max(0, this.pendingSpeech - 1);
    if (this.pendingSpeech === 0 && !this.ctrl && (this.phase === 'speaking' || this.phase === 'thinking')) this.setPhase('idle');
  }
  /** Speech was cancelled wholesale (interrupt). */
  onSpeechCleared() {
    this.pendingSpeech = 0;
    if (!this.ctrl && this.phase === 'speaking') this.setPhase('idle');
  }

  private async execute(a: { parsed: unknown; error?: string }, tainted: boolean, signal: AbortSignal): Promise<{ line: string; untrusted: boolean; cosmetic?: boolean }> {
    if (a.error) return { line: `- invalid failed: could not parse action (${a.error})`, untrusted: false };
    let prepared;
    try {
      prepared = prepareAction(a.parsed, this.d.actionCtx, tainted);
    } catch (e) {
      const toolName = (a.parsed as { tool?: string })?.tool ?? 'unknown';
      this.record(toolName, 'rejected', (e as Error).message);
      return { line: `- ${toolName} failed: ${(e as Error).message}`, untrusted: false };
    }
    const req: ActionRequest = { id: newId('act'), tool: prepared.tool, args: prepared.args, summary: prepared.summary, policy: prepared.policy, tainted };
    if (prepared.policy === 'deny') {
      this.record(req.tool, 'blocked', `${req.summary} — bloqueado pelas suas permissões`);
      return { line: `- ${req.tool} failed: blocked by user permission settings`, untrusted: false };
    }
    let approved = prepared.policy === 'allow';
    if (prepared.policy === 'confirm') {
      this.setPhase('idle', 'waiting for your confirmation');
      approved = await Promise.race([
        this.d.confirm(req),
        new Promise<boolean>((res) => signal.addEventListener('abort', () => res(false), { once: true })),
      ]);
      if (signal.aborted) throw new ProviderError('aborted', 'aborted');
      if (!approved) {
        this.record(req.tool, 'declined', `${req.summary} — você recusou`);
        return { line: `- ${req.tool} failed: the user declined this action`, untrusted: false };
      }
    }
    const result = await runAction(prepared, this.d.actionCtx, prepared.policy === 'confirm' && approved);
    const ar: ActionResult = { id: req.id, ok: result.ok, summary: result.summary, data: result.data };
    this.d.emit('action:result', ar);
    if (!(result.cosmetic && result.ok)) this.record(req.tool, result.ok ? 'done' : 'failed', `${req.summary} → ${result.summary}`);
    this.d.log.info('action', { tool: req.tool, ok: result.ok, policy: prepared.policy });
    const data = result.data === undefined ? '' : `\n${result.untrusted ? '<untrusted>' : ''}${JSON.stringify(result.data).slice(0, 4000)}${result.untrusted ? '</untrusted>' : ''}`;
    return { line: `- ${req.tool} ${result.ok ? 'ok' : 'failed'}: ${result.summary}${data}`, untrusted: !!result.untrusted, cosmetic: !!result.cosmetic && result.ok };
  }

  private record(tool: string, status: string, text: string) {
    const m: ChatMessage = { id: newId('x'), role: 'action', content: text, ts: Date.now(), meta: { actionStatus: status } };
    this.d.history.append(m);
    this.d.emit('chat:message', { message: m });
  }
}
