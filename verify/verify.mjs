#!/usr/bin/env node
/**
 * Verify-Seo — независимая проверка исполнения ТЗ по живому сайту mikof.md.
 *
 * Ничего не спрашивает у исполнителя: бьёт по боевым URL и по каждой из 22 задач
 * говорит PASS / FAIL / WARN. Источник ожиданий — docs/tz-dev-2026-09.md.
 *
 *   node verify/verify.mjs              полный прогон (с PageSpeed Insights)
 *   node verify/verify.mjs --no-psi     быстрый прогон без PSI
 *   node verify/verify.mjs --only A1,A5 только указанные задачи
 *
 * Требуется Node 18+ (встроенный fetch).
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ORIGIN = 'https://mikof.md';
const UA = 'Mozilla/5.0 (compatible; MikofSeoVerify/1.0; +https://github.com/olazarev2/mikof-seo)';

const argv = process.argv.slice(2);
const NO_PSI = argv.includes('--no-psi');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(',').map(s => s.trim().toUpperCase()) : null;
})();

/* ─── HTTP с кэшем ─────────────────────────────────────────────────────── */

const cache = new Map();

async function get(url, { redirect = 'follow', method = 'GET' } = {}) {
  const key = `${method} ${redirect} ${url}`;
  if (cache.has(key)) return cache.get(key);
  const out = { url, ok: false, status: 0, headers: {}, body: '', error: null };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch(url, {
      redirect, method,
      headers: { 'user-agent': UA, 'accept-language': 'ro,ru;q=0.9,en;q=0.8' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    out.status = res.status;
    out.ok = res.ok;
    res.headers.forEach((v, k) => { out.headers[k.toLowerCase()] = v; });
    out.body = method === 'HEAD' ? '' : await res.text();
  } catch (e) {
    out.error = e.name === 'AbortError' ? 'таймаут 30 с' : e.message;
  }
  cache.set(key, out);
  return out;
}

async function pool(items, worker, limit = 6) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }));
  return out;
}

/* ─── разбор HTML ──────────────────────────────────────────────────────── */

