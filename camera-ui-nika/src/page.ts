// i18n-skip-file: the lines of the page's read-only fields (data, not field titles), in the language NIKA speaks.
import type { FoundNika } from './discovery.js';
import type { JournalEntry, Outcome, PendingGrant } from './grants.js';
import type { LinkState, PairedNika } from './link.js';
import type { Lang } from './texts.js';

export interface LinkView {
  nika: PairedNika;
  state: LinkState;
  since?: number;
  error?: string;
}

interface PageTexts {
  paired: string;
  found: string;
  none: string;
  noneFound: string;
  online(since: string, host: string): string;
  connecting: string;
  offline(why: string): string;
  speaksOff: string;
  pendingNone: string;
  pendingLine(nika: string, what: string, at: string, left: number, speaker?: string): string;
  journalNone: string;
  outcomes: Record<Outcome, string>;
  by(who: string): string;
  connected(name: string): string;
  codeWrong(left: number): string;
  codeWrongLast: string;
  said(name: string): string;
  notSaid(name: string, why: string): string;
  unpaired(name: string): string;
  addressNeeded: string;
  notHeard: string;
  sayingCode: string;
  pairingOver: string;
  noneConnected: string;
  noSuch: string;
  noRequests: string;
  noneOnline: string;
  noRequest: string;
}

const RU: PageTexts = {
  paired: 'Подключены:',
  found: 'Найдены в сети, не подключены:',
  none: 'NIKA ещё не подключена: нажмите «Подключить NIKA».',
  noneFound: 'В сети NIKA не найдена. Она включена и в той же сети? Можно подключить по адресу.',
  online: (since, host) => `на связи с ${since} (${host})`,
  connecting: 'подключаюсь…',
  offline: (why) => `нет связи: ${why}`,
  speaksOff: 'уведомления не говорит (Настройки → Уведомления)',
  pendingNone: 'Запросов нет.',
  pendingLine: (nika, what, at, left, speaker) => `${at} ${nika}${speaker ? ` (просит ${speaker})` : ''}: ${what} — ждёт ещё ${left} мин.`,
  journalNone: 'Пока пусто.',
  outcomes: {
    done: 'дано',
    failed: 'не получилось',
    asked: 'спросила родителей',
    approved: 'разрешили',
    declined: 'не разрешили',
    expired: 'ответа не было',
    refused: 'отказано',
  },
  by: (who) => (who === 'chat' ? 'в чате' : 'на странице'),
  connected: (name) => `${name} подключена.`,
  codeWrong: (left) => `Код не тот. Осталось попыток: ${left}.`,
  codeWrongLast: 'Код не тот, попытки кончились. Начните подключение заново.',
  said: (name) => `${name} сказала фразу.`,
  notSaid: (name, why) => `${name} не сказала фразу: ${why}`,
  unpaired: (name) => `${name} отключена.`,
  addressNeeded: 'Укажите адрес NIKA, например 192.168.1.50',
  notHeard: 'Эта NIKA больше не слышна в сети. Она включена?',
  sayingCode: 'NIKA произносит код',
  pairingOver: 'Подключение закончилось: начните заново',
  noneConnected: 'Ни одна NIKA не подключена',
  noSuch: 'Такой NIKA нет',
  noRequests: 'Запросов нет',
  noneOnline: 'Сейчас ни одна NIKA не на связи',
  noRequest: 'Такого запроса нет: на него уже ответили или он истёк',
};

const EN: PageTexts = {
  paired: 'Connected:',
  found: 'Found on the network, not connected:',
  none: 'No NIKA is connected yet: press «Connect NIKA».',
  noneFound: 'No NIKA was found on the network. Is she on and in the same network? She can be connected by her address.',
  online: (since, host) => `connected since ${since} (${host})`,
  connecting: 'connecting…',
  offline: (why) => `not connected: ${why}`,
  speaksOff: 'does not say notifications (Settings → Notifications)',
  pendingNone: 'No requests.',
  pendingLine: (nika, what, at, left, speaker) => `${at} ${nika}${speaker ? ` (asked by ${speaker})` : ''}: ${what} — waits ${left} more min`,
  journalNone: 'Nothing yet.',
  outcomes: {
    done: 'given',
    failed: 'failed',
    asked: 'asked the parents',
    approved: 'allowed',
    declined: 'not allowed',
    expired: 'no answer',
    refused: 'refused',
  },
  by: (who) => (who === 'chat' ? 'in the chat' : 'on the page'),
  connected: (name) => `${name} is connected.`,
  codeWrong: (left) => `Wrong code. Tries left: ${left}.`,
  codeWrongLast: 'Wrong code, no tries left. Start connecting again.',
  said: (name) => `${name} said the phrase.`,
  notSaid: (name, why) => `${name} did not say the phrase: ${why}`,
  unpaired: (name) => `${name} is disconnected.`,
  addressNeeded: 'Give the address of NIKA, for example 192.168.1.50',
  notHeard: 'This NIKA is no longer heard on the network. Is she on?',
  sayingCode: 'NIKA is saying the code aloud',
  pairingOver: 'The connecting has ended: start it again',
  noneConnected: 'No NIKA is connected',
  noSuch: 'No such NIKA',
  noRequests: 'No requests are waiting',
  noneOnline: 'No NIKA is connected now',
  noRequest: 'There is no such request: it was answered or it expired',
};

