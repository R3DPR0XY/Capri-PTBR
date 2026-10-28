import { SEAT_RATIO } from '../../src/shared/framing';
import { describe, expect, it, vi } from 'vitest';
import { classifyGeminiError, GeminiProvider } from '../../src/main/ai/gemini';
import { ConnectionMonitor } from '../../src/main/ai/connection';
import { ProviderError, type LLMProvider } from '../../src/main/ai/providers';
import { offlineReply } from '../../src/main/ai/offline';
import { chooseDestination, nextAutoDelay } from '../../src/main/desktop/teleport';
import { modelPoseFor } from '../../src/renderer/character/poseMap';
import { TeleportController } from '../../src/main/desktop/teleportController';
import { prepareAction, runAction, EMOTES } from '../../src/main/actions/registry';
import { redact, nullLogger } from '../../src/main/log';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { DisplayLike } from '../../src/main/desktop/displays';
import type { CharacterCue } from '../../src/shared/ipc';
import { mockServer } from './helpers';
import { makeCtx } from './ctx';

const opts = (signal = new AbortController().signal) => ({ temperature: 0.7, maxTokens: 100, timeoutMs: 5000, signal });
const collect = async (g: AsyncGenerator<string>) => { let s = ''; for await (const x of g) s += x; return s; };
const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const KEY = 'AQ.testkey_0123456789abcdefghijklmnop';