const meta = (html, name) => {
  const tag = html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]*>`, 'i'))?.[0];
  return tag ? (tag.match(/content=["']([\s\S]*?)["']/i)?.[1] ?? '') : null;
};
const ogProp = (html, prop) => {
  const tag = html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]*>`, 'i'))?.[0];
  return tag ? (tag.match(/content=["']([\s\S]*?)["']/i)?.[1] ?? '') : null;
};
const title = html => html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim() ?? null;
const canonical = html =>
  html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/i)?.[1] ?? null;
const h1count = html => (html.match(/<h1[\s>]/gi) || []).length;
const hreflangs = html => (html.match(/<link[^>]+rel=["']alternate["'][^>]*>/gi) || [])
  .map(t => ({ lang: t.match(/hreflang=["']([^"']+)["']/i)?.[1], href: t.match(/href=["']([^"']+)["']/i)?.[1] || '' }))
  .filter(x => x.lang);
const jsonLd = html => (html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [])
  .map(b => b.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, ''))
  .map(raw => { try { return JSON.parse(raw); } catch { return { __invalid: raw.slice(0, 120) }; } });
const ldTypes = html => {
  const walk = (n, acc) => {
    if (!n || typeof n !== 'object') return acc;
    if (Array.isArray(n)) { n.forEach(x => walk(x, acc)); return acc; }
    if (n['@type']) [].concat(n['@type']).forEach(t => acc.add(String(t)));
    Object.values(n).forEach(v => walk(v, acc));
    return acc;
  };
  return [...jsonLd(html).reduce((acc, o) => walk(o, acc), new Set())];
};
const links = (html) => {
  const out = new Set();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#][^"']*)["']/gi)) {
    let href = m[1];
    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = ORIGIN + href;
    else if (!/^https?:/i.test(href)) continue;
    if (/^https:\/\/(www\.)?mikof\.md/i.test(href)) out.add(href.split('#')[0]);
  }
  return [...out];
};
const stripTags = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ');

/* ─── реестр задач ─────────────────────────────────────────────────────── */

const TASKS = [
  ['A1', 'P0', 'Склеить www и non-www'],
  ['A2', 'P0', 'Вывести цены в HTML'],
  ['A3', 'P0', 'Добавить h1 и иерархию заголовков'],
  ['A4', 'P0', 'Починить hreflang'],
  ['A5', 'P0', 'Переписать sitemap и robots.txt'],
  ['A6', 'P0', 'Починить генератор meta description'],
  ['A7', 'P0', 'Переписать title'],
  ['B1', 'P1', 'Structured data (JSON-LD)'],
  ['B2', 'P1', 'Производительность'],
  ['B3', 'P1', 'Open Graph и Twitter Card'],
  ['B4', 'P1', 'Хлебные крошки'],
  ['B5', 'P1', 'Каннибализация и дубли страниц'],
  ['B6', 'P1', 'Расхождение NAP (часы работы)'],
  ['C1', 'P2', 'ЧПУ для страниц услуг'],
  ['C2', 'P2', 'Даты и авторство статей'],
  ['C3', 'P2', 'Доступность для AI-поиска (llms.txt)'],
  ['C4', 'P2', 'Внутренняя перелинковка'],
  ['C5', 'P2', 'Маршруты VisuMax / SMILE Pro'],
  ['D1', 'P3', 'Аналитика и Search Console'],
  ['D2', 'P3', 'Языковые мелочи'],
  ['D3', 'P3', 'Орфография и диакритика'],
  ['D4', 'P3', 'Заголовки кеширования'],
];

const results = new Map();
const record = (id, status, detail, extra = []) => results.set(id, { status, detail, extra });

const TYPOS = ['oftolmolog', 'compurizat', 'Kishinev', 'Servicele', 'acuițății', 'Amigdalăctomia',
  'axigen', 'переметрия', 'ультрозвуковая', 'Retinal disinsertion', 'Laser koagularea', 'distsiziya'];

/* ─── проверки ─────────────────────────────────────────────────────────── */

async function checkA1() {
  const www = await get('https://www.mikof.md/', { redirect: 'manual' });
  const loc = www.headers.location || '';
  const redirOk = [301, 308].includes(www.status) && /^https:\/\/mikof\.md/.test(loc);
  const ru = await get(`${ORIGIN}/ru`);
  const can = canonical(ru.body);
  const canOk = can !== null && !/www\.mikof\.md/i.test(can);
  record('A1', redirOk && canOk ? 'PASS' : 'FAIL',
    redirOk && canOk ? 'www склеен, canonical не наследует хост'
      : !redirOk ? `www.mikof.md отдаёт ${www.status || www.error}, ожидался 301 на https://mikof.md/`
        : 'canonical указывает на www-версию',
    [`www.mikof.md → ${www.status}${loc ? ' ' + loc : ''}`, `canonical /ru: ${can ?? 'отсутствует'}`]);
}

async function checkA2() {
  let best = null;
  for (const u of [`${ORIGIN}/preturi`, `${ORIGIN}/prices.shtml`]) {
    const r = await get(u);
    const lei = (r.body.match(/\blei\b/gi) || []).length;
    const rows = (r.body.match(/<tr[\s>]/gi) || []).length;
    if (!best || lei > best.lei) best = { url: u, status: r.status, lei, rows };
  }
  record('A2', best.lei >= 50 ? 'PASS' : 'FAIL',
    `${best.url} (${best.status}): ${best.lei} вхождений «lei» в исходном HTML, порог 50; строк таблиц ${best.rows}`,
    [best.lei >= 50 ? 'цены доступны без JavaScript' : 'цены по-прежнему грузит Livewire — для краулеров прайса нет']);
}

function checkA3(sample) {
  const bad = sample.filter(p => h1count(p.body) !== 1);
  record('A3', bad.length === 0 ? 'PASS' : 'FAIL',
    `ровно один <h1> на ${sample.length - bad.length} из ${sample.length} страниц выборки`,
    bad.slice(0, 8).map(p => `${p.url} → h1: ${h1count(p.body)}`));
}

async function checkA4() {
  const urls = [`${ORIGIN}/service/34`, `${ORIGIN}/ru/service/34`, `${ORIGIN}/en/service/34`];
  const pages = await pool(urls, u => get(u));
  const sets = pages.map(p => hreflangs(p.body));
  const norm = s => s.map(x => `${x.lang.toLowerCase()}=${x.href.replace(/\/$/, '')}`).sort().join('|');
  const variants = new Set(sets.map(norm)).size;
  const hasX = sets.every(s => s.some(x => x.lang.toLowerCase() === 'x-default'));
  const four = sets.every(s => s.length === 4);
  record('A4', variants === 1 && hasX && four ? 'PASS' : 'FAIL',
    `наборов hreflang: ${variants} (нужен 1), записей ${sets.map(s => s.length).join('/')} (нужно 4/4/4), x-default: ${hasX ? 'есть' : 'нет'}`,
    sets.map((s, i) => `${urls[i]} → ${s.map(x => x.lang).join(', ') || 'нет alternate'}`));
}

async function checkA5() {
  const sm = await get(`${ORIGIN}/sitemap.xml`);
  const locs = [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
  const rb = await get(`${ORIGIN}/robots.txt`);
  const hasDirective = /^\s*sitemap:/im.test(rb.body);
  const probe = [...locs].sort(() => Math.random() - 0.5).slice(0, 10);
  const codes = await pool(probe, async u => ({ u, s: (await get(u, { redirect: 'manual' })).status }), 5);
  const broken = codes.filter(c => c.s !== 200);
  record('A5', locs.length >= 300 && hasDirective && broken.length === 0 ? 'PASS' : 'FAIL',
    `sitemap: ${locs.length} <loc> при пороге 300; директива Sitemap: в robots.txt ${hasDirective ? 'есть' : 'нет'}; битых из ${probe.length} проверенных: ${broken.length}`,
    broken.map(b => `${b.s} ${b.u}`));
}

function checkA6(sample) {
  const ds = sample.map(p => ({ url: p.url, d: meta(p.body, 'description') }));
  const empty = ds.filter(x => !x.d || !x.d.trim());
  const entities = ds.filter(x => x.d && /&[a-z]+;|&#\d+;/i.test(x.d));
  const ellipsis = ds.filter(x => x.d && /(\.\.\.|…)\s*$/.test(x.d));
  const uniq = new Set(ds.map(x => (x.d || '').trim()).filter(Boolean)).size;
  const ratio = ds.length ? uniq / ds.length : 0;
  record('A6', empty.length === 0 && entities.length === 0 && ellipsis.length === 0 && ratio >= 0.9 ? 'PASS' : 'FAIL',
    `пустых ${empty.length}, с HTML-сущностями ${entities.length}, с концевым «...» ${ellipsis.length}, уникальных ${uniq}/${ds.length} (${Math.round(ratio * 100)}%, порог 90%)`,
    [...empty.slice(0, 4).map(x => `пусто: ${x.url}`), ...entities.slice(0, 4).map(x => `сущности: ${x.url} → ${x.d.slice(0, 70)}`)]);
}

function checkA7(sample) {
  const ts = sample.map(p => ({ url: p.url, t: title(p.body) || '' }));
  const seen = new Map();
  ts.forEach(x => seen.set(x.t, (seen.get(x.t) || 0) + 1));
  const dupes = [...seen.entries()].filter(([t, n]) => n > 1 && t);
  const badLen = ts.filter(x => x.t.length < 30 || x.t.length > 60);
  const typos = ts.filter(x => TYPOS.some(w => x.t.toLowerCase().includes(w.toLowerCase())));
  record('A7', dupes.length === 0 && badLen.length === 0 && typos.length === 0 ? 'PASS' : 'FAIL',
    `дублей title ${dupes.length}, вне длины 30–60 символов ${badLen.length} из ${ts.length}, с опечатками ${typos.length}`,
    [...dupes.slice(0, 4).map(([t, n]) => `×${n}: ${t}`),
     ...typos.slice(0, 4).map(x => `опечатка: ${x.t}`),
     ...badLen.slice(0, 4).map(x => `${x.t.length} симв.: ${x.t || '(пусто)'} — ${x.url}`)]);
}

async function checkB1() {
  const targets = [
    [`${ORIGIN}/`, ['MedicalClinic', 'MedicalBusiness', 'Organization', 'LocalBusiness', 'Hospital']],
    [`${ORIGIN}/service/34`, ['MedicalProcedure', 'MedicalTest', 'Service', 'MedicalWebPage']],
    [`${ORIGIN}/doctors.shtml`, ['Physician', 'Person']],
  ];
  const rows = [];
  let ok = 0;
  for (const [u, want] of targets) {
    const p = await get(u);
    const types = ldTypes(p.body);
    if (types.some(t => want.includes(t))) ok++;
    rows.push(`${u} → ${types.length ? types.join(', ') : 'JSON-LD нет'}`);
  }
  record('B1', ok === targets.length ? 'PASS' : 'FAIL', `размётано ${ok} из ${targets.length} эталонных страниц`, rows);
}

async function checkB2() {
  const home = await get(`${ORIGIN}/`);
  const imgs = [...home.body.matchAll(/<img[^>]*>/gi)].map(m => m[0]);
  const noDims = imgs.filter(t => !/\bwidth=/i.test(t) || !/\bheight=/i.test(t));
  const noLazy = imgs.filter(t => !/loading=["']?lazy/i.test(t));
  let psiLine = 'PageSpeed не запрашивался (--no-psi)';
  let psiPass = null;
  if (!NO_PSI) {
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(ORIGIN + '/')}&strategy=mobile&category=performance`;
    const r = await get(api);
    try {
      const j = JSON.parse(r.body);
      const score = Math.round((j.lighthouseResult?.categories?.performance?.score ?? 0) * 100);
      const bytes = j.lighthouseResult?.audits?.['total-byte-weight']?.numericValue;
      const kb = bytes ? Math.round(bytes / 1024) : null;
      psiPass = score >= 70 && (kb === null || kb <= 1200);
      psiLine = `PSI mobile ${score}/100 при пороге 70, вес страницы ${kb ?? '?'} КБ при пороге 1200`;
    } catch {
      psiLine = `PSI недоступен (${r.status || r.error}) — проверить вручную на pagespeed.web.dev`;
    }
  }
  const dimsOk = noDims.length === 0;
  record('B2', psiPass === null ? (dimsOk ? 'WARN' : 'FAIL') : (psiPass && dimsOk ? 'PASS' : 'FAIL'),
    `${psiLine}; <img> без width/height: ${noDims.length} из ${imgs.length}; без lazy: ${noLazy.length}`,
    psiPass === null ? ['часть проверки не выполнена — запустите без --no-psi'] : []);
}

async function checkB3() {
  const rows = [];
  let ok = 0;
  for (const u of [`${ORIGIN}/`, `${ORIGIN}/service/34`]) {
    const p = await get(u);
    const t = ogProp(p.body, 'og:title'), img = ogProp(p.body, 'og:image'), tw = meta(p.body, 'twitter:card');
    if (t && img && tw) ok++;
    rows.push(`${u} → og:title ${t ? 'есть' : 'нет'}, og:image ${img ? 'есть' : 'нет'}, twitter:card ${tw ? 'есть' : 'нет'}`);
  }
  record('B3', ok === 2 ? 'PASS' : 'FAIL', `полный набор на ${ok} из 2 страниц`, rows);
}

async function checkB4() {
  const rows = [];
  let ok = 0;
  for (const u of [`${ORIGIN}/service/34`, `${ORIGIN}/ru/service/34`]) {
    const p = await get(u);
    const has = ldTypes(p.body).includes('BreadcrumbList');
    if (has) ok++;
    rows.push(`${u} → BreadcrumbList ${has ? 'есть' : 'нет'}, вёрстка крошек ${/breadcrumb/i.test(p.body) ? 'есть' : 'нет'}`);
  }
  record('B4', ok === 2 ? 'PASS' : 'FAIL', `BreadcrumbList на ${ok} из 2 страниц`, rows);
}

async function checkB5() {
  const a = await get(`${ORIGIN}/service/41`, { redirect: 'manual' });
  const b = await get(`${ORIGIN}/service/69`, { redirect: 'manual' });
  const redirected = [301, 302, 308].includes(b.status) || [301, 302, 308].includes(a.status);
  const canB = b.status === 200 ? canonical(b.body) : null;
  const canonicalised = canB ? /\/service\/41|miopie-corectie|blizorukost/i.test(canB) : false;
  record('B5', redirected || canonicalised ? 'PASS' : 'FAIL',
    redirected || canonicalised ? 'дубль Miopie/Miopia сведён (301 либо canonical)' : 'обе страницы отдают 200 и конкурируют между собой',
    [`/service/41 → ${a.status}${a.status === 200 ? ' · ' + title(a.body) : ''}`,
     `/service/69 → ${b.status}${b.status === 200 ? ' · ' + title(b.body) : ''}`,
     canB ? `canonical у /service/69: ${canB}` : ''].filter(Boolean));
}

async function checkB6() {
  const p = await get(`${ORIGIN}/contact.shtml`);
  const text = stripTags(p.body).replace(/\s+/g, ' ');
  const opens = [...text.matchAll(/(\d{1,2}[:.]\d{2})\s*[–—\-]\s*17[:.]00/g)].map(m => m[1].replace('.', ':'));
  const uniq = [...new Set(opens)];
  record('B6', uniq.length === 1 ? 'PASS' : uniq.length === 0 ? 'WARN' : 'FAIL',
    uniq.length === 1 ? `часы открытия едины: ${uniq[0]}–17:00`
      : uniq.length === 0 ? 'график вида «X–17:00» на странице не найден — проверить вручную'
        : `на одной странице разные часы открытия: ${uniq.join(' и ')}`,
    uniq.length > 1 ? ['в шапке и футере contact.shtml указано разное время — NAP расходится'] : []);
}

async function checkC1() {
  const slugs = [`${ORIGIN}/tomografie-oct-chisinau`, `${ORIGIN}/ru/okt-setchatki-kishinev`, `${ORIGIN}/tratament-cataracta-chisinau`];
  const got = await pool(slugs, async u => ({ u, s: (await get(u, { redirect: 'manual' })).status }));
  const live = got.filter(g => g.s === 200);
  const old = await get(`${ORIGIN}/service/34`, { redirect: 'manual' });
  const redirected = [301, 308].includes(old.status);
  record('C1', live.length === slugs.length && redirected ? 'PASS' : 'FAIL',
    `ЧПУ отвечают 200: ${live.length} из ${slugs.length}; старый /service/34 → ${old.status}${redirected ? '' : ' (ожидался 301)'}`,
    got.map(g => `${g.s} ${g.u}`));
}

async function checkC2(articles) {
  const sample = articles.slice(0, 5);
  if (!sample.length) { record('C2', 'WARN', 'статьи для проверки не найдены в urls.txt'); return; }
  const pages = await pool(sample, u => get(u));
  const good = pages.filter(p => ldTypes(p.body).some(t => /Article|BlogPosting|NewsArticle/.test(t))
    || /datePublished|<time[^>]+datetime=/i.test(p.body));
  record('C2', good.length === pages.length ? 'PASS' : 'FAIL',
    `дата и авторство размечены на ${good.length} из ${pages.length} проверенных статей`,
    pages.filter(p => !good.includes(p)).slice(0, 4).map(p => `нет разметки: ${p.url}`));
}

async function checkC3() {
  const r = await get(`${ORIGIN}/llms.txt`);
  const ok = r.status === 200 && /mikof|microchirurgia/i.test(r.body);
  record('C3', ok ? 'PASS' : 'FAIL',
    `${ORIGIN}/llms.txt → ${r.status}${ok ? `, ${r.body.length} символов` : ''}`,
    ok ? [] : ['зависит также от A2: пока прайс грузит JavaScript, для AI-краулеров цен не существует']);
}

async function checkC4(sample) {
  // Сквозные ссылки (меню, футер) — те, что встречаются минимум на трёх страницах выборки.
  const freq = new Map();
  for (const p of sample) for (const u of new Set(links(p.body))) freq.set(u, (freq.get(u) || 0) + 1);
  const nav = new Set([...freq.entries()].filter(([, n]) => n >= 3).map(([u]) => u));

  const p = await get(`${ORIGIN}/service/34`);
  const own = /\/service\/34\/?$/;                       // языковые версии этой же страницы — не перелинковка
  const inContent = links(p.body).filter(u => !nav.has(u) && !own.test(u));
  const related = inContent.filter(u => /\/service\//.test(u));
  const hasPrice = inContent.some(u => /preturi|prices/i.test(u));
  const hasDoctor = inContent.some(u => /\/doctor/i.test(u));

  record('C4', related.length >= 3 && hasPrice && hasDoctor ? 'PASS' : 'FAIL',
    `на /service/34 контентных ссылок на смежные услуги: ${related.length} (порог 3); ссылка на прайс в контенте ${hasPrice ? 'есть' : 'нет'}; на врача ${hasDoctor ? 'есть' : 'нет'}`,
    [`сквозных ссылок (меню и футер) отфильтровано: ${nav.size}`, ...related.slice(0, 6)]);
}

async function checkC5() {
  const urls = [`${ORIGIN}/visumax`, `${ORIGIN}/ru/visumax`, `${ORIGIN}/en/visumax`];
  const got = await pool(urls, async u => ({ u, s: (await get(u, { redirect: 'manual' })).status }));
  const bad = got.filter(g => g.s === 404 || g.s >= 500 || g.s === 0);
  record('C5', bad.length === 0 ? 'PASS' : 'FAIL',
    `живы (200 или 301): ${urls.length - bad.length} из ${urls.length}`,
    got.map(g => `${g.s} ${g.u}`));
}

async function checkD1() {
  const home = await get(`${ORIGIN}/`);
  const gtm = /GTM-KPJT9QG/.test(home.body);
  const gsc = /google-site-verification/i.test(home.body);
  record('D1', gtm && gsc ? 'PASS' : 'WARN',
    `GTM-KPJT9QG ${gtm ? 'на месте' : 'ПРОПАЛ'}; google-site-verification ${gsc ? 'есть' : 'в HTML нет'}`,
    ['цели GA4, подтверждение домена и отчёты Search Console из HTML не видны — проверять в аккаунтах']);
}

async function checkD2() {
  const nf = await get(`${ORIGIN}/ru/stranica-kotoroy-net-12345`);
  const text = stripTags(nf.body).replace(/\s+/g, ' ');
  const roOn404 = /nu a fost g[ăa]sit/i.test(text);
  const ruLocalised = /не найдена|не существует|Страница не/i.test(text);
  const ru = await get(`${ORIGIN}/ru`);
  const logo = ru.body.match(/<a[^>]+href=["']([^"']+)["'][^>]*>\s*(?:<[^>]+>\s*)*<img[^>]+(?:logo|logotip)/i)?.[1] ?? null;
  const logoOk = logo === null ? null : /\/ru\/?$/.test(logo);
  const sm = await get(`${ORIGIN}/sitemap.xml`);
  const tour = /virtualtour|tur-virtual/i.test(sm.body);
  record('D2', ruLocalised && !roOn404 && logoOk !== false && tour ? 'PASS' : 'FAIL',
    `404 на /ru локализована: ${ruLocalised && !roOn404 ? 'да' : 'нет'}; логотип на /ru ведёт на ${logo ?? 'не определено'}; виртуальный тур в sitemap: ${tour ? 'да' : 'нет'}`,
    [`заголовок 404-страницы: ${(title(nf.body) || '—').slice(0, 80)}`]);
}

function checkD3(sample) {
  const hits = new Map();
  const patterns = [...TYPOS, 'repetati', 'pacientii', 'urmarirea'];
  for (const p of sample) {
    const text = stripTags(p.body);
    for (const w of patterns) {
      const n = (text.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
      if (n) hits.set(w, (hits.get(w) || 0) + n);
    }
  }
  const roPages = sample.filter(p => !/mikof\.md\/(ru|en)(\/|$)/.test(p.url));
  const cedilla = roPages.reduce((n, p) => n + (stripTags(p.body).match(/[şţŞŢ]/g) || []).length, 0);
  const total = [...hits.values()].reduce((a, b) => a + b, 0);
  record('D3', hits.size === 0 && cedilla === 0 ? 'PASS' : 'FAIL',
    `опечаток по словарю: ${total} (${hits.size} видов) на ${sample.length} страницах; седиль ş/ţ вместо ș/ț: ${cedilla}`,
    [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w, n]) => `«${w}» ×${n}`));
}

async function checkD4() {
  const home = await get(`${ORIGIN}/`);
  const asset = home.body.match(/(?:href|src)=["'](\/(?!\/)[^"']+\.(?:css|js))(?:\?[^"']*)?["']/i)?.[1];
  if (!asset) { record('D4', 'WARN', 'статический ресурс на главной не найден — проверить вручную'); return; }
  const r = await get(ORIGIN + asset);
  const cc = r.headers['cache-control'] || '';
  const age = Number(cc.match(/max-age=(\d+)/)?.[1] ?? 0);
  record('D4', age >= 86400 ? 'PASS' : 'WARN',
    `${asset} → Cache-Control: ${cc || 'заголовка нет'} (ожидается max-age ≥ 86400)`,
    ['HTML намеренно отдаётся no-cache; задача низкоприоритетная, дефектом не является']);
}

/* ─── прогон ───────────────────────────────────────────────────────────── */

function loadUrls() {
  const f = join(ROOT, 'docs', 'data', 'urls.txt');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => /^https?:/.test(s));
}

async function main() {
  const started = Date.now();
  const all = loadUrls();
  const articles = all.filter(u => /\.shtml$/i.test(u)
    && !/(contact|prices|services|doctors|clinic|reviews|question|gallery|POLITICA|visumax|smile)/i.test(u));

  const sampleUrls = [...new Set([
    `${ORIGIN}/`, `${ORIGIN}/ru`, `${ORIGIN}/en`,
    `${ORIGIN}/services.shtml`, `${ORIGIN}/doctors.shtml`, `${ORIGIN}/contact.shtml`,
    `${ORIGIN}/prices.shtml`, `${ORIGIN}/service/34`, `${ORIGIN}/ru/service/34`,
    `${ORIGIN}/service/35`, `${ORIGIN}/service/41`, `${ORIGIN}/ru/service/29`,
    ...articles.slice(0, 8),
  ])];

  process.stderr.write(`Сканирую ${sampleUrls.length} страниц выборки…\n`);
  const sample = (await pool(sampleUrls, u => get(u))).filter(p => p.status === 200 && p.body);
  process.stderr.write(`Получено ${sample.length}. Прогоняю проверки…\n`);

  const runners = {
    A1: checkA1, A2: checkA2, A3: () => checkA3(sample), A4: checkA4, A5: checkA5,
    A6: () => checkA6(sample), A7: () => checkA7(sample), B1: checkB1, B2: checkB2,
    B3: checkB3, B4: checkB4, B5: checkB5, B6: checkB6, C1: checkC1,
    C2: () => checkC2(articles), C3: checkC3, C4: () => checkC4(sample), C5: checkC5,
    D1: checkD1, D2: checkD2, D3: () => checkD3(sample), D4: checkD4,
  };

  for (const [id] of TASKS) {
    if (ONLY && !ONLY.includes(id)) continue;
    try {
      await runners[id]();
    } catch (e) {
      record(id, 'WARN', `проверка не выполнена: ${e.message}`);
    }
    process.stderr.write(`  ${id} ${results.get(id).status}\n`);
  }

  const shown = TASKS.filter(([id]) => results.has(id));
  const counts = { PASS: 0, FAIL: 0, WARN: 0 };
  shown.forEach(([id]) => { counts[results.get(id).status]++; });

  const mark = { PASS: '[v]', FAIL: '[x]', WARN: '[!]' };
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  console.log('');
  console.log(`SEO-техдолг mikof.md — прогон ${stamp} UTC`);
  console.log('-'.repeat(112));
  for (const [id, pri, name] of shown) {
    const r = results.get(id);
    console.log(`${mark[r.status]} ${pad(id, 4)}${pad(pri, 4)}${pad(name, 38)}${r.detail}`);
  }
  console.log('-'.repeat(112));
  console.log(`Выполнено ${counts.PASS} из ${shown.length}   ·   не сделано ${counts.FAIL}   ·   требует внимания ${counts.WARN}`);

  const date = new Date().toISOString().slice(0, 10);
  const md = [
    `# Отчёт проверки — ${date}`,
    '',
    `Сайт: ${ORIGIN} · выборка ${sample.length} страниц · режим: ${NO_PSI ? 'без PageSpeed' : 'полный'} · прогон ${Math.round((Date.now() - started) / 1000)} с.`,
    '',
    `**Выполнено ${counts.PASS} из ${shown.length}.** Не сделано ${counts.FAIL}, требует внимания ${counts.WARN}.`,
    '',
    '| Задача | Приоритет | Статус | Что показала проверка |',
    '|---|---|---|---|',
    ...shown.map(([id, pri, name]) => {
      const r = results.get(id);
      return `| **${id}**. ${name} | ${pri} | ${r.status} | ${r.detail.replace(/\|/g, '\\|')} |`;
    }),
    '',
    '## Детали',
    '',
    ...shown.flatMap(([id, , name]) => {
      const extra = (results.get(id).extra || []).filter(Boolean);
      return extra.length ? [`### ${id}. ${name}`, '', ...extra.map(e => `- ${String(e).replace(/\|/g, '\\|')}`), ''] : [];
    }),
    '## Что скрипт не проверяет',
    '',
    '- **B1** — Google Rich Results Test: открытого API нет, прогонять вручную на https://search.google.com/test/rich-results',
    '- **D1** — цели GA4, подтверждение домена и отчёты в Search Console: видны только в аккаунтах',
    '- **C1** — полнота карты редиректов по всем 49 услугам: проверяются три образца',
    '- **C4** — качество перелинковки по смыслу: проверяется только количество и наличие ключевых ссылок',
    '',
  ].join('\n');

  mkdirSync(join(HERE, 'reports'), { recursive: true });
  const out = join(HERE, 'reports', `${date}.md`);
  writeFileSync(out, md, 'utf8');
  console.log(`Отчёт сохранён: verify/reports/${date}.md`);
}

main();
