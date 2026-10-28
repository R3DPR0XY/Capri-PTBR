import { describe, expect, it } from 'vitest';
import { Animator, Blinker, NEUTRAL, type Params } from '../../src/renderer/character/params';
import { Behavior, type BehaviorInputs } from '../../src/renderer/character/behavior';
import { LipSync } from '../../src/renderer/character/lipsync';
import { Endpointer, encodeWav, resample, rms } from '../../src/renderer/character/audio';
import { pickVoice } from '../../src/renderer/character/speaker';
import { prng } from '../../src/renderer/character/geometry';
import { applyClip, CLIPS, ClipInstance, REACTION_CLIPS, clipByName } from '../../src/renderer/character/clips';
import { clampToDisplays, displayFor, restorePosition, type DisplayLike } from '../../src/main/desktop/displays';
import { inQuietHours, mayInterrupt } from '../../src/shared/behaviorRules';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { SEAT_RATIO } from '../../src/shared/framing';

const base: BehaviorInputs = { phase: 'idle', speechLevel: 0, speaking: false, pointer: null, idleSec: 0, sleepAfterSec: 600, quiet: false, intensity: 1 };
const run = (b: Behavior, secs: number, inp: Partial<BehaviorInputs> = {}, dt = 1 / 30) => { let p!: Params; for (let t = 0; t < secs; t += dt) p = b.update(dt, { ...base, ...inp }); return p; };

describe('Animator', () => {
  it('converges to the target without overshoot at any frame rate', () => {
    for (const fps of [144, 60, 30, 15, 5]) {
      const a = new Animator();
      const target = { ...NEUTRAL, blinkL: 1, mouthOpen: 1, headYaw: 0.8 };
      let maxBlink = 0;
      for (let i = 0; i < fps * 3; i++) { a.step(target, 1 / fps); maxBlink = Math.max(maxBlink, a.value.blinkL); }
      expect(a.value.blinkL).toBeCloseTo(1, 2);
      expect(a.value.headYaw).toBeCloseTo(0.8, 2);
      expect(maxBlink).toBeLessThanOrEqual(1.0001); // critically damped: no runaway
    }
  });
  it('survives a long stall (e.g. sleep/resume) without exploding', () => {
    const a = new Animator();
    a.step({ ...NEUTRAL, headYaw: 1 }, 30);
    expect(Number.isFinite(a.value.headYaw)).toBe(true);
    expect(Math.abs(a.value.headYaw)).toBeLessThanOrEqual(1.0001);
  });
  it('transitions are continuous (no pops between states)', () => {
    const a = new Animator();
    let prev = a.value.headPitch;
    for (let i = 0; i < 120; i++) {
      a.step({ ...NEUTRAL, headPitch: i < 60 ? 0.6 : -0.6 }, 1 / 60);
      expect(Math.abs(a.value.headPitch - prev)).toBeLessThan(0.08);
      prev = a.value.headPitch;
    }
  });
});

describe('Blinker', () => {
  it('blinks every few seconds, not constantly', () => {
    const b = new Blinker(prng(1));
    let blinks = 0, closed = false;
    for (let t = 0; t < 60; t += 1 / 60) {
      const v = b.update(1 / 60, { drowsy: 0, suppressed: false });
      if (v > 0.9 && !closed) { blinks++; closed = true; }
      if (v < 0.1) closed = false;
    }
    expect(blinks).toBeGreaterThanOrEqual(8);
    expect(blinks).toBeLessThanOrEqual(35);
  });
  it('does not blink when suppressed', () => {
    const b = new Blinker(prng(2));
    let max = 0;
    for (let t = 0; t < 20; t += 1 / 60) max = Math.max(max, b.update(1 / 60, { drowsy: 0, suppressed: true }));
    expect(max).toBe(0);
  });
});

