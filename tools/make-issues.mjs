#!/usr/bin/env node
/**
 * Нарезает docs/tz-dev-2026-09.md на тела GitHub Issues — по одному файлу на задачу.
 * Тексты берутся из ТЗ дословно, ничего не переписывается вручную.
 *
 *   node tools/make-issues.mjs          → tools/issues/A1.md … D4.md + _meta.json
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TZ = join(ROOT, 'docs', 'tz-dev-2026-09.md');
const OUT = join(HERE, 'issues');
const LIVE = 'https://mikof-seo-tz.vercel.app';

const PRIORITY = { A: 'P0', B: 'P1', C: 'P2', D: 'P3' };
const BLOCK_NAME = {
  A: 'Технический фундамент',
  B: 'Разметка и представление',
  C: 'Структура и AI-видимость',
  D: 'Измеримость и гигиена',
};

const src = readFileSync(TZ, 'utf8').split(/\r?\n/);

/* ─── нарезка по «### <ID>. <название>» ────────────────────────────────── */

const heads = [];
src.forEach((line, i) => {
  const m = line.match(/^###\s+([A-D]\d)\.\s+(.+?)\s*$/);
  if (m) heads.push({ id: m[1], name: m[2], line: i });
});

const stopAt = src.findIndex(l => /^##\s+Критерии приёмки/.test(l));

const tasks = heads.map((h, idx) => {
  const end = idx + 1 < heads.length ? heads[idx + 1].line : (stopAt > 0 ? stopAt : src.length);
  let body = src.slice(h.line + 1, end);
  // отрезаем хвостовые разделители и заголовок следующего блока
  while (body.length && /^(---\s*)?$/.test(body[body.length - 1])) body.pop();
  while (body.length && /^##\s+Блок/.test(body[body.length - 1])) body.pop();
  while (body.length && /^(---\s*)?$/.test(body[body.length - 1])) body.pop();
  return { ...h, block: h.id[0], body: body.join('\n').trim() };
});

if (tasks.length !== 22) {
  console.error(`Ожидалось 22 задачи, найдено ${tasks.length}: ${tasks.map(t => t.id).join(', ')}`);
  process.exitCode = 1;
}

/* ─── вопросы к заказчику ──────────────────────────────────────────────── */

const askStart = src.findIndex(l => /^##\s+Что нужно от заказчика/.test(l));
const askEnd = src.findIndex((l, i) => i > askStart && /^##\s/.test(l));
const askBody = src.slice(askStart + 1, askEnd > 0 ? askEnd : src.length)
  .join('\n').replace(/\n---\s*$/, '').trim();

/* ─── запись ───────────────────────────────────────────────────────────── */

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const meta = [];

for (const t of tasks) {
  const pri = PRIORITY[t.block];
  const md = [
    `> Задача **${t.id}** из блока ${t.block} — ${BLOCK_NAME[t.block]} (${pri}).`,
    `> Полное ТЗ: ${LIVE}#${t.id.toLowerCase()} · исходник: [\`docs/tz-dev-2026-09.md\`](../blob/main/docs/tz-dev-2026-09.md)`,
    '',
    t.body,
    '',
    '---',
    '',
    '### Как проверяется приёмка',
    '',
    '```bash',
    `node verify/verify.mjs --only ${t.id}`,
    '```',
    '',
    `Закрывать задачу, когда эта проверка даёт **PASS**. Отчёты копятся в \`verify/reports/\`.`,
  ].join('\n');

  writeFileSync(join(OUT, `${t.id}.md`), md, 'utf8');
  meta.push({ id: t.id, title: `${t.id}. ${t.name.replace(/`/g, '')}`, priority: pri, block: t.block, file: `tools/issues/${t.id}.md` });
}

const askMd = [
  '> Блокеры на стороне заказчика: пока на них нет ответа, часть задач нельзя ни начать, ни принять.',
  '',
  askBody,
  '',
  '---',
  '',
  'Отмечать выполненное галочками; закрыть, когда все пункты получены.',
  '',
  ...askBody.split('\n').filter(l => /^\d+\.\s/.test(l)).map(l => `- [ ] ${l.replace(/^\d+\.\s*/, '')}`),
].join('\n');

writeFileSync(join(OUT, 'ASK.md'), askMd, 'utf8');
meta.push({ id: 'ASK', title: 'Вопросы к заказчику до старта работ', priority: 'P0', block: 'ASK', file: 'tools/issues/ASK.md' });

writeFileSync(join(OUT, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');

console.log(`Готово: ${tasks.length} задач + вопросы к заказчику → ${OUT}`);
tasks.forEach(t => console.log(`  ${t.id} ${PRIORITY[t.block]}  ${t.name}  (${t.body.length} символов)`));
