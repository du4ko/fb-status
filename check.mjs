// Проверява публичния статус на Facebook страниците от pages.json
// и обновява data/status.json и data/events.json.
// Изисква Node 20+ (вграден fetch), без външни зависимости.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CONFIG = 'pages.json';
const STATUS = 'data/status.json';
const EVENTS = 'data/events.json';
const HISTORY_LEN = 200;      // колко проверки пазим на страница
const DOWN_CONFIRM = 2;       // поредни "недостъпна" преди да сменим статуса (против фалшиви тревоги)
const MAX_EVENTS = 1000;
const UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const DOWN_TITLES = [
  /content isn.t available/i,
  /page isn.t available/i,
  /page not found/i,
  /съдържанието не е налично/i,
  /страницата не е налична/i,
  /страницата не е намерена/i,
];

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}

function decode(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${prop}["']`, 'i');
  return (html.match(re) || html.match(re2) || [])[1]?.trim() || '';
}

// Чиста функция — лесна за тестване.
export function classify({ status, finalUrl, html }) {
  const title = ((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').trim();
  const ogTitle = meta(html, 'og:title');
  const base = { http: status, title: decode(ogTitle || title) };

  if (status === 404 || status === 410) return { ...base, state: 'down', reason: `HTTP ${status}` };
  if (DOWN_TITLES.some(r => r.test(title) || r.test(ogTitle)))
    return { ...base, state: 'down', reason: 'страница "не е налична"' };
  if (status === 429 || status >= 500) return { ...base, state: 'unknown', reason: `HTTP ${status} (ограничение/грешка)` };
  if (/\/(login|checkpoint)/.test(finalUrl || '') && !ogTitle)
    return { ...base, state: 'unknown', reason: 'пренасочване към вход' };
  if (/^facebook$/i.test(decode(ogTitle)))
    return { ...base, title: '', state: 'unknown', reason: 'общ отговор от Facebook (ограничение)' };
  if (ogTitle) return { ...base, state: 'up', reason: 'намерено og:title' };
  return { ...base, state: 'unknown', reason: 'няма достатъчно сигнали' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const UAS = [
  UA,
  'Mozilla/5.0 (compatible; Twitterbot/1.0)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
];

// Facebook понякога връща общ отговор — пробваме с друг user-agent преди да се откажем.
async function probe(url) {
  let last;
  for (const [i, ua] of UAS.entries()) {
    if (i) await sleep(4000);
    last = await probeOnce(url, ua);
    if (last.state !== 'unknown') return last;
  }
  return last;
}

async function probeOnce(url, ua) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': ua, 'accept-language': 'bg,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const html = (await res.text()).slice(0, 400000);
    return classify({ status: res.status, finalUrl: res.url, html });
  } catch (e) {
    return { state: 'unknown', reason: 'мрежова грешка: ' + e.message };
  }
}


async function main() {
  const cfg = await readJson(CONFIG, { outlets: [] });
  const status = await readJson(STATUS, { pages: {} });
  const events = await readJson(EVENTS, []);
  const now = new Date().toISOString();

  for (const outlet of cfg.outlets) {
    for (const page of outlet.pages) {
      const url = page.url;
      const rec = status.pages[url] || { state: 'unknown', history: [], consecutiveDown: 0 };
      const prev = rec.state;

      let result;
      if (page.override) {
        result = { state: page.override, reason: 'ръчно зададено' };
      } else {
        result = await probe(url);
        await sleep(3000 + Math.random() * 3000); // учтиво темпо
      }

      rec.history.push([now, result.state]);
      rec.history = rec.history.slice(-HISTORY_LEN);
      rec.lastChecked = now;
      rec.lastReason = result.reason;
      if (result.http) rec.lastHttp = result.http;
      if (result.title) rec.lastTitle = result.title;

      if (result.state === 'up') {
        rec.consecutiveDown = 0;
        rec.lastUp = now;
        if (!rec.firstSeenUp) rec.firstSeenUp = now;
        rec.state = 'up';
        delete rec.downSince;
      } else if (result.state === 'down') {
        rec.consecutiveDown = (rec.consecutiveDown || 0) + 1;
        if (page.override || rec.consecutiveDown >= DOWN_CONFIRM) {
          if (rec.state !== 'down') rec.downSince = now;
          rec.state = 'down';
        }
      }
      // 'unknown' не сменя потвърдения статус

      if (rec.state !== prev && prev !== undefined) {
        events.push({ ts: now, outlet: outlet.id || outlet.pages[0]?.url, url, from: prev, to: rec.state });
      }
      status.pages[url] = rec;
      console.log(`${rec.state.padEnd(7)} ${url}  (${result.reason})`);
    }
  }

  status.generatedAt = now;
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(STATUS, JSON.stringify(status, null, 1));
  await fs.writeFile(EVENTS, JSON.stringify(events.slice(-MAX_EVENTS), null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
