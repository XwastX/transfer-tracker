/**
 * Transfer Tracker — сервер без внешних зависимостей (Node 18+).
 *
 *   • раздаёт статику из public/
 *   • проксирует и агрегирует данные self-hosted transfermarkt-api
 *   • мгновенно отдаёт офлайн-датасет, пока живые данные собираются в фоне
 *
 * Настройки — через переменные окружения (см. .env.example).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Upstream } from './lib/upstream.js';
import { Pipeline, positionGroup } from './lib/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Конфигурация ────────────────────────────────────────────────────────────
loadDotEnv(resolve(__dirname, '.env'));

const CONFIG = {
  port: Number(process.env.PORT || 5173),
  host: process.env.HOST || '127.0.0.1',
  apiUrl: process.env.TRANSFERMARKT_API_URL || 'http://localhost:8000',
  competitions: (process.env.COMPETITIONS || 'GB1,ES1,IT1,L1,FR1,RU1').split(',').map((s) => s.trim()).filter(Boolean),
  clubsPerCompetition: Number(process.env.CLUBS_PER_COMPETITION || 20),
  transferPlayers: Number(process.env.TRANSFER_PLAYERS || 60),
  refreshMinutes: Number(process.env.REFRESH_MINUTES || 60),
  cacheTtlHours: Number(process.env.CACHE_TTL_HOURS || 6),
  concurrency: Number(process.env.CONCURRENCY || 3),
  autoRefresh: process.env.AUTO_REFRESH !== 'false',
};

// ── Данные ──────────────────────────────────────────────────────────────────
const seed = JSON.parse(readFileSync(resolve(__dirname, 'data/seed.json'), 'utf8'));
for (const p of seed.players) p.positionGroup = positionGroup(p.position);

const upstream = new Upstream({
  baseUrl: CONFIG.apiUrl,
  cacheFile: resolve(__dirname, '.cache/upstream.json'),
  ttlMs: CONFIG.cacheTtlHours * 3600_000,
  concurrency: CONFIG.concurrency,
});

const pipeline = new Pipeline({
  upstream,
  competitions: CONFIG.competitions,
  clubsPerCompetition: CONFIG.clubsPerCompetition,
  transferPlayers: CONFIG.transferPlayers,
  trackingFile: resolve(__dirname, 'data/tracking.json'),
  seed,
});

// ── Роуты API ───────────────────────────────────────────────────────────────
const routes = {
  '/api/status': () => ({
    ...pipeline.state,
    generatedAt: pipeline.dataset.generatedAt,
    note: pipeline.dataset.source === 'seed' ? seed.note : null,
    counts: {
      players: pipeline.dataset.players.length,
      clubs: pipeline.dataset.clubs.length,
      transfers: pipeline.dataset.transfers.length,
      competitions: pipeline.dataset.competitions.length,
    },
    config: {
      apiUrl: CONFIG.apiUrl,
      competitions: CONFIG.competitions,
      refreshMinutes: CONFIG.refreshMinutes,
    },
    cache: upstream.stats,
  }),

  '/api/dataset': () => ({
    source: pipeline.dataset.source,
    generatedAt: pipeline.dataset.generatedAt,
    version: pipeline.state.version,
    competitions: pipeline.dataset.competitions,
    clubs: pipeline.dataset.clubs,
    players: pipeline.dataset.players,
    transfers: pipeline.dataset.transfers,
  }),

  '/api/refresh': async (url) => {
    const force = url.searchParams.get('force') === '1';
    pipeline.refresh({ force });
    return { started: true, status: pipeline.state.status };
  },
};

async function handleApi(url) {
  if (routes[url.pathname]) return routes[url.pathname](url);

  const player = url.pathname.match(/^\/api\/players\/([^/]+)$/);
  if (player) return pipeline.playerDetail(decodeURIComponent(player[1]));

  const search = url.pathname === '/api/search';
  if (search) {
    const q = url.searchParams.get('q') || '';
    if (q.trim().length < 2) return { source: 'local', results: [] };
    return pipeline.search(q);
  }
  return null;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const PUBLIC_DIR = resolve(__dirname, 'public');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      const payload = await handleApi(url);
      if (payload === null) return send(res, 404, { error: 'Не найдено' });
      return send(res, 200, payload);
    } catch (err) {
      return send(res, 502, { error: err.message || 'Ошибка апстрима' });
    }
  }

  // Статика
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = join(PUBLIC_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Доступ запрещён' });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function loadDotEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* .env не обязателен */
  }
}

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`\n  Transfer Tracker → http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  API апстрим:       ${CONFIG.apiUrl}`);
  console.log(`  Лиги:              ${CONFIG.competitions.join(', ')}`);
  console.log(`  Старт с офлайн-датасета, живые данные подтягиваются в фоне.\n`);

  if (CONFIG.autoRefresh) {
    pipeline.refresh();
    const timer = setInterval(() => pipeline.refresh(), Math.max(5, CONFIG.refreshMinutes) * 60_000);
    timer.unref?.();
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    upstream.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