describe('Behavior state machine', () => {
  it('idles, then looks around / gets distracted, and returns to idle', () => {
    const b = new Behavior(prng(3));
    run(b, 120);
    expect(b.history).toEqual(expect.arrayContaining(['lookAround', 'idle', 'action']));
    const ambient = b.history.filter((s) => !['idle', 'lookAround', 'distracted', 'action'].includes(s));
    expect(ambient).toEqual([]);
  });
  it('never gets distracted during quiet hours / DND', () => {
    const b = new Behavior(prng(4));
    run(b, 300, { quiet: true });
    expect(b.history).not.toContain('distracted');
  });
  it('follows conversation phases: listening → thinking → speaking → idle', () => {
    const b = new Behavior(prng(5));
    run(b, 0.5, { phase: 'listening' });
    expect(b.state).toBe('listening');
    expect(run(b, 0.2, { phase: 'listening' }).ringPulse).toBeGreaterThan(0);
    run(b, 0.5, { phase: 'thinking' });
    expect(b.state).toBe('thinking');
    const p = run(b, 0.5, { phase: 'speaking', speaking: true, speechLevel: 0.8 });
    expect(b.state).toBe('speaking');
    expect(p.mouthOpen).toBeCloseTo(0.8);
    run(b, 0.5, { phase: 'idle' });
    expect(b.state).toBe('idle');
  });
  it('goes to sleep when the user is away and wakes with a stretch', () => {
    const b = new Behavior(prng(6));
    run(b, 1, { idleSec: 900 });
    expect(b.state).toBe('sleeping');
    expect(run(b, 1, { idleSec: 900 }).sleep).toBe(1);
    run(b, 0.2, { idleSec: 0 });
    expect(b.state).toBe('returning');
    run(b, 3, { idleSec: 0 });
    expect(b.state).not.toBe('sleeping');
  });
  it('reactions are temporary and errors trigger annoyance', () => {
    const b = new Behavior(prng(7));
    b.react('wave');
    expect(b.state).toBe('action');
    run(b, 3);
    expect(['idle', 'lookAround', 'distracted']).toContain(b.state);
    run(b, 0.2, { phase: 'thinking' });
    run(b, 0.1, { phase: 'error' });
    expect(b.state).toBe('reacting');
    expect(b.reaction).toBe('annoyed');
  });
  it('looks toward the pointer', () => {
    const b = new Behavior(prng(8));
    const p = run(b, 0.1, { pointer: { x: 1, y: 0 } });
    expect(p.gazeX).toBeGreaterThan(0.5);
    expect(p.headYaw).toBeGreaterThan(0.2);
  });
  it('animation intensity 0 removes ambient sway', () => {
    const p = run(new Behavior(prng(9)), 2, { intensity: 0 });
    expect(p.bodyX).toBe(0);
    expect(p.bodyY).toBe(0);
  });
});

describe('LipSync', () => {
  it('opens while speaking and closes after', () => {
    const l = new LipSync();
    l.start();
    let max = 0;
    for (let i = 0; i < 60; i++) max = Math.max(max, l.update(1 / 60));
    expect(max).toBeGreaterThan(0.4);
    l.stop();
    let v = 1;
    for (let i = 0; i < 60; i++) v = l.update(1 / 60);
    expect(v).toBeLessThan(0.02);
  });
  it('follows real audio amplitude when available', () => {
    const l = new LipSync();
    let amp = 0;
    l.start(() => amp);
    for (let i = 0; i < 30; i++) l.update(1 / 60);
    const quiet = l.update(1 / 60);
    amp = 0.2;
    let loud = 0;
    for (let i = 0; i < 30; i++) loud = l.update(1 / 60);
    expect(quiet).toBeLessThan(0.05);
    expect(loud).toBeGreaterThan(0.8);
  });
});

