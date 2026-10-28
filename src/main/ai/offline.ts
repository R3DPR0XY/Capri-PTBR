import type { GenOptions, LLMMessage, LLMProvider } from './providers';
import { ProviderError } from './providers';
import { parseDuration, parseWhen } from '../actions/timeParse';

const act = (tool: string, args: Record<string, unknown>) => `<action>${JSON.stringify({ tool, args })}</action>`;
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/**
 * Modo sem modelo. Entende comandos diretos em português (e em inglês) e emite o mesmo
 * protocolo <action> que um modelo de verdade, então toda a validação, as permissões e
 * as confirmações continuam valendo.
 */
export function offlineReply(input: string, now = new Date()): string {
  const raw = input.trim();
  const t = raw.toLowerCase();

  if (t.startsWith('[action results]')) {
    const lines = raw.split('\n').slice(1).filter((l) => l.startsWith('- '));
    const ok = lines.filter((l) => /\bok\b/i.test(l));
    const summary = lines.map((l) => l.replace(/^- \S+ (ok|failed): /i, '')).join(' ');
    return ok.length === lines.length ? `${pick(['Pronto.', 'Resolvido.', 'Preem — feito.'])} ${summary}` : `Deu um problema: ${summary}`;
  }
  if (/^(oi|ol[áa]|e a[íi]|eae|salve|fala|ei|hi|hey|hello|yo|sup)\b|^(ei|oi|hey) capri/.test(t)) return pick(['E aí, choom. Tô aqui.', 'Fala. Ainda assombrando seu desktop.', 'Oi, você. Precisa de alguma coisa?']);
  if (/\b(ajuda|o que voc[êe] (faz|sabe fazer)|comandos|help|what can you do)\b/.test(t)) {
    return 'Sem um modelo conectado eu ainda consigo: criar timers ("timer de 5 minutos"), lembretes ("me lembra de alongar daqui a 20 minutos"), anotar ("nota: comprar café"), abrir sites ("abrir github.com"), abrir apps aprovados ("abrir bloco de notas"), buscar nas pastas autorizadas ("procurar arquivos chamados orçamento") e dizer as horas. Conecte um modelo na aba Modelo para conversar de verdade.';
  }
  if (/\b(vem aqui|vem c[áa]|chega mais|come here|over here)\b/.test(t)) return `Tô indo. ${act('teleport', { where: 'near_cursor' })}`;
  if (/\bsenta (na|nessa|nesta|em cima da) janela\b|\bsit on (my|the|this) window\b|\bperch\b/.test(t)) return `Com prazer. ${act('teleport', { where: 'perch' })}`;
  if (/\b(espia|espiar|peek)\b/.test(t)) return `Achou. ${act('teleport', { where: 'peek' })}`;
  const POSES: [RegExp, string][] = [
    [/\b(senta|sentar|sit down|sit)\b/, 'sit'], [/\b(levanta|fica de p[ée]|stand up|stand)\b/, 'stand'],
    [/\b(reclina|deita|recline|lie back)\b/, 'recline'], [/\b(encolhe|se encolhe|curl up)\b/, 'curl_up'],
    [/\b(pose de poder|faz uma pose|power stance|pose)\b/, 'power_stance'],
  ];
  const isTask = /timer|lembr|remind|nota|note/.test(t);
  const pose = POSES.find(([re]) => re.test(t));
  if (pose && !isTask) return `Assim? ${act('emote', { emotion: pose[1] })}`;
  if (/\b(teletransport\w*|teleport|sai da frente|sai do caminho|vai pra outro (canto|lugar)|outr[oa] (tela|monitor)|get out of the way|move (over|away|somewhere)|other (screen|monitor))\b/.test(t)) {
    return `Pisca e você perde. ${act('teleport', { where: /outr[oa] (tela|monitor)|other (screen|monitor)/.test(t) ? 'other_monitor' : /canto|corner/.test(t) ? 'corner' : 'auto' })}`;
  }
  if (/\b(cancela|cancelar|para|parar|desliga|cancel|stop|kill)\b.*\b(timer|lembrete|alarme|reminder)\b/.test(t)) {
    const q = t.replace(/.*\b(timer|lembrete|alarme|reminder)\b\s*/, '').replace(/^(de|do|da)\s+/, '').trim() || 'timer';
    return `Cancelando. ${act('cancel_timer', { query: q })}`;
  }
  if (/\b(timer|cron[ôo]metro|temporizador)\b/.test(t)) {
    const ms = parseDuration(t);
    if (!ms) return 'De quanto tempo? Tenta "timer de 10 minutos".';
    return `Timer saindo. ${act('start_timer', { seconds: Math.round(ms / 1000) })}`;
  }
  const rem = /\b(?:me lembr[ae]|lembr[ae]-me|me avis[ae]|remind me)\s+(?:de |para |pra |que |to )?(.+)/i.exec(raw);
  if (rem) {
    const when = parseWhen(rem[1], now);
    if (!when) return 'Quando eu te lembro? Diz "daqui a 20 minutos" ou "às 15h".';
    const text = rem[1]
      .replace(/\s*\b(daqui a|daqui|dentro de|em|in)\s+.+$/i, '')
      .replace(/\s*(?<![a-zà-ú])(amanh[ãa]\s+)?([àa]s?|at|para as|pras?)\s+\d.*$/i, '')
      .replace(/\s*\bamanh[ãa]\b.*$/i, '')
      .trim() || 'Lembrete';
    return `Fechado. ${act('set_reminder', { text, at: new Date(when).toISOString() })}`;
  }
  const note = /^(?:nota|anota|anotar|anote|escreve|escreva|toma nota|note|take a note|write down|jot down)[:\s]+(?:a[íi][:\s]+|que\s+)?(.+)/is.exec(raw);
  if (note) return `Anotado. ${act('create_note', { title: note[1].slice(0, 40), body: note[1] })}`;
  if (/\b(mostra|lista|ler|l[êe]|minhas|show|list|read)\b.*\b(notas|notes)\b/.test(t)) return `Puxando suas notas. ${act('list_notes', {})}`;
  const rememberM = /^(?:lembra|lembre|guarda|grava|memoriza|remember)\s+(?:que |disso: |isso: |that )?(.+)/is.exec(raw);
  if (rememberM && !/\bde\b.*\b(daqui|às|as \d|amanh)/i.test(raw)) return `Guardo isso — se você aprovar. ${act('remember', { text: rememberM[1] })}`;
  const search = /\b(?:procura|procurar|busca|buscar|acha|achar|encontra|encontrar|find|search for|look for)\s+(?:(?:os |o |a |as )?arquivos?\s+(?:chamados?|com o nome|com nome|named|called)\s+|files?\s+(?:named|called)\s+)?["']?([^"']+?)["']?\s*$/i.exec(raw);
  if (search && !/\b(web|internet|google)\b/.test(t)) return `Varrendo suas pastas. ${act('search_files', { query: search[1].trim() })}`;
  const open = /^(?:abr[ae]|abrir|vai para|vai pra|vai no|vai na|entra no|entra na|visita|open|go to|visit|browse to)\s+(?:o |a |no |na )?(.+)$/i.exec(raw);
  if (open) {
    const target = open[1].trim();
    if (/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(target)) return `Abrindo. ${act('open_url', { url: target })}`;
    return `Abrindo. ${act('launch_app', { name: target })}`;
  }
  const launch = /^(?:inicia|iniciar|executa|executar|roda|rodar|liga|launch|start|run)\s+(?:o |a )?(.+)$/i.exec(raw);
  if (launch) return `Abrindo. ${act('launch_app', { name: launch[1].trim() })}`;
  if (/\b(que horas|que hora|as horas|que dia|qual (a|é a) data|what time|the time|what's the date|what day)\b/.test(t)) return `Agora é ${now.toLocaleString('pt-BR', { weekday: 'long', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}.`;
  if (/\b(quem [ée] voc[êe]|o que [ée] voc[êe]|who are you|what are you)\b/.test(t)) return 'Capri. Um constructo de personalidade — um monte de mentes juntas numa só, e linda. Agora tô rodando sem modelo de linguagem, então sou mais mãos do que boca.';
  if (/\b(valeu|obrigad[oa]|brigad[oa]|vlw|thanks|thank you|ty)\b/.test(t)) return pick(['Sempre, choom.', 'Nova. Quando quiser.']);
  return 'Meu modelo de linguagem não está conectado, então por enquanto só entendo comandos diretos — diga "ajuda" para ver a lista, ou conecte um modelo na aba Modelo.';
}

export class OfflineProvider implements LLMProvider {
  readonly name = 'offline';
  readonly local = true;
  async *stream(messages: LLMMessage[], o: GenOptions) {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const reply = offlineReply(last?.content ?? '');
    // stream in word-sized pieces so the UI/TTS path is identical to real models
    for (const piece of reply.match(/<action>.*?<\/action>|\S+\s*/gs) ?? []) {
      if (o.signal.aborted) throw new ProviderError('aborted', 'aborted');
      yield piece;
      await new Promise((r) => setTimeout(r, 12));
    }
  }
  async test() { return { ok: true, detail: 'Modo de comandos offline embutido (sem modelo de linguagem)', latencyMs: 0 }; }
  async listModels() { return ['comandos embutidos']; }
}
