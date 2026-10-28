import { describe, expect, it } from 'vitest';
import { wavToFloat32, LOCAL_WHISPER_MODELS } from '../../src/main/voice/localWhisper';
import { encodeWav } from '../../src/renderer/character/audio';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/shared/settings';

describe('Whisper local (voz em português)', () => {
  it('decodifica o WAV gravado pela Capri sem perder o sinal', () => {
    const x = new Float32Array(1600).map((_, i) => Math.sin(i / 10) * 0.5);
    const { samples, sampleRate } = wavToFloat32(encodeWav(x, 16000));
    expect(sampleRate).toBe(16000);
    expect(samples.length).toBe(x.length);
    for (let i = 0; i < x.length; i++) expect(Math.abs(samples[i] - x[i])).toBeLessThan(1e-3);
  });
  it('recusa dados que não são WAV', () => {
    expect(() => wavToFloat32(new Uint8Array(10))).toThrow(/WAV/);
  });
  it('vem ligado por padrão e aceita os três tamanhos de modelo', () => {
    expect(DEFAULT_SETTINGS.voice.sttEngine).toBe('local');
    expect(Object.keys(LOCAL_WHISPER_MODELS)).toEqual(['tiny', 'base', 'small']);
    expect(normalizeSettings({ voice: { localStt: { model: 'gigante' } } }).settings.voice.localStt.model).toBe('base');
  });
});