describe('audio utilities', () => {
  it('encodes a valid 16-bit mono WAV', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32768);
    expect(wav.byteLength).toBe(44 + 8);
  });
  it('resamples to the target length', () => {
    expect(resample(new Float32Array(48000), 48000, 16000).length).toBe(16000);
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBe(1);
  });
  it('endpointer stops after trailing silence, max length, or no speech', () => {
    const e = new Endpointer({ silenceMs: 1000, maxMs: 30_000, noSpeechMs: 5000 });
    for (let i = 0; i < 10; i++) expect(e.push(0.001, 100)).toBe(false);
    for (let i = 0; i < 10; i++) expect(e.push(0.2, 100)).toBe(false);
    let stopped = false;
    for (let i = 0; i < 11 && !stopped; i++) stopped = e.push(0.001, 100);
    expect(stopped).toBe(true);
    const silent = new Endpointer({ silenceMs: 1000, maxMs: 30_000, noSpeechMs: 2000 });
    let s = false; let t = 0;
    while (!s && t < 10_000) { s = silent.push(0.001, 100); t += 100; }
    expect(t).toBe(2000);
  });
  it('prefere uma voz feminina em português do Brasil', () => {
    const v = (name: string, lang = 'pt-BR') => ({ name, lang, localService: true }) as SpeechSynthesisVoice;
    const voices = [v('Microsoft Zira Desktop', 'en-US'), v('Microsoft Daniel', 'pt-BR'), v('Microsoft Maria Desktop', 'pt-BR')];
    expect(pickVoice(voices, '')?.name).toBe('Microsoft Maria Desktop');
    expect(pickVoice(voices, 'Microsoft Zira Desktop')?.name).toBe('Microsoft Zira Desktop');
  });
  it('prefers an English female substitute voice, honours explicit choice', () => {
    const v = (name: string, lang = 'en-US') => ({ name, lang, localService: true }) as SpeechSynthesisVoice;
    const voices = [v('Microsoft David Desktop'), v('Microsoft Zira Desktop'), v('Microsoft Haruka', 'ja-JP')];
    expect(pickVoice(voices, '')?.name).toBe('Microsoft Zira Desktop');
    expect(pickVoice(voices, 'Microsoft David Desktop')?.name).toBe('Microsoft David Desktop');
    expect(pickVoice([], '')).toBeNull();
  });
});

describe('multi-monitor positioning', () => {
  const d = (id: number, x: number, y: number, w: number, h: number, scale = 1): DisplayLike => ({ id, bounds: { x, y, width: w, height: h }, workArea: { x, y, width: w, height: h - 40 }, scaleFactor: scale });
  const primary = d(1, 0, 0, 1920, 1080, 1.25);
  const right = d(2, 1920, -200, 2560, 1440, 1);
  const size = { width: 300, height: 520 };
  it('defaults to bottom-right of the primary work area', () => {
    const r = restorePosition(null, size, [primary], 1);
    expect(r.x + r.width).toBeLessThanOrEqual(1920);
    expect(Math.round(r.y + r.height * SEAT_RATIO)).toBe(1040); // resting on the taskbar's top edge
  });
  it('keeps a saved spot on a secondary monitor', () => {
    const r = restorePosition({ x: 3000, y: 300, displayId: 2 }, size, [primary, right], 1);
    expect(r).toMatchObject({ x: 3000, y: 300 });
    expect(displayFor(r, [primary, right]).id).toBe(2);
  });
  it('recovers when the saved monitor was unplugged', () => {
    const r = restorePosition({ x: 3000, y: 300, displayId: 2 }, size, [primary], 1);
    expect(r.x).toBeLessThan(1920);
    expect(r.x + r.width).toBeGreaterThan(0);
  });
  it('clamps a window dragged mostly off-screen back to a reachable spot', () => {
    const c = clampToDisplays({ x: -1000, y: 5000, width: 300, height: 520 }, [primary, right]);
    expect(c.x + c.width).toBeGreaterThanOrEqual(80);
    expect(c.y).toBeLessThanOrEqual(1040 - 80);
  });
});

describe('quiet hours & interruption rules', () => {
  const q = { enabled: true, start: '22:00', end: '08:00' };
  it('handles ranges that wrap midnight', () => {
    expect(inQuietHours(q, new Date(2026, 0, 1, 23, 30))).toBe(true);
    expect(inQuietHours(q, new Date(2026, 0, 1, 7, 59))).toBe(true);
    expect(inQuietHours(q, new Date(2026, 0, 1, 8, 0))).toBe(false);
    expect(inQuietHours({ ...q, start: '13:00', end: '14:00' }, new Date(2026, 0, 1, 13, 30))).toBe(true);
    expect(inQuietHours({ ...q, enabled: false }, new Date(2026, 0, 1, 23, 0))).toBe(false);
  });
  it('DND, fullscreen and hidden suppress unsolicited behavior', () => {
    const noon = new Date(2026, 0, 1, 12, 0);
    const s = structuredClone(DEFAULT_SETTINGS);
    expect(mayInterrupt(s, { fullscreen: false, hidden: false, now: noon })).toBe(true);
    expect(mayInterrupt(s, { fullscreen: true, hidden: false, now: noon })).toBe(false);
    expect(mayInterrupt(s, { fullscreen: false, hidden: true, now: noon })).toBe(false);
    s.behavior.doNotDisturb = true;
    expect(mayInterrupt(s, { fullscreen: false, hidden: false, now: noon })).toBe(false);
  });
});

