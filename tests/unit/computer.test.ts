import { describe, expect, it } from 'vitest';
import { parseStep, runTask, toScreen, type AgentDeps } from '../../src/main/agent/computer';

const SCREEN = { jpegBase64: '', width: 1920, height: 1080, x: 0, y: 0 };
function fake(replies: string[], opts: { stopAfter?: number } = {}) {
  const did: string[] = [];
  let n = 0;
  const deps: AgentDeps = {
    capture: async () => SCREEN,
    decide: async () => replies[Math.min(n++, replies.length - 1)],
    hands: {
      moveTo: async (x, y) => { did.push(`move ${x},${y}`); },
      click: async (b, c) => { did.push(`click ${b} x${c}`); },
      typeText: async (t) => { did.push(`type ${t}`); },
      keys: async (k) => { did.push(`keys ${k}`); return true; },
      scroll: (s) => { did.push(`scroll ${s}`); },
    },
    stopRequested: () => opts.stopAfter !== undefined && n >= opts.stopAfter,
  };
  return { deps, did };
}

describe('computer control', () => {
  it('maps 0–1000 [y, x] points onto the physical screen', () => {
    expect(toScreen([500, 500], SCREEN)).toEqual({ x: 960, y: 540 });
    expect(toScreen([0, 1000], { ...SCREEN, x: 1920 })).toEqual({ x: 3840, y: 0 });
    expect(toScreen([-50, 2000], SCREEN)).toEqual({ x: 1920, y: 0 }); // clamped
  });

  it('parses JSON replies even when wrapped in prose or code fences', () => {
    expect(parseStep('```json\n{"action":"key","keys":"win"}\n```').action).toBe('key');
    expect(() => parseStep('no idea')).toThrow();
    expect(() => parseStep('{"action":"format_disk"}')).toThrow();
  });

  it('runs a task with real input actions until the model says done', async () => {
    const { deps, did } = fake([
      '{"action":"key","keys":"win"}',
      '{"action":"type","text":"notepad"}',
      '{"action":"key","keys":"enter"}',
      '{"action":"click","point":[100,200]}',
      '{"action":"done","result":"Notepad is open."}',
    ]);
    const r = await runTask('open notepad', deps, new AbortController().signal);
    expect(r).toMatchObject({ ok: true, summary: 'Notepad is open.', steps: 5 });
    expect(did).toEqual(['keys win', 'type notepad', 'keys enter', 'move 384,108', 'click left x1']);
  }, 20_000);

  it('never presses lock / sign-out / close-window chords on its own', async () => {
    const { deps, did } = fake(['{"action":"key","keys":"alt+f4"}', '{"action":"key","keys":"win+l"}', '{"action":"done"}']);
    await runTask('x', deps, new AbortController().signal);
    expect(did).toEqual([]);
  }, 20_000);

  it('stops at once when the user holds Esc or presses stop', async () => {
    const { deps, did } = fake(['{"action":"key","keys":"win"}'], { stopAfter: 2 });
    const r = await runTask('loop forever', deps, new AbortController().signal);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/Interrompida/);
    expect(did.length).toBeLessThanOrEqual(2);
    const ac = new AbortController(); ac.abort();
    expect((await runTask('x', fake(['{"action":"done"}']).deps, ac.signal)).summary).toMatch(/Interrompida/);
  }, 20_000);

  it('gives up after three replies it cannot understand', async () => {
    const r = await runTask('x', fake(['garbage']).deps, new AbortController().signal);
    expect(r).toMatchObject({ ok: false });
    expect(r.summary).toMatch(/próximo passo/);
  }, 20_000);
});

describe('exploring on her own (read only)', () => {
  it('blocks typing, right-clicks and non-reading keys; allows clicks, scrolling and page keys', async () => {
    const { deps, did } = fake([
      '{"action":"type","text":"my password"}',
      '{"action":"key","keys":"ctrl+a"}',
      '{"action":"right_click","point":[500,500]}',
      '{"action":"key","keys":"pagedown"}',
      '{"action":"scroll","amount":3}',
      '{"action":"click","point":[500,500]}',
      '{"action":"done","result":"Nice wiki page."}',
    ]);
    const r = await runTask('look around', deps, new AbortController().signal, { explore: true });
    expect(r).toMatchObject({ ok: true, summary: 'Nice wiki page.' });
    expect(did).toEqual(['keys pagedown', 'scroll -3', 'move 960,540', 'click left x1']);
  }, 30_000);

  it('caps how long she explores', async () => {
    const { deps } = fake(['{"action":"wait"}']);
    const r = await runTask('look around', deps, new AbortController().signal, { explore: true, maxSteps: 2 });
    expect(r).toMatchObject({ ok: false, steps: 2 });
  }, 30_000);
});
