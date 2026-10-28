import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { httpFetch } from '../ai/providers';
import type { Logger } from '../log';

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'];

/** Run a PowerShell script fed on stdin; inputs are passed only through env vars (no string interpolation). */
function runPs(script: string, env: Record<string, string>, timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(PS, PS_ARGS, { env: { ...process.env, ...env }, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, err }); });
    child.stdin.end(script);
  });
}

const STT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$all = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
$rec = $all | Where-Object { $_.Culture.Name -like 'pt-*' } | Select-Object -First 1
if (-not $rec) { $rec = $all | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1 }
if (-not $rec) { $rec = $all | Select-Object -First 1 }
if (-not $rec) { [Console]::Error.Write('NO_RECOGNIZER'); exit 3 }
$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine($rec)
$e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$e.SetInputToWaveFile($env:CAPRI_WAV)
$parts = @()
for ($i = 0; $i -lt 40; $i++) { $r = $e.Recognize(); if ($null -eq $r) { break }; $parts += $r.Text }
$e.Dispose()
[Console]::Out.Write(($parts -join ' '))
`;

const PROBE_SCRIPT = `
Add-Type -AssemblyName System.Speech
$r = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
[Console]::Out.Write(($r | ForEach-Object { $_.Culture.Name + ' ' + $_.Description }) -join '; ')
`;

let probeCache: { available: boolean; detail: string } | null = null;
export async function probeWindowsRecognizer() {
  if (probeCache) return probeCache;
  if (process.platform !== 'win32') return (probeCache = { available: false, detail: 'Not Windows' });
  const r = await runPs(PROBE_SCRIPT, {}, 15000);
  probeCache = r.out.trim() ? { available: true, detail: r.out.trim() } : { available: false, detail: r.err.trim() || 'Nenhum reconhecedor de fala instalado (Configurações → Hora e idioma → Fala)' };
  return probeCache;
}

/** Offline transcription through the Windows System.Speech dictation engine. */
export async function transcribeWindows(wav: Uint8Array): Promise<string> {
  const file = path.join(os.tmpdir(), `capri-stt-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, wav);
  try {
    const r = await runPs(STT_SCRIPT, { CAPRI_WAV: file }, 60_000);
    if (r.code === 3) throw new Error('Nenhum reconhecedor de fala do Windows está instalado.');
    if (r.code !== 0) throw new Error(`O reconhecimento de fala do Windows falhou: ${r.err.split('\n')[0].slice(0, 200)}`);
    return r.out.trim();
  } finally {
    fs.rmSync(file, { force: true }); // never retain recordings
  }
}

/** OpenAI-compatible /audio/transcriptions (cloud Whisper or a local server). */
export async function transcribeOpenAI(wav: Uint8Array, baseUrl: string, model: string, key?: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  form.append('language', 'pt'); // Whisper: transcrever em português
  const res = await httpFetch(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST', body: form, timeoutMs: 60_000, headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  const j = (await res.json()) as { text?: string };
  return (j.text ?? '').trim();
}

const WAKE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$all = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
$rec = $all | Where-Object { $_.Culture.Name -like 'pt-*' } | Select-Object -First 1
if (-not $rec) { $rec = $all | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1 }
if (-not $rec) { [Console]::Error.WriteLine('NO_RECOGNIZER'); exit 3 }
$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine($rec)
$choices = New-Object System.Speech.Recognition.Choices
if ($rec.Culture.Name -like 'pt-*') { $choices.Add([string[]]@('ei capri','oi capri','olá capri','fala capri')) } else { $choices.Add([string[]]@('hey capri','okay capri','hi capri','yo capri')) }
$gb = New-Object System.Speech.Recognition.GrammarBuilder($choices)
$gb.Culture = $rec.Culture
$e.LoadGrammar((New-Object System.Speech.Recognition.Grammar($gb)))
$e.SetInputToDefaultAudioDevice()
[Console]::Out.WriteLine('READY')
while ($true) {
  $r = $e.Recognize([TimeSpan]::FromSeconds(30))
  if ($r -ne $null -and $r.Confidence -ge [double]$env:CAPRI_WAKE_CONF) { [Console]::Out.WriteLine('WAKE ' + $r.Confidence) }
  if ((Get-Process -Id ([int]$env:CAPRI_PARENT_PID) -ErrorAction SilentlyContinue) -eq $null) { break }
}
`;

/**
 * Opt-in wake-word listener: a single supervised child process doing on-device keyword
 * spotting. Audio never leaves the machine. Bounded restarts; killed on stop/quit.
 */
export class WakeWordListener extends EventEmitter {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopping = false;
  private suppressedUntil = 0;
  constructor(private log: Logger, private confidence = 0.75) { super(); }
  get running() { return !!this.child; }
  start() {
    if (this.child || process.platform !== 'win32') return;
    this.stopping = false;
    // script file (not stdin) so the long-running loop isn't parsed line-by-line;
    // the script also exits on its own if our process dies (no orphaned mic listener)
    const scriptFile = path.join(os.tmpdir(), 'capri-wake.ps1');
    fs.writeFileSync(scriptFile, WAKE_SCRIPT);
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
      env: { ...process.env, CAPRI_WAKE_CONF: String(this.confidence), CAPRI_PARENT_PID: String(process.pid) }, windowsHide: true,
    });
    this.child = child;
    let buf = '';
    child.stdout!.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'READY') { this.restarts = 0; this.emit('ready'); }
        else if (line.startsWith('WAKE') && Date.now() > this.suppressedUntil) this.emit('wake');
      }
    });
    child.stderr!.on('data', (d) => this.log.warn('wake listener stderr', { detail: String(d).slice(0, 200) }));
    child.on('exit', (code) => {
      this.child = null;
      if (this.stopping) return;
      if (code === 3) { this.emit('error', new Error('Nenhum reconhecedor de fala instalado')); return; }
      if (this.restarts++ < 3) setTimeout(() => this.start(), 2000 * this.restarts);
      else this.emit('error', new Error('A escuta da palavra de ativação continua falhando; desativada'));
    });
  }
  /** Ignore wakes while we're recording/speaking ourselves. */
  suppress(ms: number) { this.suppressedUntil = Date.now() + ms; }
  stop() {
    this.stopping = true;
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) c.kill();
  }
}
