// Minimal Win32 bindings via koffi (prebuilt FFI, no compiler needed). Every call degrades
// to a safe default if the library can't load, and diagnostics report the status.
import type { Logger } from '../log';

type Fn = (...a: unknown[]) => unknown;
interface Api {
  GetForegroundWindow: Fn; GetWindowRect: Fn; MonitorFromWindow: Fn; GetMonitorInfoW: Fn;
  GetClassNameW: Fn; GetWindowTextW: Fn; SHQueryUserNotificationState: Fn; GetAsyncKeyState: Fn; address: (p: unknown) => bigint;
}
let api: Api | null = null;
let loadError: string | null = null;

export function loadWin32(log?: Logger): boolean {
  if (api || loadError) return !!api;
  if (process.platform !== 'win32') { loadError = 'not Windows'; return false; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const shell32 = koffi.load('shell32.dll');
    const RECT = koffi.struct('CAPRI_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    koffi.struct('CAPRI_MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });
    api = {
      GetForegroundWindow: user32.func('void* __stdcall GetForegroundWindow()'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(void* hWnd, _Out_ CAPRI_RECT* rect)'),
      MonitorFromWindow: user32.func('void* __stdcall MonitorFromWindow(void* hwnd, uint32 flags)'),
      GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(void* hMonitor, _Inout_ CAPRI_MONITORINFO* info)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(void* hWnd, _Out_ uint16_t* buf, int max)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void* hWnd, _Out_ uint16_t* buf, int max)'),
      GetAsyncKeyState: user32.func('int16 __stdcall GetAsyncKeyState(int vKey)'),
      SHQueryUserNotificationState: shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int* state)'),
      address: (p: unknown) => (p ? BigInt(koffi.address(p)) : 0n),
    };
    return true;
  } catch (e) {
    loadError = (e as Error).message;
    log?.warn('win32 bindings unavailable; fullscreen detection disabled', { error: loadError });
    return false;
  }
}
export const win32Status = () => (api ? 'active' : 'unavailable') as 'active' | 'unavailable';

const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

/**
 * True when some other app is fullscreen (game, video, presentation).
 * `ownHandles` = native handles of our windows (excluded).
 */
export function isOtherAppFullscreen(ownHandles: bigint[]): boolean {
  if (!api) return false;
  try {
    const st = [0];
    if (api.SHQueryUserNotificationState(st) === 0 && [2, 3, 4].includes(st[0])) return true; // BUSY, D3D_FULL_SCREEN, PRESENTATION
    const hwnd = api.GetForegroundWindow();
    if (!hwnd || ownHandles.includes(api.address(hwnd))) return false;
    const buf = new Uint16Array(64);
    const n = api.GetClassNameW(hwnd, buf, 64) as number;
    const cls = String.fromCharCode(...buf.slice(0, Math.max(0, n)));
    if (SHELL_CLASSES.has(cls)) return false;
    const r: { left?: number; top?: number; right?: number; bottom?: number } = {};
    if (!api.GetWindowRect(hwnd, r)) return false;
    const mon = api.MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
    const mi = { cbSize: 72, rcMonitor: {} as typeof r, rcWork: {}, dwFlags: 0 };
    if (!api.GetMonitorInfoW(mon, mi)) return false;
    const m = mi.rcMonitor;
    return r.left! <= m.left! && r.top! <= m.top! && r.right! >= m.right! && r.bottom! >= m.bottom!;
  } catch {
    return false;
  }
}

/** Rect (physical px) of the foreground app window, excluding the shell and our own windows. */
export function foregroundRect(ownHandles: bigint[]): { x: number; y: number; width: number; height: number } | null {
  if (!api) return null;
  try {
    const hwnd = api.GetForegroundWindow();
    if (!hwnd || ownHandles.includes(api.address(hwnd))) return null;
    const buf = new Uint16Array(64);
    const n = api.GetClassNameW(hwnd, buf, 64) as number;
    if (SHELL_CLASSES.has(String.fromCharCode(...buf.slice(0, Math.max(0, n))))) return null;
    const r: { left?: number; top?: number; right?: number; bottom?: number } = {};
    if (!api.GetWindowRect(hwnd, r)) return null;
    return { x: r.left!, y: r.top!, width: r.right! - r.left!, height: r.bottom! - r.top! };
  } catch { return null; }
}

/** Foreground app window (physical px rect + title), excluding the shell and our own windows. */
export function foregroundWindow(ownHandles: bigint[]): { rect: { x: number; y: number; width: number; height: number }; title: string } | null {
  const rect = foregroundRect(ownHandles);
  if (!rect || !api || rect.width < 8 || rect.height < 8) return null;
  try {
    const buf = new Uint16Array(256);
    const n = api.GetWindowTextW(api.GetForegroundWindow(), buf, 256) as number;
    return { rect, title: String.fromCharCode(...buf.slice(0, Math.max(0, n))) };
  } catch { return { rect, title: '' }; }
}

/** Is the left mouse button physically down? (used to end drags robustly). Null if unknown. */
/** Handle of the foreground window (0n when none or unavailable). */
export function foregroundHandle(): bigint {
  if (!api) return 0n;
  try { const h = api.GetForegroundWindow(); return h ? api.address(h) : 0n; } catch { return 0n; }
}

export function leftButtonDown(): boolean | null {
  if (!api) return null;
  try { return ((api.GetAsyncKeyState(0x01) as number) & 0x8000) !== 0; } catch { return null; }
}

/** Read a BrowserWindow native handle Buffer as a bigint. */
export function handleToBigint(buf: Buffer): bigint {
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}
