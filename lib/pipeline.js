/**
 * Сборка нормализованного датасета из живого API + журнал изменений стоимости.
 *
 * Апстрим (transfermarkt-api) отдаёт только «сырые» срезы: клубы лиги, состав клуба,
 * профиль/история игрока. Здесь они агрегируются в тот же формат, что и data/seed.json,
 * чтобы фронтенд не знал, откуда пришли данные.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const COMP_META = {
  GB1: { name: 'Премьер-лига', country: 'Англия', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  ES1: { name: 'Ла Лига', country: 'Испания', flag: '🇪🇸' },
  IT1: { name: 'Серия А', country: 'Италия', flag: '🇮🇹' },
  L1: { name: 'Бундеслига', country: 'Германия', flag: '🇩🇪' },
  FR1: { name: 'Лига 1', country: 'Франция', flag: '🇫🇷' },
  RU1: { name: 'РПЛ', country: 'Россия', flag: '🇷🇺' },
  NL1: { name: 'Эредивизи', country: 'Нидерланды', flag: '🇳🇱' },
  PO1: { name: 'Примейра-лига', country: 'Португалия', flag: '🇵🇹' },
  TR1: { name: 'Суперлига', country: 'Турция', flag: '🇹🇷' },
  BE1: { name: 'Про-лига', country: 'Бельгия', flag: '🇧🇪' },
};

const POSITION_RU = {
  Goalkeeper: 'Вратарь',
  'Centre-Back': 'Центральный защитник',
  'Left-Back': 'Левый защитник',
  'Right-Back': 'Правый защитник',
  'Defensive Midfield': 'Опорный полузащитник',
  'Central Midfield': 'Центральный полузащитник',
  'Attacking Midfield': 'Атакующий полузащитник',
  'Left Midfield': 'Левый полузащитник',
  'Right Midfield': 'Правый полузащитник',
  'Left Winger': 'Левый вингер',
  'Right Winger': 'Правый вингер',
  'Second Striker': 'Оттянутый нападающий',
  'Centre-Forward': 'Нападающий',
  Defender: 'Защитник',
  Midfield: 'Полузащитник',
  Attack: 'Нападающий',
};

export const translatePosition = (p) => (p ? POSITION_RU[p] || p : '—');

/** Крупные группы позиций — для фильтра на фронтенде. */
export function positionGroup(ru) {
  if (!ru) return 'other';
  if (ru.includes('Вратарь')) return 'GK';
  if (ru.includes('полузащитник')) return 'MF';
  if (ru.includes('защитник')) return 'DF';
  return 'FW';
}

export class Pipeline {
  constructor({ upstream, competitions, clubsPerCompetition, transferPlayers, trackingFile, seed }) {
    this.up = upstream;
    this.competitions = competitions;
    this.clubsPerCompetition = clubsPerCompetition;
    this.transferPlayers = transferPlayers;
    this.trackingFile = trackingFile;
    this.seed = seed;

    this.dataset = seed;
    this.state = {
      source: 'seed',
      status: 'idle', // idle | building | live | error
      progress: { done: 0, total: 0, step: 'Ожидание' },
      builtAt: null,
      error: null,
      upstream: upstream.baseUrl,
      version: 0,
    };
    this.tracking = this.#loadTracking();
    this.running = null;
  }