const DE: PageTexts = {
  paired: 'Verbunden:',
  found: 'Im Netz gefunden, nicht verbunden:',
  none: 'Noch keine NIKA verbunden: «NIKA verbinden» drücken.',
  noneFound: 'Im Netz wurde keine NIKA gefunden. Ist sie an und im selben Netz? Sie kann über ihre Adresse verbunden werden.',
  online: (since, host) => `verbunden seit ${since} (${host})`,
  connecting: 'verbinde…',
  offline: (why) => `keine Verbindung: ${why}`,
  speaksOff: 'sagt keine Benachrichtigungen (Einstellungen → Benachrichtigungen)',
  pendingNone: 'Keine Anfragen.',
  pendingLine: (nika, what, at, left, speaker) => `${at} ${nika}${speaker ? ` (gefragt von ${speaker})` : ''}: ${what} — wartet noch ${left} Min.`,
  journalNone: 'Noch nichts.',
  outcomes: {
    done: 'gegeben',
    failed: 'fehlgeschlagen',
    asked: 'Eltern gefragt',
    approved: 'erlaubt',
    declined: 'nicht erlaubt',
    expired: 'keine Antwort',
    refused: 'abgelehnt',
  },
  by: (who) => (who === 'chat' ? 'im Chat' : 'auf der Seite'),
  connected: (name) => `${name} ist verbunden.`,
  codeWrong: (left) => `Falscher Code. Versuche übrig: ${left}.`,
  codeWrongLast: 'Falscher Code, keine Versuche mehr. Verbinden neu starten.',
  said: (name) => `${name} hat den Satz gesagt.`,
  notSaid: (name, why) => `${name} hat den Satz nicht gesagt: ${why}`,
  unpaired: (name) => `${name} ist getrennt.`,
  addressNeeded: 'Geben Sie die Adresse von NIKA an, zum Beispiel 192.168.1.50',
  notHeard: 'Diese NIKA ist im Netz nicht mehr zu hören. Ist sie an?',
  sayingCode: 'NIKA sagt den Code',
  pairingOver: 'Das Verbinden ist beendet: neu starten',
  noneConnected: 'Keine NIKA ist verbunden',
  noSuch: 'Diese NIKA gibt es nicht',
  noRequests: 'Keine Anfragen',
  noneOnline: 'Gerade ist keine NIKA verbunden',
  noRequest: 'Diese Anfrage gibt es nicht: sie wurde beantwortet oder ist abgelaufen',
};

export function pageTexts(lang: Lang): PageTexts {
  return lang === 'en' ? EN : lang === 'de' ? DE : RU;
}

export function clock(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(new Date(at));
}

export function dayClock(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(
    new Date(at),
  );
}

export function nikaLabel(nika: { name: string; room: string }): string {
  return nika.room ? `${nika.name} — ${nika.room}` : nika.name;
}

export function statusText(lang: Lang, links: LinkView[], found: FoundNika[], timeZone?: string): string {
  const t = pageTexts(lang);
  const lines: string[] = [];
  if (links.length) {
    lines.push(t.paired);
    for (const link of links) {
      const where = link.nika.host ? `${link.nika.host}:${link.nika.port}` : '';
      const state =
        link.state === 'online'
          ? t.online(clock(link.since ?? Date.now(), timeZone), where)
          : link.state === 'connecting' && !link.error
            ? t.connecting
            : t.offline(link.error ?? '—');
      lines.push(`• ${nikaLabel(link.nika)}: ${state}${link.nika.speaks ? '' : `; ${t.speaksOff}`}`);
    }
  } else {
    lines.push(t.none);
  }
  const paired = new Set(links.map((link) => link.nika.id));
  const others = found.filter((nika) => !paired.has(nika.id));
  if (others.length) {
    lines.push('', t.found);
    for (const nika of others) lines.push(`• ${nikaLabel(nika)} (${nika.host})`);
  } else if (!links.length) {
    lines.push(t.noneFound);
  }
  return lines.join('\n');
}

export function pendingText(lang: Lang, pending: PendingGrant[], now: number, timeZone?: string): string {
  const t = pageTexts(lang);
  if (!pending.length) return t.pendingNone;
  return pending
    .map((grant) => t.pendingLine(grant.nikaName, grant.summary, clock(grant.at, timeZone), Math.max(0, Math.ceil((grant.expiresAt - now) / 60_000)), grant.speaker))
    .join('\n');
}

export function pendingLabel(grant: PendingGrant, timeZone?: string): string {
  return `${clock(grant.at, timeZone)} ${grant.nikaName}: ${grant.summary}`;
}

export function journalText(lang: Lang, journal: JournalEntry[], timeZone?: string): string {
  const t = pageTexts(lang);
  if (!journal.length) return t.journalNone;
  return journal
    .slice(0, 30)
    .map((entry) => {
      const who = entry.speaker ? ` (${entry.speaker})` : '';
      const by = entry.by ? `, ${t.by(entry.by)}` : '';
      const detail = entry.detail ? `: ${entry.detail}` : '';
      return `${dayClock(entry.at, timeZone)} ${entry.nika}${who}: ${entry.summary} — ${t.outcomes[entry.outcome]}${by}${detail}`;
    })
    .join('\n');
}