describe('Gemini provider (Interactions API, mocked server)', () => {
  it('streams text deltas, sends stateless history + system instruction, store=false, key in header only', async () => {
    const srv = await mockServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([
        { event_type: 'interaction.created', interaction: { id: 'i1' } },
        { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'x' } },
        { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Hey ' } },
        { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'choom.' } },
        { event_type: 'interaction.completed', interaction: { id: 'i1' } },
      ]));
    });
    const used = vi.fn();
    const p = new GeminiProvider({ apiKey: KEY, model: 'gemini-3.5-flash-lite', fallbackModel: '', thinkingLevel: 'minimal', serverUrl: srv.url, onModelUsed: used });
    const out = await collect(p.stream([{ role: 'system', content: 'be Capri' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }], opts()));
    expect(out).toBe('Hey choom.');
    const req = srv.requests[0];
    expect(req.url).toBe('/v1beta/interactions');
    expect(req.headers['x-goog-api-key']).toBe(KEY);
    expect(req.url).not.toContain(KEY);
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ model: 'gemini-3.5-flash-lite', stream: true, store: false, system_instruction: 'be Capri' });
    expect(body.input.map((s: { type: string }) => s.type)).toEqual(['user_input', 'model_output', 'user_input']);
    expect(body.generation_config).toMatchObject({ max_output_tokens: 100, thinking_level: 'minimal' });
    expect(used).toHaveBeenCalledWith('gemini-3.5-flash-lite', false);
    await srv.close();
  });

  it('falls back to the secondary model when the primary is not found — and says so', async () => {
    const srv = await mockServer((_q, res, body) => {
      const model = JSON.parse(body).model;
      if (model === 'primary') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'model not found' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([{ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'fallback ok' } }]));
    });
    const used = vi.fn();
    const p = new GeminiProvider({ apiKey: KEY, model: 'primary', fallbackModel: 'backup', thinkingLevel: 'minimal', serverUrl: srv.url, onModelUsed: used });
    expect(await collect(p.stream([{ role: 'user', content: 'hi' }], opts()))).toBe('fallback ok');
    expect(used).toHaveBeenCalledWith('backup', true);
    await srv.close();
  });

  it('retries a 429 then succeeds; never retries an invalid key', async () => {
    let n = 0;
    const srv = await mockServer((_q, res) => {
      if (n++ === 0) { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'slow down', details: [{ retryDelay: '0.05s' }] } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([{ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'ok' } }]));
    });
    const p = new GeminiProvider({ apiKey: KEY, model: 'm', fallbackModel: '', thinkingLevel: 'minimal', serverUrl: srv.url });
    expect(await collect(p.stream([{ role: 'user', content: 'hi' }], opts()))).toBe('ok');
    expect(n).toBe(2);
    await srv.close();

    let m = 0;
    const bad = await mockServer((_q, res) => { m++; res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } })); });
    const p2 = new GeminiProvider({ apiKey: KEY, model: 'm', fallbackModel: 'x', thinkingLevel: 'minimal', serverUrl: bad.url });
    const err = await collect(p2.stream([{ role: 'user', content: 'hi' }], opts())).catch((e) => e);
    expect(err).toMatchObject({ kind: 'auth' });
    expect(String(err.message)).not.toContain(KEY);
    expect(m).toBe(1);
    await bad.close();
  });

  it('a long quota wait goes straight to the fallback model, or fails fast with the retry time', async () => {
    const quota = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ retryDelay: '41s' }] } });
    const models: string[] = [];
    const srv = await mockServer((_q, res, body) => {
      const model = JSON.parse(body).model; models.push(model);
      if (model === 'primary') { res.writeHead(429, { 'content-type': 'application/json' }); res.end(quota); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([{ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'backup ok' } }]));
    });
    const t = Date.now();
    expect(await collect(new GeminiProvider({ apiKey: KEY, model: 'primary', fallbackModel: 'backup', thinkingLevel: 'minimal', serverUrl: srv.url }).stream([{ role: 'user', content: 'hi' }], opts()))).toBe('backup ok');
    expect(models).toEqual(['primary', 'backup']);
    const err = await collect(new GeminiProvider({ apiKey: KEY, model: 'primary', fallbackModel: '', thinkingLevel: 'minimal', serverUrl: srv.url }).stream([{ role: 'user', content: 'hi' }], opts())).catch((e) => e);
    expect(err).toMatchObject({ kind: 'rate_limit', retryAfterMs: 41_000 });
    expect(Date.now() - t).toBeLessThan(3000); // never sat out the 41 s
    await srv.close();
  });

  it('a stream that goes quiet after the headers times out instead of hanging', async () => {
    const srv = await mockServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse([{ event_type: 'interaction.created', interaction: { id: 'i1' } }])); // ...then nothing, connection held open
    });
    const t = Date.now();
    const err = await collect(new GeminiProvider({ apiKey: KEY, model: 'm', fallbackModel: '', thinkingLevel: 'minimal', serverUrl: srv.url }).stream([{ role: 'user', content: 'hi' }], { ...opts(), timeoutMs: 400 })).catch((e) => e);
    expect(err).toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t).toBeLessThan(4000);
    await srv.close();
  }, 10_000);

  it('a request that never starts streaming is retried after the first-event deadline, not the full timeout', async () => {
    let n = 0;
    const srv = await mockServer((_q, res) => {
      if (n++ === 0) return; // first request: no headers, no events, held open
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([{ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'ok' } }]));
    });
    const t = Date.now();
    const p = new GeminiProvider({ apiKey: KEY, model: 'm', fallbackModel: '', thinkingLevel: 'minimal', serverUrl: srv.url, firstEventTimeoutMs: 300 });
    expect(await collect(p.stream([{ role: 'user', content: 'hi' }], { ...opts(), timeoutMs: 60_000 }))).toBe('ok');
    expect(n).toBe(2);
    expect(Date.now() - t).toBeLessThan(5000);
    await srv.close();
  }, 15_000);

  it('a model that rejects the thinking level is retried with its own default', async () => {
    const bodies: { generation_config: Record<string, unknown> }[] = [];
    const srv = await mockServer((_q, res, body) => {
      const b = JSON.parse(body); bodies.push(b);
      if (b.generation_config.thinking_level) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Thinking level THINKING_LEVEL_MINIMAL is not supported for this model.' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([{ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'ok' } }]));
    });
    const p = new GeminiProvider({ apiKey: KEY, model: 'gemini-3.8-flash', fallbackModel: '', thinkingLevel: 'minimal', serverUrl: srv.url });
    expect(await collect(p.stream([{ role: 'user', content: 'hi' }], opts()))).toBe('ok');
    expect(await collect(p.stream([{ role: 'user', content: 'again' }], opts()))).toBe('ok');
    expect(bodies.map((b) => 'thinking_level' in b.generation_config)).toEqual([true, false, false]); // remembered
    await srv.close();
  });

  it('a missing key is a clear configuration error (never a mock reply)', async () => {
    const p = new GeminiProvider({ apiKey: undefined, model: 'm', fallbackModel: '', thinkingLevel: 'minimal' });
    await expect(collect(p.stream([{ role: 'user', content: 'hi' }], opts()))).rejects.toMatchObject({ kind: 'config' });
    expect((await p.test()).ok).toBe(false);
  });

  it('network failure classifies as network and test() reports it', async () => {
    const p = new GeminiProvider({ apiKey: KEY, model: 'm', fallbackModel: '', thinkingLevel: 'minimal', serverUrl: 'http://127.0.0.1:1' });
    const err = await collect(p.stream([{ role: 'user', content: 'hi' }], { ...opts(), timeoutMs: 2000 })).catch((e) => e);
    expect(['network', 'timeout']).toContain(err.kind);
    const t = await p.test();
    expect(t.ok).toBe(false);
  }, 20_000);

  it('test() lists models and verifies the configured model is available', async () => {
    const srv = await mockServer((q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'models/gemini-3.5-flash-lite' }, { name: 'models/gemini-3.1-flash-lite' }, { name: 'models/gemini-3.8-flash-tts' }] }));
      void q;
    });
    const ok = await new GeminiProvider({ apiKey: KEY, model: 'gemini-3.5-flash-lite', fallbackModel: 'gemini-3.1-flash-lite', thinkingLevel: 'minimal', serverUrl: srv.url }).test();
    expect(ok.ok).toBe(true);
    const missing = await new GeminiProvider({ apiKey: KEY, model: 'gemini-9', fallbackModel: '', thinkingLevel: 'minimal', serverUrl: srv.url }).test();
    expect(missing).toMatchObject({ ok: false });
    expect(missing.detail).toMatch(/não está disponível/);
    const list = await new GeminiProvider({ apiKey: KEY, model: 'x', fallbackModel: '', thinkingLevel: 'minimal', serverUrl: srv.url }).listModels();
    expect(list).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']); // TTS filtered out
    await srv.close();
  });

  it('error classification scrubs keys and maps statuses', () => {
    expect(classifyGeminiError({ statusCode: 503, body: JSON.stringify({ error: { message: `overloaded key=${KEY}` } }) }, KEY).message).not.toContain(KEY);
    expect(classifyGeminiError({ statusCode: 503, body: '{}' }).kind).toBe('server');
    expect(classifyGeminiError({ statusCode: 404, body: '{}' }).kind).toBe('model');
    expect(classifyGeminiError({ statusCode: 403, body: '{}' }).kind).toBe('auth');
    expect(classifyGeminiError({ message: 'fetch failed' }).kind).toBe('network');
    expect(classifyGeminiError({ name: 'AbortError', message: 'aborted' }).kind).toBe('aborted');
  });

  it('logger redacts Google key formats', () => {
    expect(JSON.stringify(redact({ msg: `bad ${KEY} and AIzaSyA1234567890abcdefghijklmnopqrs` }))).not.toMatch(/AQ\.testkey|AIzaSy/);
  });
});

