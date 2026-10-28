// OCR no próprio PC com o Windows.Media.Ocr (vem no Windows 10/11). A imagem é gravada num arquivo
// temporário, lida pelo PowerShell e apagada logo em seguida; nada sai da máquina.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPs } from '../voice/speech';

const OCR_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$eng = $null
$pt = New-Object Windows.Globalization.Language 'pt-BR'
if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($pt)) { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($pt) }
if (-not $eng) { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $eng) { [Console]::Error.Write('NO_OCR'); exit 3 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:CAPRI_PNG)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  foreach ($l in $res.Lines) { [Console]::Out.WriteLine($l.Text) }
} finally { $stream.Dispose() }

`;

/** Texto de uma imagem PNG (linhas separadas por \\n). */
export async function ocrPng(png: Buffer): Promise<string> {
  if (process.platform !== 'win32') throw new Error('A leitura de tela só funciona no Windows.');
  const file = path.join(os.tmpdir(), `capri-ocr-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(file, png);
  try {
    const r = await runPs(OCR_SCRIPT, { CAPRI_PNG: file }, 30_000);
    if (r.code === 3) throw new Error('Nenhum idioma de OCR instalado (Configurações → Hora e idioma → Idioma).');
    if (r.code !== 0) throw new Error(`O OCR do Windows falhou: ${r.err.split('\n')[0].slice(0, 200)}`);
    return r.out.replace(/\r/g, '').trim();
  } finally {
    fs.rmSync(file, { force: true }); // nunca guarda a captura
  }
}
