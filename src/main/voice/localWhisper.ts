// Whisper local: transcrição de fala no próprio PC, em português, sem servidor e sem chave de API.
// Usa o Transformers.js (ONNX Runtime). O modelo é baixado uma única vez do Hugging Face para
// <userData>/models e depois tudo roda offline. O áudio nunca sai da máquina.

export const LOCAL_WHISPER_MODELS = {
  tiny: { id: 'onnx-community/whisper-tiny', label: 'Tiny (~75 MB, mais rápido)' },
  base: { id: 'onnx-community/whisper-base', label: 'Base (~150 MB, equilibrado)' },
  small: { id: 'onnx-community/whisper-small', label: 'Small (~500 MB, mais preciso)' },
} as const;
export type LocalWhisperSize = keyof typeof LOCAL_WHISPER_MODELS;

/** WAV PCM 16-bit (o formato gravado pela Capri: 16 kHz, mono) → Float32Array em [-1, 1]. */
export function wavToFloat32(wav: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o: number) => String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]);
  if (wav.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Áudio inválido (não é WAV)');
  let off = 12, sampleRate = 16000, channels = 1, bits = 16, dataOff = -1, dataLen = 0;
  while (off + 8 <= wav.byteLength) {
    const id = tag(off), size = v.getUint32(off + 4, true);
    if (id === 'fmt ') { channels = v.getUint16(off + 10, true); sampleRate = v.getUint32(off + 12, true); bits = v.getUint16(off + 22, true); }
    if (id === 'data') { dataOff = off + 8; dataLen = Math.min(size, wav.byteLength - dataOff); break; }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error('Áudio inválido (sem dados)');
  if (bits !== 16) throw new Error(`Formato de áudio não suportado (${bits} bits)`);
  const frames = Math.floor(dataLen / (2 * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += v.getInt16(dataOff + (i * channels + c) * 2, true);
    out[i] = s / channels / 32768;
  }
  return { samples: out, sampleRate };
}

/** Reamostragem linear simples (só usada se o WAV não vier em 16 kHz). */
function to16k(x: Float32Array, rate: number): Float32Array {
  if (rate === 16000) return x;
  const n = Math.round((x.length * 16000) / rate), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * rate) / 16000, a = Math.floor(p), f = p - a;
    out[i] = (x[a] ?? 0) * (1 - f) + (x[a + 1] ?? x[a] ?? 0) * f;
  }
  return out;
}

type Transcriber = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text?: string } | { text?: string }[]>;
export type Progress = (msg: string) => void;

export class LocalWhisper {
  private loading: Promise<Transcriber> | null = null;
  private loadedSize: LocalWhisperSize | null = null;
  constructor(private cacheDir: string, private log: { info(m: string, d?: Record<string, unknown>): void; warn(m: string, d?: Record<string, unknown>): void }) {}

  get ready() { return this.loadedSize !== null; }

  private load(size: LocalWhisperSize, progress?: Progress): Promise<Transcriber> {
    if (this.loading && this.loadedSize === size) return this.loading;
    this.loadedSize = null;
    const model = LOCAL_WHISPER_MODELS[size].id;
    this.loading = (async () => {
      // import dinâmico: a biblioteca é ESM e pesada, só carrega quando a voz local é usada
      const tf = (await import('@huggingface/transformers')) as unknown as {
        env: { cacheDir: string; allowRemoteModels: boolean; allowLocalModels: boolean };
        pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<Transcriber>;
      };
      tf.env.cacheDir = this.cacheDir;
      tf.env.allowLocalModels = true;
      tf.env.allowRemoteModels = true; // só para o primeiro download; depois o cache local é usado
      let lastPct = -10;
      const progress_callback = (p: { status?: string; file?: string; progress?: number }) => {
        if (p.status === 'progress' && typeof p.progress === 'number' && p.progress - lastPct >= 10) {
          lastPct = p.progress;
          progress?.(`Baixando o modelo de voz (só na primeira vez)… ${Math.round(p.progress)}%`);
        }
      };
      this.log.info('local whisper: loading', { model });
      let t: Transcriber;
      try {
        t = await tf.pipeline('automatic-speech-recognition', model, { dtype: 'q8', device: 'cpu', progress_callback });
      } catch (e) {
        // alguns modelos não têm a versão quantizada: tenta a completa
        this.log.warn('local whisper: q8 unavailable, trying fp32', { error: String((e as Error).message ?? e).slice(0, 200) });
        t = await tf.pipeline('automatic-speech-recognition', model, { dtype: 'fp32', device: 'cpu', progress_callback });
      }
      this.loadedSize = size;
      this.log.info('local whisper: ready', { model });
      return t;
    })();
    this.loading.catch(() => { this.loading = null; this.loadedSize = null; });
    return this.loading;
  }

  /** Pré-carrega o modelo (ex.: quando o usuário escolhe a voz local), para a primeira fala não demorar. */
  warmUp(size: LocalWhisperSize, progress?: Progress) { return this.load(size, progress).then(() => true, () => false); }

  async transcribe(wav: Uint8Array, size: LocalWhisperSize, progress?: Progress): Promise<string> {
    const t = await this.load(size, progress);
    const { samples, sampleRate } = wavToFloat32(wav);
    const out = await t(to16k(samples, sampleRate), { language: 'portuguese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    const text = (Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : out.text ?? '').trim();
    // o Whisper às vezes "alucina" em silêncio; descarta respostas típicas de áudio vazio
    return /^(\[.*\]|\(.*\)|.*legendas? (pela|por|da) .*|.*amara\.org.*)$/i.test(text) ? '' : text;
  }
}