describe('ConnectionMonitor', () => {
  const prov = (name: string, test: () => Promise<{ ok: boolean; detail: string }>): LLMProvider => ({ name, local: false, stream: async function* () {}, test, listModels: async () => [] });
  it('goes connecting → connected only after a real successful check', async () => {
    const states: string[] = [];
    const m = new ConnectionMonitor(() => prov('gemini', async () => ({ ok: true, detail: 'ok' })), () => 'environment', nullLogger);
    m.on('changed', (s) => states.push(s.state));
    await m.check('t');
    expect(states).toEqual(['connecting', 'connected']);
    expect(m.connected).toBe(true);
  });
  it('maps failures: network → disconnected, auth → error; transient keeps state', async () => {
    const m = new ConnectionMonitor(() => prov('gemini', async () => ({ ok: false, detail: 'Network error reaching Gemini' })), () => 'none', nullLogger);
    await m.check('t');
    expect(m.status.state).toBe('disconnected');
    m.reportSuccess('gemini', 'gemini-3.5-flash-lite');
    expect(m.status.state).toBe('connected');
    m.reportFailure(new ProviderError('rate', 'rate_limit'));
    expect(m.status.state).toBe('connected');
    m.reportFailure(new ProviderError('bad key', 'auth'));
    expect(m.status.state).toBe('error');
    m.reportFailure(new ProviderError('down', 'network'));
    expect(m.status.state).toBe('disconnected');
  });
  it('offline provider is never reported as connected', async () => {
    const m = new ConnectionMonitor(() => prov('offline', async () => ({ ok: true, detail: '' })), () => 'none', nullLogger);
    await m.check('t');
    expect(m.status).toMatchObject({ state: 'disconnected', provider: 'offline' });
  });
  it('a stale check never overwrites a newer one', async () => {
    let n = 0;
    const m = new ConnectionMonitor(() => prov('gemini', async () => { const i = ++n; await new Promise((r) => setTimeout(r, i === 1 ? 80 : 5)); return { ok: i !== 1, detail: `check ${i}` }; }), () => 'none', nullLogger);
    const a = m.check('1'); const b = m.check('2');
    await Promise.all([a, b]);
    expect(m.status).toMatchObject({ state: 'connected', detail: 'check 2' });
  });
});

