// Entende durações e horários em português (principal) e em inglês (alternativa).
const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, seg: 1000, segs: 1000, segundo: 1000, segundos: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, minuto: 60_000, minutos: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000, hora: 3_600_000, horas: 3_600_000,
};
const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, half: 0.5,
  um: 1, uma: 1, dois: 2, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  quinze: 15, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50,
};
const WORDS = Object.keys(WORD_NUM).sort((a, b) => b.length - a.length).join('|');
const UNITS = 'segundos?|segs?|seg|seconds?|secs?|s|minutos?|minutes?|mins?|m|horas?|hours?|hrs?|h';

/** "5 minutos", "1h30m", "90s", "uma hora", "meia hora", "5 minutes", "half an hour" → ms, ou null. */
export function parseDuration(text: string): number | null {
  const t = text.toLowerCase()
    .replace(/half an hour/g, '30 minutes')
    .replace(/\bmeia hora\b/g, '30 minutos')
    .replace(/\b(\d+)\s*(?:h|horas?)\s*e\s*meia\b/g, (_m, n) => `${n} horas 30 minutos`);
  let total = 0;
  let matched = false;
  // dígitos podem vir colados à unidade anterior ("1h30m"); números por extenso precisam de borda de palavra
  const re = new RegExp(`(?:(\\d+(?:[.,]\\d+)?)|(?<![a-zà-ú])(${WORDS}))\\s*(${UNITS})(?![a-zà-ú])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const n = m[1] !== undefined ? parseFloat(m[1].replace(',', '.')) : WORD_NUM[m[2]];
    const unit = UNIT_MS[m[3]];
    if (n === undefined || !unit) continue;
    total += n * unit;
    matched = true;
  }
  return matched && total > 0 ? Math.round(total) : null;
}

/**
 * "às 15h", "as 15:30", "15h30", "amanhã às 9", "daqui a 10 minutos", "em 20 minutos",
 * "at 3pm", "tomorrow at 9am", "in 10 minutes" → epoch ms, ou null.
 */
export function parseWhen(text: string, now = new Date()): number | null {
  const t = text.toLowerCase();
  const rel = /(?:\bin|\bem|\bdaqui a|\bdaqui|\bdentro de)\s+(.+)/.exec(t);
  if (rel) {
    const d = parseDuration(rel[1]);
    if (d) return now.getTime() + d;
  }
  const at = /(?:\bat|(?<![a-zà-ú])[àa]s?|\bpara as|\bpras?)\s+(\d{1,2})(?:(?::|h)(\d{2})?)?\s*(am|pm|da manhã|da tarde|da noite|horas?)?(?![\d])/.exec(t)
    ?? /\b(\d{1,2})(?::|h)(\d{2})?\b()/.exec(t);
  if (at) {
    let h = parseInt(at[1], 10);
    const min = at[2] ? parseInt(at[2], 10) : 0;
    const mer = at[3] ?? '';
    if ((mer === 'pm' || mer === 'da tarde' || mer === 'da noite') && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (/\b(tomorrow|amanh[ãa])\b/.test(t)) d.setDate(d.getDate() + 1);
    else if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h && `${h}h`, m && `${m}m`, sec && !h && `${sec}s`].filter(Boolean).join(' ') || '0s';
}
