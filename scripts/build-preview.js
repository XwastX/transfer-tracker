/**
 * Собирает однофайловое превью дашборда для публикации как Artifact.
 *
 * Это тот же интерфейс, что и в приложении, но без сервера: слой api() подменён
 * на встроенный офлайн-датасет. Живые данные из transfermarkt-api в превью
 * недоступны — публикуемая страница не может ходить на внешние хосты.
 *
 * Собрать: node scripts/build-preview.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { positionGroup } from '../lib/pipeline.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const seed = JSON.parse(read('data/seed.json'));
for (const p of seed.players) p.positionGroup = positionGroup(p.position);

let html = read('public/index.html');
const css = read('public/styles.css');
let js = read('public/app.js');

// ── 1. Подменяем сетевой слой на встроенный датасет ───────────────────────────
const REAL_API = `async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return res.json();
}`;

const PREVIEW_API = `const SEED = window.__SEED__;

/** Превью: вместо сервера отвечает встроенный офлайн-датасет. */
async function api(path) {
  const u = new URL(path, 'http://preview');
  const p = u.pathname;

  if (p === '/api/dataset') return { ...SEED, version: 0 };

  if (p === '/api/status') {
    return {
      source: 'seed', status: 'idle', version: 0,
      progress: { done: 1, total: 1, step: 'Готово' },
      builtAt: SEED.generatedAt, error: null, upstream: null,
      generatedAt: SEED.generatedAt, note: SEED.note,
      counts: {
        players: SEED.players.length, clubs: SEED.clubs.length,
        transfers: SEED.transfers.length, competitions: SEED.competitions.length,
      },
      config: { apiUrl: null, competitions: SEED.competitions.map((c) => c.id), refreshMinutes: 0 },
    };
  }

  const pm = p.match(/^\\/api\\/players\\/(.+)$/);
  if (pm) {
    const id = decodeURIComponent(pm[1]);
    const player = SEED.players.find((x) => x.id === id) || null;
    return {
      source: 'seed',
      player,
      history: player ? player.history : [],
      transfers: SEED.transfers.filter((t) => t.playerId === id),
      ranking: null,
    };
  }

  if (p === '/api/search') {
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    return {
      source: 'local',
      results: SEED.players
        .filter((x) => x.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((x) => ({ id: x.id, name: x.name, club: x.clubName, marketValue: x.marketValue, position: x.position })),
    };
  }

  throw new Error('404');
}`;

if (!js.includes(REAL_API)) throw new Error('не найден блок api() в public/app.js — превью не собрано');
js = js.replace(REAL_API, PREVIEW_API);

// ── 2. Плашка: в превью нечего «обновлять», текст должен это отражать ────────
const REAL_NOTE = /function noteBlock\(\) \{[\s\S]*?\n\}/;
const PREVIEW_NOTE = `function noteBlock() {
  return \`<div class="note">
    <span>⚠</span>
    <div><b>Интерактивное превью.</b> Здесь встроен офлайн-срез из открытых публикаций на 25.08.2026;
    помесячная история стоимости в нём синтезирована. Живые данные Transfermarkt подключаются
    только в локальной версии — она ходит в self-hosted API, а опубликованная страница внешние
    запросы делать не может. Всё остальное — фильтры, сортировка, поиск, карточки игроков — рабочее.</div>
  </div>\`;
}`;
if (!REAL_NOTE.test(js)) throw new Error('не найден noteBlock() в public/app.js');
js = js.replace(REAL_NOTE, PREVIEW_NOTE);

// ── 3. Убираем управление, которому в превью нечем управлять ─────────────────
js = js.replace(/\$\('#refresh-btn'\)\.addEventListener[\s\S]*?\n\}\);\n/, '');
js = js.replace(/\s*setInterval\(pollStatus, 4000\);/, '');
js = js.replace(
  "'<div class=\"empty\">Сервер не отвечает. Запустите <code>node server.js</code>.</div>'",
  "'<div class=\"empty\">Не удалось загрузить данные превью.</div>'",
);

html = html.replace(/\s*<button id="refresh-btn"[\s\S]*?<\/button>/, '');

// ── 4. Разворачиваем в один файл ─────────────────────────────────────────────
html = html
  .replace(/^[\s\S]*?<title>/, '<title>')                       // до <title> — служебная обвязка
  .replace(/<title>[^<]*<\/title>/, '<title>Transfer Tracker</title>')
  .replace(/<link rel="stylesheet" href="\/styles\.css"[^>]*>/, `<style>\n${css}\n</style>`)
  .replace(/<link rel="icon"[^>]*>/, '')
  .replace(/<\/head>\s*<body>/, '')
  .replace(/<script src="\/app\.js"[^>]*><\/script>/,
    `<script>window.__SEED__ = ${JSON.stringify(seed)};</script>\n<script type="module">\n${js}\n</script>`)
  .replace(/<\/body>\s*<\/html>\s*$/, '')
  .trim();

const out = resolve(root, 'preview.html');
writeFileSync(out, html);
console.log(`preview.html — ${(html.length / 1024).toFixed(0)} КБ, игроков: ${seed.players.length}`);