describe('teleport destination selection', () => {
  const d = (id: number, x: number, y: number, w: number, h: number): DisplayLike => ({ id, bounds: { x, y, width: w, height: h }, workArea: { x, y, width: w, height: h - 48 }, scaleFactor: 1.25 });
  const primary = d(1, 0, 0, 1536, 864);
  const second = d(2, 1536, -200, 1920, 1080);
  const cur = { x: 1212, y: 296, width: 300, height: 520 };
  const rnd = () => 0.5;
  // on screen down to her seat line (below it the window may overlap the taskbar, which never shows anything)
  const inside = (r: { x: number; y: number; width: number; height: number }, a: { x: number; y: number; width: number; height: number }) => r.x >= a.x && r.y >= a.y && r.x + r.width <= a.x + a.width + 1 && r.y + r.height * SEAT_RATIO <= a.y + a.height + 1;

  it('"left" / "right" mean a seat on the taskbar on that side, not floating', () => {
    const a = primary.workArea;
    for (const side of ['left', 'right'] as const) {
      for (let i = 0; i < 60; i++) {
        const from = side === 'left' ? { ...cur, x: 1100 } : { ...cur, x: 40 };
        const r = chooseDestination(side, { displays: [primary], current: from, cursor: { x: 768, y: 100 }, avoid: null, rand: Math.random })!;
        expect(Math.abs(r.y + r.height * SEAT_RATIO - (a.y + a.height)), `${side} #${i} seated`).toBeLessThanOrEqual(1);
        expect(side === 'left' ? r.x + r.width / 2 < a.width / 2 : r.x + r.width / 2 >= a.width / 2).toBe(true);
      }
    }
  });

  it('always lands fully inside a work area, away from the current spot and the cursor', () => {
    for (let i = 0; i < 50; i++) {
      const r = chooseDestination('auto', { displays: [primary, second], current: cur, cursor: { x: 200, y: 600 }, avoid: null, rand: Math.random })!;
      if (r.kind === 'peek_left' || r.kind === 'peek_right') { expect(r.kind).toMatch(/peek/); continue; } // peeking is partly off-screen by design
      expect([primary, second].some((x) => inside(r, x.workArea))).toBe(true);
      expect(Math.hypot(r.x - cur.x, r.y - cur.y)).toBeGreaterThan(200);
      expect(200 >= r.x && 200 < r.x + r.width && 600 >= r.y && 600 < r.y + r.height).toBe(false);
    }
  });
  it('avoids covering the active window when possible', () => {
    const avoid = { x: 0, y: 0, width: 900, height: 816 }; // app occupies the left part of the primary screen
    const r = chooseDestination('auto', { displays: [primary], current: { ...cur, x: 1200 }, cursor: { x: 1400, y: 100 }, avoid, rand: rnd })!;
    expect(r.x).toBeGreaterThanOrEqual(900);
  });
  it('near_cursor stands beside (not on) the cursor and stays on screen', () => {
    const r = chooseDestination('near_cursor', { displays: [primary], current: cur, cursor: { x: 1500, y: 400 }, avoid: null, rand: rnd })!;
    expect(inside(r, primary.workArea)).toBe(true);
    expect(1500 >= r.x && 1500 < r.x + r.width).toBe(false);
  });
  it('other_monitor picks the other display (and degrades gracefully with one)', () => {
    const r = chooseDestination('other_monitor', { displays: [primary, second], current: cur, cursor: { x: 0, y: 0 }, avoid: null, rand: rnd })!;
    expect(inside(r, second.workArea)).toBe(true);
    expect(chooseDestination('other_monitor', { displays: [primary], current: cur, cursor: { x: 0, y: 0 }, avoid: null, rand: rnd })).not.toBeNull();
  });
  it('corner / left / right respect the request', () => {
    const c = chooseDestination('corner', { displays: [primary], current: { ...cur, x: 600 }, cursor: { x: 0, y: 0 }, avoid: null, rand: rnd })!;
    expect(Math.abs(c.y + c.height * SEAT_RATIO - 816)).toBeLessThanOrEqual(1); // seat on the taskbar's top edge
    const l = chooseDestination('left', { displays: [primary], current: cur, cursor: { x: 1500, y: 0 }, avoid: null, rand: rnd })!;
    expect(l.x + l.width / 2).toBeLessThan(768);
  });
  it('returns null on an impossible layout instead of moving off-screen', () => {
    expect(chooseDestination('auto', { displays: [], current: cur, cursor: { x: 0, y: 0 }, avoid: null })).toBeNull();
    const tiny = d(9, 0, 0, 200, 300);
    // every random roll, including the 'peek in from an edge' branch (it used to slip through ~12% of the time)
    for (const r of [0.1, 0.5, 0.9, 0.99]) expect(chooseDestination('auto', { displays: [tiny], current: cur, cursor: { x: 0, y: 0 }, avoid: null, rand: () => r })).toBeNull();
  });
  it('auto delays stay within the configured range', () => {
    for (let i = 0; i < 100; i++) { const ms = nextAutoDelay(4, 15); expect(ms).toBeGreaterThanOrEqual(4 * 60_000); expect(ms).toBeLessThanOrEqual(15 * 60_000); }
  });
});

