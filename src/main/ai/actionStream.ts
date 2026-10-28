import { TOOL_NAMES } from '../../shared/settings';

// <action>{"tool":…,"args":…}</action> is the documented form; models also improvise
// <emote>{"emotion":"smug"}</emote>, so a known tool name works as the tag, with the JSON as its args
const TAGS = ['action', ...TOOL_NAMES];
const OPENS = TAGS.map((t) => `<${t}>`);
const MAX_ACTION_CHARS = 4000;

export type StreamPiece = { type: 'text'; text: string } | { type: 'action'; raw: string; parsed: unknown; error?: string };

/**
 * Incremental splitter: separates visible text from <action>{json}</action> blocks while
 * tokens stream in. Partial tags at chunk boundaries are held back until resolved.
 */
export class ActionStreamParser {
  private buf = '';
  private inAction = false;
  private tag = 'action';

  push(chunk: string): StreamPiece[] {
    this.buf += chunk;
    const out: StreamPiece[] = [];
    for (;;) {
      if (!this.inAction) {
        let i = -1, open = '';
        for (const o of OPENS) { const k = this.buf.indexOf(o); if (k >= 0 && (i < 0 || k < i)) { i = k; open = o; } }
        if (i >= 0) {
          if (i > 0) out.push({ type: 'text', text: this.buf.slice(0, i) });
          this.buf = this.buf.slice(i + open.length);
          this.tag = open.slice(1, -1);
          this.inAction = true;
          continue;
        }
        // hold back a possible partial "<act" at the end
        const keep = Math.max(...OPENS.map((o) => partialSuffix(this.buf, o)));
        const emit = this.buf.slice(0, this.buf.length - keep);
        if (emit) out.push({ type: 'text', text: emit });
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      const close = `</${this.tag}>`;
      const j = this.buf.indexOf(close);
      if (j >= 0) {
        out.push(parseAction(this.buf.slice(0, j), this.tag));
        this.buf = this.buf.slice(j + close.length);
        this.inAction = false;
        continue;
      }
      if (this.buf.length > MAX_ACTION_CHARS) {
        out.push({ type: 'action', raw: this.buf.slice(0, 200), parsed: null, error: 'action block too long' });
        this.buf = '';
        this.inAction = false;
      }
      return out;
    }
  }

  /** Flush at end of stream. An unterminated action is reported as an error, never executed. */
  end(): StreamPiece[] {
    const out: StreamPiece[] = [];
    if (this.inAction) {
      // tolerate a missing close tag if the JSON is complete; otherwise it's reported as invalid
      if (this.buf.trim()) out.push(parseAction(this.buf, this.tag));
    } else if (this.buf) out.push({ type: 'text', text: this.buf });
    this.buf = '';
    this.inAction = false;
    return out;
  }
}

function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
  return 0;
}

function parseAction(raw: string, tag: string): StreamPiece {
  const body = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(body);
    // <emote>{"emotion":"smug"}</emote> → {tool:"emote", args:{emotion:"smug"}}
    const asTool = tag !== 'action' && !(parsed && typeof parsed === 'object' && 'tool' in parsed);
    return { type: 'action', raw: body, parsed: asTool ? { tool: tag, args: parsed ?? {} } : parsed };
  } catch {
    return { type: 'action', raw: body.slice(0, 200), parsed: null, error: 'invalid JSON' };
  }
}

/** Sentence chunker for low-latency TTS: emit complete sentences as they stream. */
export class SentenceChunker {
  private buf = '';
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    const re = /[^.!?…\n]+[.!?…]+["')\]]*\s+|[^\n]+\n+/g;
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = re.exec(this.buf))) {
      const s = m[0].trim();
      if (s.length >= 2) out.push(s);
      last = re.lastIndex;
    }
    this.buf = this.buf.slice(last);
    return out;
  }
  end(): string[] { const s = this.buf.trim(); this.buf = ''; return s ? [s] : []; }
}

/** Strip markdown/code so TTS doesn't read symbols aloud. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (código no chat) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'o link')
    .replace(/[*_#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
