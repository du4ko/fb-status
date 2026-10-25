// Cloudflare Worker: приема предложения за страници и дава админ панел за одобрение.
//
// Нужни настройки в Cloudflare (Workers → твоят worker → Settings → Variables and Secrets):
//   Secret  ADMIN_PASSWORD  — паролата за /admin
//   Secret  GITHUB_TOKEN    — fine-grained token само за du4ko/fb-status, Contents: Read and write
//   KV binding  SUGGESTIONS — KV namespace за предложенията
// В кода няма никакви тайни — той може спокойно да е публичен.

const REPO = 'du4ko/fb-status';
const BRANCH = 'main';
const ALLOWED_ORIGINS = [
  'https://xn--80aabddj5cofbfba3aiu.com',
  'https://www.xn--80aabddj5cofbfba3aiu.com',
  'https://du4ko.github.io',
  'http://localhost:3000',
];
const SUGGEST_LIMIT_PER_HOUR = 5;
const LOGIN_FAILS_LIMIT = 5;          // грешни опита...
const LOGIN_BLOCK_SECONDS = 15 * 60;  // ...и блокиране за 15 мин.
const SESSION_HOURS = 12;

// ---------- помощни ----------
const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const clientIp = req => req.headers.get('cf-connecting-ip') || 'unknown';
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function cors(req) {
  const o = req.headers.get('origin');
  if (!o || !ALLOWED_ORIGINS.includes(o)) return {};
  return { 'access-control-allow-origin': o, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' };
}

// Приема само публични адреси на facebook.com и ги свежда до един вид.
export function normalizeFacebookUrl(input) {
  let u;
  try { u = new URL(String(input).trim().replace(/^(?!https?:\/\/)/i, 'https://')); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!/^(www\.|m\.|web\.|mbasic\.)?facebook\.com$/.test(host) && host !== 'fb.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'profile.php') {
    const id = u.searchParams.get('id');
    return id && /^\d{5,20}$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : null;
  }
  if (parts[0] === 'people' && parts[2] && /^\d{5,20}$/.test(parts[2])) return `https://www.facebook.com/profile.php?id=${parts[2]}`;
  if (!parts[0] || /^(groups|events|watch|reel|share|story\.php|permalink\.php|photo|photos|login|help|settings|marketplace|gaming)$/i.test(parts[0])) return null;
  if (!/^[A-Za-z0-9.\-_]{3,80}$/.test(parts[0])) return null;
  return `https://www.facebook.com/${parts[0]}`;
}

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
function safeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
// Сесийният ключ се извежда от паролата: смяна на паролата = изхвърляне на всички сесии.
const sessionKey = env => 'session:' + env.ADMIN_PASSWORD;
async function makeSession(env) {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  return `${exp}.${await hmac(sessionKey(env), String(exp))}`;
}
async function isAdmin(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)fbs_admin=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Date.now() > +exp) return false;
  return safeEqual(sig, await hmac(sessionKey(env), exp));
}
const cookie = (v, maxAge) => `fbs_admin=${v}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function bump(kv, key, ttl) {
  const n = (+(await kv.get(key)) || 0) + 1;
  await kv.put(key, String(n), { expirationTtl: ttl });
  return n;
}

// ---------- GitHub ----------
async function gh(env, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fb-status-worker',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const b64decodeUtf8 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));
const b64encodeUtf8 = s => { let bin = ''; for (const b of enc.encode(s)) bin += String.fromCharCode(b); return btoa(bin); };

async function readPages(env) {
  const f = await gh(env, `contents/pages.json?ref=${BRANCH}`);
  return { sha: f.sha, data: JSON.parse(b64decodeUtf8(f.content)) };
}
const allUrls = data => new Set(data.outlets.flatMap(o => o.pages.map(p => p.url)));

function slug(s) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sht',ъ:'a',ь:'y',ю:'yu',я:'ya' };
  return String(s).toLowerCase().replace(/[а-я]/g, c => map[c] ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'media';
}

// ---------- маршрути ----------
async function handleSuggest(req, env) {
  const h = cors(req);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Невалидна заявка.' }, 400, h); }
  if (body.website) return json({ ok: true }, 200, h); // капан за ботове
  const url = normalizeFacebookUrl(body.url);
  if (!url) return json({ error: 'Моля, въведи линк към публична Facebook страница.' }, 400, h);
  const ip = clientIp(req);
  if (await bump(env.SUGGESTIONS, `rl:${ip}`, 3600) > SUGGEST_LIMIT_PER_HOUR)
    return json({ error: 'Твърде много предложения. Опитай пак след час.' }, 429, h);

  const key = `s:${await hmac('dedupe', url)}`;
  if (await env.SUGGESTIONS.get(key)) return json({ ok: true, duplicate: true }, 200, h);
  await env.SUGGESTIONS.put(key, JSON.stringify({
    url, name: clean(body.name, 80), note: clean(body.note, 300), at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 60 }); // неодобрените изчезват след 60 дни
  return json({ ok: true }, 200, h);
}

const REPORT_REASONS = { down: 'Свалена, но пише „Активна“', wrong: 'Грешно име или снимка', notsatire: 'Не е сатирична', personal: 'Личен профил', fake: 'Фалшив профил, представя се за друг', other: 'Друго' };
const REPORT_LIMIT_PER_HOUR = 10;

async function handleReport(req, env) {
  const h = cors(req);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Невалидна заявка.' }, 400, h); }
  if (body.website) return json({ ok: true }, 200, h);
  const url = normalizeFacebookUrl(body.url);
  const reason = REPORT_REASONS[body.reason] ? body.reason : 'other';
  if (!url) return json({ error: 'Невалидна страница.' }, 400, h);
  const ip = clientIp(req);
  if (await bump(env.SUGGESTIONS, `rlr:${ip}`, 3600) > REPORT_LIMIT_PER_HOUR)
    return json({ error: 'Твърде много сигнали. Опитай пак след час.' }, 429, h);

  const key = `r:${await hmac('report', url)}`;
  const ipTag = (await hmac('ip', ip)).slice(0, 12); // само хеш, без реалния IP
  const rec = (await env.SUGGESTIONS.get(key, 'json')) || { url, reports: [] };
  if (!rec.reports.some(r => r.ip === ipTag && r.reason === reason)) {
    rec.reports.push({ reason, note: clean(body.note, 300), at: new Date().toISOString(), ip: ipTag });
    rec.reports = rec.reports.slice(-50);
    await env.SUGGESTIONS.put(key, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 60 });
  }
  return json({ ok: true }, 200, h);
}

// Брояч на посетители: всеки посетител се брои веднъж на ден.
// Пази се само еднопосочен хеш (IP + браузър + дата), без самия IP.
const VISITS_BASE = 45; // посещенията, отчетени от GoatCounter преди този брояч
async function handleVisit(req, env) {
  const h = cors(req);
  const day = new Date().toISOString().slice(0, 10);
  const tag = (await hmac('visit:' + day, clientIp(req) + '|' + (req.headers.get('user-agent') || ''))).slice(0, 16);
  let total = +(await env.SUGGESTIONS.get('visits:total')) || 0;
  try {
    if (!(await env.SUGGESTIONS.get(`v:${day}:${tag}`))) {
      await env.SUGGESTIONS.put(`v:${day}:${tag}`, '1', { expirationTtl: 2 * 86400 });
      total += 1;
      await env.SUGGESTIONS.put('visits:total', String(total));
    }
  } catch { /* при достигнат лимит на KV просто показваме текущото число */ }
  return json({ count: total + VISITS_BASE }, 200, { ...h, 'cache-control': 'no-store' });
}

async function handleLogin(req, env) {
  const ip = clientIp(req);
  const fails = +(await env.SUGGESTIONS.get(`fail:${ip}`)) || 0;
  if (fails >= LOGIN_FAILS_LIMIT) return Response.redirect(new URL('/admin?e=blocked', req.url), 303);
  const form = await req.formData();
  if (!env.ADMIN_PASSWORD || !safeEqual(String(form.get('password') || ''), env.ADMIN_PASSWORD)) {
    await bump(env.SUGGESTIONS, `fail:${ip}`, LOGIN_BLOCK_SECONDS);
    return Response.redirect(new URL('/admin?e=wrong', req.url), 303);
  }
  await env.SUGGESTIONS.delete(`fail:${ip}`);
  return new Response(null, { status: 303, headers: { location: '/admin', 'set-cookie': cookie(await makeSession(env), SESSION_HOURS * 3600) } });
}

async function listSuggestions(env, prefix = 's:') {
  const out = [];
  let cursor;
  do {
    const page = await env.SUGGESTIONS.list({ prefix, cursor });
    for (const k of page.keys) {
      const v = await env.SUGGESTIONS.get(k.name, 'json');
      if (v) out.push({ id: k.name, ...v });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => String(a.at || a.reports?.at(-1)?.at).localeCompare(String(b.at || b.reports?.at(-1)?.at)));
}

async function handleApi(req, env, action) {
  if (action === 'list') {
    const [items, reps, pages] = await Promise.all([listSuggestions(env), listSuggestions(env, 'r:'), readPages(env)]);
    const known = allUrls(pages.data);
    const names = Object.fromEntries(pages.data.outlets.flatMap(o => o.pages.map(p => [p.url, p.name || o.name || ''])));
    const marks = Object.fromEntries(pages.data.outlets.flatMap(o => o.pages.map(p => [p.url, { flag: p.flag || '', note: p.note || '' }])));
    return json({
      items: items.map(i => ({ ...i, alreadyListed: known.has(i.url) })),
      reports: reps.map(r => ({ id: r.id, url: r.url, name: names[r.url] || '', listed: known.has(r.url), ...(marks[r.url] || { flag: '', note: '' }),
        reports: r.reports.map(x => ({ reason: REPORT_REASONS[x.reason] || x.reason, note: x.note, at: x.at })) })),
      outlets: pages.data.outlets.map(o => ({ id: o.id || o.pages[0]?.url, name: o.name || o.pages[0]?.name || o.pages[0]?.url })),
    });
  }
  const body = await req.json().catch(() => ({}));
  if (action === 'mark') {
    const rep = body.id?.startsWith('r:') ? await env.SUGGESTIONS.get(body.id, 'json') : null;
    if (!rep) return json({ error: 'Сигналът вече не съществува.' }, 404);
    const flag = clean(body.flag, 60), note = clean(body.note, 300);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { sha, data } = await readPages(env);
      const page = data.outlets.flatMap(o => o.pages).find(p => p.url === rep.url);
      if (!page) return json({ error: 'Страницата вече не е в списъка.' }, 404);
      if (flag) page.flag = flag; else delete page.flag;
      if (note) page.note = note; else delete page.note;
      try {
        await gh(env, 'contents/pages.json', { method: 'PUT', body: JSON.stringify({
          message: `Маркирана страница: ${page.name || rep.url}${flag ? ' — ' + flag : ''}`,
          content: b64encodeUtf8(JSON.stringify(data, null, 2) + '\n'), sha, branch: BRANCH,
        }) });
        break;
      } catch (e) {
        if (String(e).includes('GitHub 409') && attempt < 2) continue;
        throw e;
      }
    }
    if (body.keep !== true) await env.SUGGESTIONS.delete(body.id);
    return json({ ok: true });
  }
  if (action === 'dismiss' || action === 'removepage') {
    const rep = body.id?.startsWith('r:') ? await env.SUGGESTIONS.get(body.id, 'json') : null;
    if (!rep) return json({ error: 'Сигналът вече не съществува.' }, 404);
    if (action === 'removepage') {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { sha, data } = await readPages(env);
        if (!allUrls(data).has(rep.url)) break;
        data.outlets = data.outlets
          .map(o => ({ ...o, pages: o.pages.filter(p => p.url !== rep.url) }))
          .filter(o => o.pages.length);
        try {
          await gh(env, 'contents/pages.json', { method: 'PUT', body: JSON.stringify({
            message: `Премахната страница: ${rep.url}`,
            content: b64encodeUtf8(JSON.stringify(data, null, 2) + '\n'), sha, branch: BRANCH,
          }) });
          break;
        } catch (e) {
          if (String(e).includes('GitHub 409') && attempt < 2) continue;
          throw e;
        }
      }
    }
    await env.SUGGESTIONS.delete(body.id);
    return json({ ok: true });
  }
  const item = body.id?.startsWith('s:') ? await env.SUGGESTIONS.get(body.id, 'json') : null;
  if (!item) return json({ error: 'Предложението вече не съществува.' }, 404);

  if (action === 'reject') {
    await env.SUGGESTIONS.delete(body.id);
    return json({ ok: true });
  }
  if (action === 'approve') {
    const name = clean(body.name, 80) || item.name;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { sha, data } = await readPages(env);
      if (!allUrls(data).has(item.url)) {
        const page = { url: item.url, added: new Date().toISOString().slice(0, 10), ...(name ? { name } : {}) };
        const target = body.outlet && data.outlets.find(o => (o.id || o.pages[0]?.url) === body.outlet);
        if (target) target.pages.unshift(page);
        else {
          let id = slug(name || item.url.split(/[/=]/).pop()), n = 2;
          const ids = new Set(data.outlets.map(o => o.id));
          while (ids.has(id)) id = `${slug(name || 'media')}-${n++}`;
          data.outlets.push({ id, ...(name ? { name } : {}), pages: [page] });
        }
        try {
          await gh(env, 'contents/pages.json', { method: 'PUT', body: JSON.stringify({
            message: `Добавена страница: ${name || item.url}`,
            content: b64encodeUtf8(JSON.stringify(data, null, 2) + '\n'),
            sha, branch: BRANCH,
          }) });
        } catch (e) {
          if (String(e).includes('GitHub 409') && attempt < 2) continue; // някой друг е писал междувременно
          throw e;
        }
      }
      await env.SUGGESTIONS.delete(body.id);
      return json({ ok: true });
    }
  }
  return json({ error: 'Непознато действие.' }, 400);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/visit' && req.method === 'POST') return await handleVisit(req, env);
      if (url.pathname === '/suggest' || url.pathname === '/report' || url.pathname === '/visit') {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
        if (req.method === 'POST') return await (url.pathname === '/suggest' ? handleSuggest : handleReport)(req, env);
      }
      if (url.pathname === '/admin' && req.method === 'GET') return new Response(ADMIN_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      });
      if (url.pathname === '/admin/login' && req.method === 'POST') return await handleLogin(req, env);
      if (url.pathname === '/admin/logout' && req.method === 'POST')
        return new Response(null, { status: 303, headers: { location: '/admin', 'set-cookie': cookie('', 0) } });
      const m = url.pathname.match(/^\/admin\/api\/(list|approve|reject|dismiss|removepage|mark)$/);
      if (m) {
        if (!(await isAdmin(req, env))) return json({ error: 'auth' }, 401);
        if (m[1] !== 'list' && (req.method !== 'POST' || !(req.headers.get('content-type') || '').includes('application/json')))
          return json({ error: 'Невалидна заявка.' }, 400);
        return await handleApi(req, env, m[1]);
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ error: 'Грешка: ' + e.message }, 500, (url.pathname === '/suggest' || url.pathname === '/report') ? cors(req) : {});
    }
  },
};

// ---------- админ страница ----------
const ADMIN_HTML = `<!doctype html>
<html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Админ панел</title>
<style>
:root{--bg:#2a2c30;--card:#34373c;--text:#ececec;--muted:#a3a7ae;--line:#45484e;--up:#2fb36b;--down:#e05555;--accent:#8fb0ff;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}h1{font-size:1.4rem}h2{font-size:1.1rem;margin:22px 0 10px}a{color:var(--accent);word-break:break-all}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.muted{color:var(--muted);font-size:.85rem}.warn{color:#f0c060;font-size:.85rem}
input,select,button{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#2a2c30;color:var(--text)}
button{cursor:pointer}.ok{background:var(--up);border-color:var(--up);color:#fff}.no{background:transparent;border-color:var(--down);color:var(--down)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}.row input,.row select{flex:1;min-width:160px}
.top{display:flex;justify-content:space-between;align-items:center;gap:8px}
</style></head><body><main>
<div class="top"><h1>Админ панел</h1><form method="post" action="/admin/logout" id="lo" hidden><button>Изход</button></form></div>
<div id="app" class="muted">Зареждане…</div>
</main>
<script>
const app=document.getElementById('app');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const err=new URLSearchParams(location.search).get('e');
function login(){
  app.innerHTML='<form class="card" method="post" action="/admin/login"><p>Вход</p>'+
  (err==='wrong'?'<p class="warn">Грешна парола.</p>':'')+(err==='blocked'?'<p class="warn">Твърде много опити. Опитай след 15 минути.</p>':'')+
  '<div class="row"><input type="password" name="password" placeholder="Парола" autofocus required><button class="ok">Вход</button></div></form>';
}
const FLAGS=['','Фалшив профил','Представя се за друг','Не е сатира','Личен профил','Свалена'];
async function load(){
  const r=await fetch('/admin/api/list',{credentials:'same-origin'});
  if(r.status===401)return login();
  const d=await r.json(); if(d.error){app.textContent=d.error;return}
  document.getElementById('lo').hidden=false;
  const opts='<option value="">➕ Нова медия</option>'+d.outlets.map(o=>'<option value="'+esc(o.id)+'">към: '+esc(o.name)+'</option>').join('');
  let html='<h2>Сигнали ('+d.reports.length+')</h2>';
  html+=d.reports.length?d.reports.map(r=>
   '<div class="card" data-id="'+esc(r.id)+'">'+
   '<b>'+esc(r.name||'Страница')+'</b> · <a href="'+esc(r.url)+'" target="_blank" rel="noopener noreferrer">'+esc(r.url)+'</a>'+
   (r.listed?'':' <span class="warn">(вече не е в списъка)</span>')+
   r.reports.map(x=>'<div class="muted">⚑ '+esc(x.reason)+' · '+new Date(x.at).toLocaleString('bg-BG')+(x.note?' — '+esc(x.note):'')+'</div>').join('')+
   (r.listed?'<div class="row"><select class="fl">'+FLAGS.map(f=>'<option'+(f===r.flag?' selected':'')+' value="'+esc(f)+'">'+esc(f||'— без етикет —')+'</option>').join('')+
     (r.flag&&!FLAGS.includes(r.flag)?'<option selected value="'+esc(r.flag)+'">'+esc(r.flag)+'</option>':'')+'</select>'+
     '<input class="nt" placeholder="Публична бележка към страницата" value="'+esc(r.note)+'"><button class="ok" data-a="mark">Маркирай</button></div>':'')+
   '<div class="row"><button class="ok" data-a="dismiss">Премахни сигнала</button>'+
   (r.listed?'<button class="no" data-a="removepage" data-confirm="1">Махни страницата от сайта</button>':'')+
   '<span class="muted st"></span></div></div>').join(''):'<div class="card muted">Няма сигнали.</div>';
  html+='<h2>Предложения ('+d.items.length+')</h2>';
  html+=d.items.length?'<p class="warn">Одобрявай само публични страници, не лични профили на хора.</p>'+d.items.map(i=>
   '<div class="card" data-id="'+esc(i.id)+'">'+
   '<a href="'+esc(i.url)+'" target="_blank" rel="noopener noreferrer">'+esc(i.url)+'</a>'+
   (i.alreadyListed?' <span class="warn">(вече е в списъка)</span>':'')+
   '<div class="muted">'+new Date(i.at).toLocaleString('bg-BG')+(i.note?' · '+esc(i.note):'')+'</div>'+
   '<div class="row"><input class="nm" placeholder="Име" value="'+esc(i.name)+'"><select class="ou">'+opts+'</select></div>'+
   '<div class="row"><button class="ok" data-a="approve">Одобри</button><button class="no" data-a="reject">Откажи</button><span class="muted st"></span></div></div>').join(''):'<div class="card muted">Няма нови предложения.</div>';
  app.innerHTML=html;
}
app.addEventListener('click',async e=>{
  const b=e.target.closest('button[data-a]'); if(!b)return;
  if(b.dataset.confirm&&!confirm('Сигурен ли си, че искаш да махнеш тази страница от сайта?'))return;
  const c=b.closest('.card'), st=c.querySelector('.st'), nm=c.querySelector('.nm'), ou=c.querySelector('.ou');
  c.querySelectorAll('button').forEach(x=>x.disabled=true); st.textContent='…';
  const r=await fetch('/admin/api/'+b.dataset.a,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
    body:JSON.stringify({id:c.dataset.id,name:nm?nm.value:'',outlet:ou?ou.value:'',flag:c.querySelector('.fl')?.value||'',note:c.querySelector('.nt')?.value||''})});
  const d=await r.json().catch(()=>({}));
  if(d.ok){load()}
  else{st.textContent=d.error||'Грешка';c.querySelectorAll('button').forEach(x=>x.disabled=false)}
});
load();
</script></body></html>`;
