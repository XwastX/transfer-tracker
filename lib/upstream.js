/**
 * Клиент к self-hosted transfermarkt-api (https://github.com/felipeall/transfermarkt-api).
 * Очередь с ограничением параллелизма, ретраи, дисковый кэш ответов.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class Upstream {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl      базовый URL API (например http://localhost:8000)
   * @param {string} opts.cacheFile    путь к файлу дискового кэша
   * @param {number} opts.ttlMs        время жизни записи кэша
   * @param {number} opts.concurrency  сколько запросов одновременно
   * @param {number} opts.timeoutMs    таймаут одного запроса
   */
  constructor({ baseUrl, cacheFile, ttlMs = 6 * 3600_000, concurrency = 3, timeoutMs = 20_000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cacheFile = cacheFile;
    this.ttlMs = ttlMs;
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
    this.active = 0;
    this.queue = [];
    this.dirty = false;
    this.stats = { hits: 0, misses: 0, errors: 0 };
    this.#loadCache();
    // Периодический сброс кэша на диск, чтобы не писать на каждый запрос.
    this.flushTimer = setInterval(() => this.flush(), 15_000);
    this.flushTimer.unref?.();
  }

  #loadCache() {
    try {
      if (!existsSync(this.cacheFile)) return;
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8'));
      const now = Date.now();
      for (const [k, v] of Object.entries(raw)) {
        if (v && now - v.at < this.ttlMs) this.cache.set(k, v);
      }
    } catch {
      /* повреждённый кэш — просто игнорируем */
    }
  }

  flush() {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(Object.fromEntries(this.cache)));
      this.dirty = false;
    } catch {
      /* кэш — не критичный ресурс */
    }
  }

  /** Проверка доступности апстрима (быстрая, без кэша). */
  async ping() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(`${this.baseUrl}/`, { signal: ctrl.signal });
      return res.ok || res.status === 404;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  /** GET с кэшем и очередью. Возвращает JSON или бросает исключение. */
  get(path, { force = false } = {}) {
    const key = path;
    if (!force) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < this.ttlMs) {
        this.stats.hits++;
        return Promise.resolve(hit.data);
      }
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ path, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.#fetchWithRetry(job.path)
        .then((data) => {
          this.cache.set(job.path, { at: Date.now(), data });
          this.dirty = true;
          this.stats.misses++;
          job.resolve(data);
        })
        .catch((err) => {
          this.stats.errors++;
          job.reject(err);
        })
        .finally(() => {
          this.active--;
          this.#pump();
        });
    }
  }

  async #fetchWithRetry(path, attempt = 0) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: res.status < 500 });
      return await res.json();
    } catch (err) {
      if (!err.fatal && attempt < 2) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        return this.#fetchWithRetry(path, attempt + 1);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