describe('TeleportController', () => {
  const primary: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, workArea: { x: 0, y: 0, width: 1536, height: 816 }, scaleFactor: 1.25 };
  function rig(over: Partial<{ connected: boolean; blocked: string | null; idle: number; ack: boolean; effects: boolean }> = {}) {
    const o = { connected: true, blocked: null as string | null, idle: 0, ack: true, effects: true, ...over };
    let bounds = { x: 1212, y: 296, width: 300, height: 520 };
    const cues: CharacterCue[] = [];
    const s = structuredClone(DEFAULT_SETTINGS);
    s.teleport.effects = o.effects;
    const tc: TeleportController = new TeleportController({
      settings: () => s, bounds: () => bounds, move: (r) => { bounds = r; }, displays: () => [primary],
      cursor: () => ({ x: 10, y: 10 }), activeWindow: () => null,
      cue: (c) => { cues.push(c); if (o.ack && c.type === 'teleport') setTimeout(() => tc.ack(c.id, c.phase), 5); },
      aiConnected: () => o.connected, blocked: () => o.blocked, userIdleSec: () => o.idle, log: nullLogger,
    });
    return { tc, cues, get bounds() { return bounds; }, s };
  }
  it('runs departure → real move → arrival, in order', async () => {
    const r = rig();
    const res = await r.tc.go('auto', 'manual');
    expect(res.ok).toBe(true);
    expect(r.cues.map((c) => (c.type === 'teleport' ? c.phase : c.type))).toEqual(['out', 'in']);
    expect(r.bounds.x).not.toBe(1212);
    expect(r.tc.count).toBe(1);
  });
  it('a stalled renderer cannot strand her (ack timeout)', async () => {
    const r = rig({ ack: false, effects: false });
    const t0 = Date.now();
    expect((await r.tc.go('auto', 'manual')).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it('rejects overlapping teleports', async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.tc.go('auto', 'manual'), r.tc.go('auto', 'manual')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });
  it('autonomous teleport requires a live AI connection and respects blockers', async () => {
    expect(await rig({ connected: false }).tc.autoTick()).toBe('IA não conectada');
    expect(await rig({ blocked: 'conversation in progress' }).tc.autoTick()).toBe('conversation in progress');
    expect(await rig({ idle: 900 }).tc.autoTick()).toBe('usuário ausente');
    const off = rig(); off.s.teleport.auto = false;
    expect(await off.tc.autoTick()).toBe('teletransporte automático desligado');
    const ok = rig();
    expect(await ok.tc.autoTick()).toBeNull();
    expect(ok.tc.count).toBe(1);
    ok.tc.stopAuto();
  });
  it('manual teleport works without AI', async () => {
    expect((await rig({ connected: false }).tc.go('near_cursor', 'manual')).ok).toBe(true);
  });
});

describe('AI → character structured actions', () => {
  it('emote/teleport are validated against fixed enums and run through hooks', async () => {
    const { ctx } = makeCtx();
    const emotes: string[] = [];
    const where: string[] = [];
    Object.assign(ctx, { emote: (n: string) => { emotes.push(n); return true; }, teleport: async (w: string) => { where.push(w); return { ok: true, detail: 'moved' }; } });
    expect(() => prepareAction({ tool: 'emote', args: { emotion: 'explode_desktop' } }, ctx, false)).toThrow(/Invalid args/);
    const r = await runAction(prepareAction({ tool: 'emote', args: { emotion: 'menace' } }, ctx, false), ctx, false);
    expect(r).toMatchObject({ ok: true, cosmetic: true });
    await runAction(prepareAction({ tool: 'teleport', args: { where: 'other_monitor' } }, ctx, false), ctx, false);
    expect(emotes).toEqual(['menace']);
    expect(where).toEqual(['other_monitor']);
    expect(prepareAction({ tool: 'teleport', args: {} }, ctx, true).policy).toBe('allow'); // harmless even after untrusted data
    expect(EMOTES).toContain('many_eyes');
  });
  it('offline brain understands teleport requests', () => {
    expect(offlineReply('teleport')).toMatch(/"tool":"teleport"/);
    expect(offlineReply('come here')).toMatch(/"where":"near_cursor"/);
    expect(offlineReply('move to the other monitor')).toMatch(/"where":"other_monitor"/);
  });
});

describe('model pose: she never lies or sits on thin air', () => {
  const postures = ['stand', 'contrapposto', 'sit_edge', 'air_sit', 'recline', 'power_stance', 'peek_left', 'peek_right', 'balance'];
  it('lies down only on the taskbar or a window top; with nothing under her she floats', () => {
    for (const surface of ['taskbar', 'window', 'air', 'edge_left', 'edge_right'])
      for (const posture of postures)
        for (const sleeping of [false, true])
          for (const variant of [0, 0.3, 0.59, 0.61, 0.99]) {
            const pose = modelPoseFor({ surface, posture, sleeping, dragging: false, variant });
            const ledge = surface === 'taskbar' || surface === 'window';
            if (!ledge) expect(['crouch', 'back'], `${surface}/${posture}/${sleeping}`).toContain(pose); // upright or knees drawn up: floating
            if (pose === 'lie' || pose === 'sit') expect(ledge).toBe(true);
          }
  });
  it('reclining or asleep on a ledge she lies down; dragged she dangles', () => {
    expect(modelPoseFor({ surface: 'window', posture: 'recline', sleeping: false, dragging: false, variant: 0.9 })).toBe('lie');
    expect(modelPoseFor({ surface: 'taskbar', posture: 'stand', sleeping: true, dragging: false, variant: 0.9 })).toBe('lie');
    expect(modelPoseFor({ surface: 'window', posture: 'sit_edge', sleeping: false, dragging: false, variant: 0.2 })).toBe('sit');
    expect(modelPoseFor({ surface: 'taskbar', posture: 'recline', sleeping: false, dragging: true, variant: 0 })).toBe('crouch');
  });
});
