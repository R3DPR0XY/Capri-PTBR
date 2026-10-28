import type { Settings } from '../../shared/settings';
import { LipSync } from './lipsync';

type Report = (id: string, state: 'start' | 'end' | 'error') => void;

/** Picks a default substitute voice: a female Brazilian Portuguese voice first, then a female English one. */
export function pickVoice(voices: SpeechSynthesisVoice[], preferred: string): SpeechSynthesisVoice | null {
  if (preferred) { const v = voices.find((x) => x.name === preferred); if (v) return v; }
  const pt = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith('pt-br'));
  const ptPick = pt.find((v) => /maria|francisca|thalita|leticia|female|feminin/i.test(v.name)) ?? pt.find((v) => v.localService) ?? pt[0];
  if (ptPick) return ptPick;
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  return en.find((v) => /zira|aria|jenny|hazel|susan|eva|female/i.test(v.name)) ?? en.find((v) => v.localService) ?? en[0] ?? voices[0] ?? null;
}

/**
 * Sequential, interruptible speech queue. Each sentence is spoken as soon as it
 * streams in, so the first words play while the model is still generating.
 */
export class Speaker {
  private queue: { id: string; text: string }[] = [];
  private playing: { id: string; cancel: () => void } | null = null;
  readonly lips = new LipSync();
  private audioCtx: AudioContext | null = null;
  constructor(private settings: () => Settings, private report: Report, private fetchAudio: (text: string) => Promise<Uint8Array>) {}

  /** True only while audio is actually playing (between the engine's start and end events). */
  private audible = false;
  get speaking() { return this.audible; }

  enqueue(id: string, text: string) {
    if (this.queue.length > 50) this.queue.shift(); // bounded
    this.queue.push({ id, text });
    if (!this.playing) void this.next();
  }

  stopAll() {
    const pending = this.queue.splice(0);
    for (const q of pending) this.report(q.id, 'end');
    this.playing?.cancel();
    try { speechSynthesis.cancel(); } catch { /* */ }
  }

  private async next() {
    const item = this.queue.shift();
    if (!item) { this.lips.stop(); return; }
    const v = this.settings().voice;
    try {
      if (v.ttsEngine === 'openai') await this.playRemote(item, v);
      else await this.playSystem(item, v);
    } catch {
      // remote TTS failed → fall back to the local voice for this sentence
      if (v.ttsEngine === 'openai') { try { await this.playSystem(item, v); } catch { this.report(item.id, 'error'); } }
      else this.report(item.id, 'error');
    }
    this.playing = null;
    void this.next();
  }

  private playSystem(item: { id: string; text: string }, v: Settings['voice']) {
    return new Promise<void>((resolve, reject) => {
      if (typeof speechSynthesis === 'undefined') return reject(new Error('no speechSynthesis'));
      const u = new SpeechSynthesisUtterance(item.text);
      u.lang = 'pt-BR';
      const voice = pickVoice(speechSynthesis.getVoices(), v.systemVoice);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = v.rate; u.pitch = v.pitch; u.volume = v.volume;
      let done = false;
      const finish = (state: 'end' | 'error') => { if (done) return; done = true; this.audible = false; this.lips.stop(); this.report(item.id, state); state === 'end' ? resolve() : reject(new Error('tts error')); };
      u.onstart = () => { this.audible = true; this.lips.start(); this.report(item.id, 'start'); };
      u.onboundary = (e) => { if (e.name === 'word') this.lips.boundary(e.charLength || 4); };
      u.onend = () => finish('end');
      u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? finish('end') : finish('error'));
      this.playing = { id: item.id, cancel: () => { speechSynthesis.cancel(); finish('end'); } };
      speechSynthesis.speak(u);
      // watchdog: some voices never fire onend
      setTimeout(() => finish('end'), 4000 + item.text.length * 120);
    });
  }

  private async playRemote(item: { id: string; text: string }, v: Settings['voice']) {
    const bytes = await this.fetchAudio(item.text);
    this.audioCtx ??= new AudioContext();
    const buf = await this.audioCtx.decodeAudioData(bytes.slice().buffer);
    const src = this.audioCtx.createBufferSource();
    src.buffer = buf;
    const gain = this.audioCtx.createGain();
    gain.gain.value = v.volume;
    const an = this.audioCtx.createAnalyser();
    an.fftSize = 512;
    const data = new Float32Array(an.fftSize);
    src.connect(gain).connect(an).connect(this.audioCtx.destination);
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; this.audible = false; this.lips.stop(); this.report(item.id, 'end'); resolve(); };
      src.onended = finish;
      this.playing = { id: item.id, cancel: () => { try { src.stop(); } catch { /* */ } finish(); } };
      this.lips.start(() => { an.getFloatTimeDomainData(data); let s = 0; for (const x of data) s += x * x; return Math.sqrt(s / data.length); });
      this.audible = true;
      this.report(item.id, 'start');
      src.start();
    });
  }
}