  #loadTracking() {
    try {
      if (existsSync(this.trackingFile)) return JSON.parse(readFileSync(this.trackingFile, 'utf8'));
    } catch {
      /* пустой журнал */
    }
    return {};
  }

  #saveTracking() {
    try {
      mkdirSync(dirname(this.trackingFile), { recursive: true });
      writeFileSync(this.trackingFile, JSON.stringify(this.tracking));
    } catch {
      /* журнал не критичен */
    }
  }

  /**
   * Журнал стоимостей: для каждого игрока храним точки [дата, значение],
   * записывая только реальные изменения. Отсюда берётся дельта «за период».
   */
  #track(playerId, value, today) {
    if (!Number.isFinite(value)) return null;
    const log = (this.tracking[playerId] ||= []);
    const last = log[log.length - 1];
    if (!last || last[1] !== value) {
      if (last && last[0] === today) log[log.length - 1] = [today, value];
      else log.push([today, value]);
      if (log.length > 60) log.splice(0, log.length - 60);
    }
    const prev = [...log].reverse().find((p) => p[1] !== value);
    return prev ? prev[1] : null;
  }

  #setProgress(done, total, step) {
    this.state.progress = { done, total, step };
  }

  /** Запускает пересборку; повторный вызов во время сборки возвращает текущий промис. */
  refresh({ force = false } = {}) {
    if (this.running) return this.running;
    this.running = this.#build({ force })
      .catch((err) => {
        this.state.status = this.dataset === this.seed ? 'error' : 'live';
        this.state.error = err.message || String(err);
      })
      .finally(() => {
        this.running = null;
        this.up.flush();
        this.#saveTracking();
      });
    return this.running;
  }

  async #build({ force }) {
    this.state.status = 'building';
    this.state.error = null;
    this.#setProgress(0, 1, 'Проверка соединения с API');

    const alive = await this.up.ping();
    if (!alive) throw new Error(`API недоступен: ${this.up.baseUrl}`);

    const today = new Date().toISOString().slice(0, 10);
    const comps = [];
    const clubs = [];
    const players = [];

    // Шаг 1 — списки клубов по лигам.
    this.#setProgress(0, this.competitions.length, 'Загрузка списков клубов');
    const compClubs = [];
    let done = 0;
    for (const compId of this.competitions) {
      try {
        const data = await this.up.get(`/competitions/${compId}/clubs`, { force });
        const list = (data.clubs || []).slice(0, this.clubsPerCompetition);
        compClubs.push({ compId, name: data.name || COMP_META[compId]?.name || compId, clubs: list });
      } catch {
        compClubs.push({ compId, name: COMP_META[compId]?.name || compId, clubs: [] });
      }
      this.#setProgress(++done, this.competitions.length, 'Загрузка списков клубов');
    }

    // Шаг 2 — профили и составы клубов.
    const clubJobs = compClubs.flatMap((c) => c.clubs.map((club) => ({ ...club, compId: c.compId })));
    const total = clubJobs.length * 2;
    done = 0;
    this.#setProgress(0, total, 'Загрузка составов');

    const results = await this.#mapLimited(clubJobs, 3, async (job) => {
      let profile = null;
      let squad = null;
      try {
        profile = await this.up.get(`/clubs/${job.id}/profile`, { force });
      } catch {
        /* профиль опционален */
      }
      this.#setProgress(++done, total, 'Загрузка составов');
      try {
        squad = await this.up.get(`/clubs/${job.id}/players`, { force });
      } catch {
        /* состав опционален */
      }
      this.#setProgress(++done, total, 'Загрузка составов');
      return { job, profile, squad };
    });

    for (const { job, profile, squad } of results) {
      const meta = COMP_META[job.compId] || {};
      const squadPlayers = (squad?.players || []).filter((p) => p && p.id);
      const totalValue =
        profile?.currentMarketValue ??
        squadPlayers.reduce((s, p) => s + (p.marketValue || 0), 0) ??
        0;
      const ages = squadPlayers.map((p) => p.age).filter(Number.isFinite);

      clubs.push({
        id: String(job.id),
        name: profile?.name || job.name,
        image: profile?.image || null,
        competitionId: job.compId,
        competitionName: meta.name || job.compId,
        country: meta.country || profile?.league?.countryName || '—',
        totalValue,
        squadSize: profile?.squad?.size ?? squadPlayers.length,
        avgAge:
          profile?.squad?.averageAge ??
          (ages.length ? Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10 : null),
        transferRecord: profile?.currentTransferRecord ?? null,
        stadium: profile?.stadiumName || null,
      });

      for (const p of squadPlayers) {
        const positionRu = translatePosition(p.position);
        const id = String(p.id);
        const previousValue = this.#track(id, p.marketValue, today);
        players.push({
          id,
          name: p.name,
          position: positionRu,
          positionGroup: positionGroup(positionRu),
          age: p.age ?? null,
          nationality: p.nationality || [],
          clubId: String(job.id),
          clubName: profile?.name || job.name,
          competitionId: job.compId,
          competitionName: meta.name || job.compId,
          marketValue: p.marketValue ?? null,
          previousValue,
          contract: p.contract || null,
          history: null, // подгружается по требованию в карточке игрока
        });
      }
    }

    if (!players.length) throw new Error('API ответил, но составы пустые — проверьте апстрим');

    players.sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));

    // Шаг 3 — лента трансферов по самым дорогим игрокам.
    const top = players.slice(0, this.transferPlayers);
    done = 0;
    this.#setProgress(0, top.length, 'Сбор ленты трансферов');
    const clubNameById = new Map(clubs.map((c) => [c.id, c.name]));
    const transfers = [];
    await this.#mapLimited(top, 3, async (p) => {
      try {
        const data = await this.up.get(`/players/${p.id}/transfers`, { force });
        for (const t of data.transfers || []) {
          transfers.push({
            id: `${p.id}-${t.id ?? t.date}`,
            playerId: p.id,
            playerName: p.name,
            position: p.position,
            age: p.age,
            from: { id: t.clubFrom?.id ?? null, name: t.clubFrom?.name || '—' },
            to: { id: t.clubTo?.id ?? null, name: t.clubTo?.name || '—' },
            competitionId: clubNameById.has(String(t.clubTo?.id)) ? p.competitionId : null,
            date: t.date,
            fee: t.fee ?? null,
            marketValue: t.marketValue ?? null,
            upcoming: !!t.upcoming,
            season: t.season || null,
          });
        }
      } catch {
        /* игрок без истории — пропускаем */
      }
      this.#setProgress(++done, top.length, 'Сбор ленты трансферов');
    });

    // Только текущее и предстоящее окно, свежие сверху.
    const cutoff = new Date(Date.now() - 200 * 86400_000).toISOString().slice(0, 10);
    const feed = transfers
      .filter((t) => t.date && (t.date >= cutoff || t.upcoming))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 120);

    // Шаг 4 — сводка по лигам.
    for (const compId of this.competitions) {
      const meta = COMP_META[compId] || {};
      const inComp = clubs.filter((c) => c.competitionId === compId);
      const records = inComp.map((c) => c.transferRecord).filter(Number.isFinite);
      comps.push({
        id: compId,
        name: meta.name || compId,
        country: meta.country || '—',
        flag: meta.flag || '⚽',
        clubs: inComp.length,
        totalValue: inComp.reduce((s, c) => s + (c.totalValue || 0), 0),
        spent: records.filter((v) => v < 0).reduce((s, v) => s - v, 0),
        income: records.filter((v) => v > 0).reduce((s, v) => s + v, 0),
      });
    }

    for (const c of clubs) {
      const rec = c.transferRecord;
      c.balance = Number.isFinite(rec) ? rec : null;
      c.spent = Number.isFinite(rec) && rec < 0 ? -rec : 0;
      c.income = Number.isFinite(rec) && rec > 0 ? rec : 0;
    }

    clubs.sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0));

    this.dataset = {
      source: 'live',
      generatedAt: new Date().toISOString(),
      competitions: comps,
      clubs,
      players: players.slice(0, 800),
      transfers: feed,
    };
    this.state.source = 'live';
    this.state.status = 'live';
    this.state.builtAt = this.dataset.generatedAt;
    this.state.version++;
    this.#setProgress(1, 1, 'Готово');
    this.#saveTracking();
    return this.dataset;
  }

  /** Карточка игрока: профиль + история стоимости + трансферы. */
  async playerDetail(id) {
    const local = this.dataset.players.find((p) => p.id === id) || this.seed.players.find((p) => p.id === id);
    if (String(id).startsWith('seed-')) {
      return {
        source: 'seed',
        player: local || null,
        history: local?.history || [],
        transfers: this.seed.transfers.filter((t) => t.playerId === id),
        ranking: null,
      };
    }
    const [profile, mv, tr] = await Promise.allSettled([
      this.up.get(`/players/${id}/profile`),
      this.up.get(`/players/${id}/market_value`),
      this.up.get(`/players/${id}/transfers`),
    ]);
    const p = profile.status === 'fulfilled' ? profile.value : null;
    const m = mv.status === 'fulfilled' ? mv.value : null;
    const t = tr.status === 'fulfilled' ? tr.value : null;
    const positionRu = translatePosition(p?.position?.main);
    return {
      source: 'live',
      player: {
        id: String(id),
        name: p?.name || local?.name || '—',
        image: p?.imageUrl || null,
        position: p ? positionRu : local?.position || '—',
        positionGroup: positionGroup(p ? positionRu : local?.position),
        age: p?.age ?? local?.age ?? null,
        height: p?.height ?? null,
        foot: p?.foot ?? null,
        nationality: p?.citizenship || local?.nationality || [],
        clubName: p?.club?.name || local?.clubName || '—',
        clubId: p?.club?.id || local?.clubId || null,
        competitionName: local?.competitionName || '—',
        contract: p?.club?.contractExpires || local?.contract || null,
        marketValue: m?.marketValue ?? p?.marketValue ?? local?.marketValue ?? null,
        previousValue: local?.previousValue ?? null,
        url: p?.url || `https://www.transfermarkt.com/-/profil/spieler/${id}`,
      },
      history: (m?.marketValueHistory || []).map((h) => ({
        date: h.date,
        value: h.marketValue,
        clubName: h.clubName,
        age: h.age,
      })),
      ranking: m?.ranking || null,
      transfers: (t?.transfers || []).map((x) => ({
        id: `${id}-${x.id ?? x.date}`,
        from: { id: x.clubFrom?.id ?? null, name: x.clubFrom?.name || '—' },
        to: { id: x.clubTo?.id ?? null, name: x.clubTo?.name || '—' },
        date: x.date,
        fee: x.fee ?? null,
        marketValue: x.marketValue ?? null,
        upcoming: !!x.upcoming,
        season: x.season || null,
      })),
    };
  }

  /** Поиск игрока по имени через апстрим (fallback — локальный по датасету). */
  async search(query) {
    const q = query.trim().toLowerCase();
    const localHits = this.dataset.players
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((p) => ({ id: p.id, name: p.name, club: p.clubName, marketValue: p.marketValue, position: p.position }));
    if (this.state.source !== 'live') return { source: 'local', results: localHits };
    try {
      const data = await this.up.get(`/players/search/${encodeURIComponent(query)}`);
      const results = (data.results || []).slice(0, 8).map((r) => ({
        id: String(r.id),
        name: r.name,
        club: r.club?.name || '—',
        marketValue: r.marketValue ?? null,
        position: translatePosition(r.position),
      }));
      return { source: 'api', results: results.length ? results : localHits };
    } catch {
      return { source: 'local', results: localHits };
    }
  }

  async #mapLimited(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }
}