describe('animation clip library', () => {
  const PARAM_KEYS = new Set(Object.keys(NEUTRAL));
  it('every clip is well-formed, uses real params and stays in range', () => {
    expect(new Set(CLIPS.map((c) => c.name)).size).toBe(CLIPS.length);
    for (const c of CLIPS) {
      expect(c.keys[0].t).toBe(0);
      expect(c.keys.at(-1)!.t).toBe(1);
      expect(c.keys.at(-1)!.pose).toEqual({}); // always returns to the base pose
      for (let i = 1; i < c.keys.length; i++) expect(c.keys[i].t).toBeGreaterThanOrEqual(c.keys[i - 1].t);
      for (const { pose } of c.keys) for (const [n, v] of Object.entries(pose)) {
        expect(PARAM_KEYS.has(n)).toBe(true);
        expect(Math.abs(v as number)).toBeLessThanOrEqual(n === 'bodyY' ? 10 : n === 'clawScale' ? 2.2 : 1);
      }
      expect(c.duration).toBeGreaterThan(0.5);
      expect(c.duration).toBeLessThan(5);
    }
  });
  it('provenance is honest: only frame-matched clips claim a frame source', () => {
    const framed = CLIPS.filter((c) => c.source !== 'interpretation').map((c) => c.name);
    expect(framed.sort()).toEqual(['blank_stare', 'front_stare', 'loom', 'maniac_grin', 'many_eyes', 'menace', 'reach_claw', 'reveal_spread', 'smug', 'tilt_grin']);
  });
  it('every reaction maps to existing clips', () => {
    for (const names of Object.values(REACTION_CLIPS)) for (const n of names) expect(clipByName(n)).toBeDefined();
  });
  it('playback is continuous and fades in/out (no pops)', () => {
    for (const c of CLIPS) {
      const inst = new ClipInstance(c);
      let prev = applyClip(NEUTRAL, {}, 0);
      for (let t = 0; t < c.duration + 0.1; t += 1 / 60) {
        const cur = applyClip(NEUTRAL, inst.sample(1 / 60), inst.weight);
        for (const k of ['headYaw', 'headPitch', 'headRoll', 'armRRaise', 'armLRaise'] as const) expect(Math.abs(cur[k] - prev[k])).toBeLessThan(0.25);
        prev = cur;
      }
      expect(inst.done).toBe(true);
      expect(inst.weight).toBeLessThanOrEqual(0);
    }
  });
  it('mirroring flips direction and swaps winks', () => {
    const c = clipByName('wink')!;
    const a = new ClipInstance(c, 1, 1, false), b = new ClipInstance(c, 1, 1, true);
    for (let i = 0; i < 25; i++) { a.sample(1 / 60); b.sample(1 / 60); }
    const pa = a.sample(1 / 60), pb = b.sample(1 / 60);
    expect(pa.blinkL).toBeGreaterThan(0.5);
    expect(pb.blinkR).toBeGreaterThan(0.5);
    expect(Math.sign(pa.headRoll!)).toBe(-Math.sign(pb.headRoll!));
  });
  it('ten idle minutes produce varied, non-repeating ambient behavior', () => {
    const b = new Behavior(prng(42));
    run(b, 600);
    const distinct = new Set(b.clipHistory);
    expect(distinct.size).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < b.clipHistory.length; i++) expect(b.clipHistory[i]).not.toBe(b.clipHistory[i - 1]);
  });
  it('quiet hours only use subtle fidgets', () => {
    const b = new Behavior(prng(43));
    run(b, 600, { quiet: true });
    for (const n of b.clipHistory) expect(clipByName(n)!.tags).toContain('subtle');
  });
  it('conversation cancels an ambient clip immediately', () => {
    const b = new Behavior(prng(44));
    b.playClip('stretch');
    run(b, 0.1, { phase: 'listening' });
    expect(b.clip).toBeNull();
    expect(b.state).toBe('listening');
  });
});
