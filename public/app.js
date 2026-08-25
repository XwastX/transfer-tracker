/* ───────────────────────────────────────────────────────────────────────────
   Transfer Tracker — клиент.
   Никаких зависимостей: SVG-графики, hash-роутинг, делегирование событий.
   ─────────────────────────────────────────────────────────────────────────── */

const S = {
  data: { competitions: [], clubs: [], players: [], transfers: [], source: 'seed' },
  status: null,
  version: -1,
  filters: {
    players: { comp: 'all', pos: 'all', q: '', sort: 'marketValue', dir: -1, page: 0, ageMax: 'all' },
    transfers: { comp: 'all', min: 0, sort: 'date' },
    clubs: { comp: 'all' },
  },
};

const PAGE_SIZE = 40;
const COLORS = {
  s1: '#3987e5', s2: '#d95926', s3: '#199e70',
  good: '#0ca30c', goodInk: '#46d16d', crit: '#d03b3b', critInk: '#f07070',
  grid: '#232a36', axis: '#2f3644', text2: '#a8b1c1', muted: '#717d90',
  surface: '#141922',
};

/* ── Утилиты ───────────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, html = '') => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (html) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtMoney(v, { compact = true, sign = false } = {}) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  const a = Math.abs(v);
  if (!compact) return s + '€' + a.toLocaleString('ru-RU');
  if (a >= 1e9) return `${s}€${(a / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млрд`;
  if (a >= 1e6) return `${s}€${(a / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: a < 1e7 ? 1 : 0 })} млн`;
  if (a >= 1e3) return `${s}€${Math.round(a / 1e3)} тыс.`;
  return s + '€' + a;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(+dt)) return d;
  return dt.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: '2-digit' });
}

/** Полный год — для дат контрактов, где «30 г.» читается двусмысленно. */
function fmtDateFull(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(+dt)) return d;
  return dt.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

const FOOT_RU = { right: 'правая', left: 'левая', both: 'обе' };

function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(+dt)) return d;
  return dt.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const initials = (name) =>
  String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();

function deltaHtml(cur, prev) {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) {
    return '<span class="delta delta--flat">—</span>';
  }
  const diff = cur - prev;
  const pct = (diff / prev) * 100;
  if (Math.abs(pct) < 0.5) return '<span class="delta delta--flat">0%</span>';
  const up = diff > 0;
  return `<span class="delta delta--${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(
    Math.abs(pct) < 10 ? 1 : 0,
  )}%</span>`;
}

async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ── Тултип ────────────────────────────────────────────────────────────── */

const tip = $('#tooltip');
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14;
  let top = y - r.height - 12;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 18;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => { tip.hidden = true; };

/* ── Графики ───────────────────────────────────────────────────────────── */

/**
 * Горизонтальные бары — сравнение величин. Одна серия → легенда не нужна
 * (заголовок называет её), значения подписаны напрямую у конца марки.
 * Свёрстано на HTML/CSS: текст не искажается при растягивании и остаётся
 * доступным для поиска и скринридера.
 */
function hBarChart(rows, { color = COLORS.s1, valueFmt = fmtMoney } = {}) {
  if (!rows.length) return '<div class="empty">Нет данных</div>';
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  return `<div class="hbar">${rows
    .map((r) => {
      const w = Math.max(0.8, (r.value / max) * 100);
      const tipTxt = `${esc(r.label)}|${valueFmt(r.value)}${r.sub ? '|' + esc(r.sub) : ''}`;
      return `<div class="hbar-row" data-tip="${tipTxt}" ${r.id ? `data-player="${esc(r.id)}"` : ''}>
        <div class="hbar-label" title="${esc(r.label)}">${esc(r.label)}</div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${w}%;background:${color}"></div></div>
        <div class="hbar-value">${valueFmt(r.value)}</div>
      </div>`;
    })
    .join('')}</div>`;
}

/**
 * Диверджентные бары — полярность (потратили ↔ заработали).
 * Пара blue↔red с нейтральной осью посередине; две серии → есть легенда.
 */
function divergingChart(rows) {
  if (!rows.length) return '<div class="empty">Нет данных</div>';
  const max = Math.max(...rows.flatMap((r) => [r.spent || 0, r.income || 0])) || 1;
  return `<div class="dv">${rows
    .map(
      (r) => `<div class="dv-row" data-tip="${esc(r.label)}|Потрачено: ${fmtMoney(r.spent)}|Заработано: ${fmtMoney(r.income)}">
      <div class="dv-label">${esc(r.label)}</div>
      <div class="dv-side dv-side--l"><span class="dv-bar" style="width:${((r.spent || 0) / max) * 100}%;background:${COLORS.crit}"></span></div>
      <div class="dv-axis"></div>
      <div class="dv-side dv-side--r"><span class="dv-bar" style="width:${((r.income || 0) / max) * 100}%;background:${COLORS.s1}"></span></div>
    </div>`,
    )
    .join('')}</div>
  <div class="legend">
    <span><i style="background:${COLORS.crit}"></i>Потрачено</span>
    <span><i style="background:${COLORS.s1}"></i>Заработано</span>
  </div>`;
}

/**
 * Линия — динамика стоимости. Одна серия (заголовок её называет → легенда не нужна),
 * 2px линия, маркер на последней точке, перекрестие с тултипом по наведению.
 * База НЕ нулевая — поэтому заливки под линией нет и обе крайние отметки оси
 * подписаны явно: усечённая шкала допустима для линии, но не для площади.
 */
function lineChart(points, { height = 190 } = {}) {
  if (points.length < 2) return '<div class="empty">Недостаточно точек истории</div>';
  const W = 520;
  const H = height;
  const pad = { l: 8, r: 8, t: 16, b: 24 };
  const vals = points.map((p) => p.value);
  const maxRaw = Math.max(...vals);
  const minRaw = Math.min(...vals);
  const cushion = (maxRaw - minRaw) * 0.18 || maxRaw * 0.1 || 1;
  const maxV = maxRaw + cushion;
  const minV = Math.max(0, minRaw - cushion);
  const span = maxV - minV || 1;
  const x = (i) => pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - minV) / span) * (H - pad.t - pad.b);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');

  // Подписи оси с «гало» под цвет поверхности, чтобы линия не перечёркивала текст.
  const ticks = [maxRaw, (maxRaw + minRaw) / 2, minRaw].map(
    (v) => `<line class="grid-line" x1="${pad.l}" y1="${y(v)}" x2="${W - pad.r}" y2="${y(v)}"></line>
            <text class="axis-label" x="${pad.l}" y="${y(v) - 5}"
                  stroke="${COLORS.surface}" stroke-width="3.5" paint-order="stroke">${fmtMoney(v)}</text>`,
  ).join('');

  const hits = points
    .map((p, i) => {
      const w = (W - pad.l - pad.r) / points.length;
      return `<rect class="pt-hit" x="${(x(i) - w / 2).toFixed(1)}" y="${pad.t}" width="${w.toFixed(1)}"
                height="${H - pad.t - pad.b}" fill="transparent"
                data-i="${i}" data-cx="${x(i).toFixed(1)}" data-cy="${y(p.value).toFixed(1)}"
                data-tip="${esc(fmtDate(p.date))}|${fmtMoney(p.value)}${p.clubName ? '|' + esc(p.clubName) : ''}"></rect>`;
    })
    .join('');

  const first = points[0];
  const last = points[points.length - 1];

  return `
  <svg class="chart chart--area" viewBox="0 0 ${W} ${H}" role="img" data-chart="line"
       preserveAspectRatio="xMidYMid meet">
    ${ticks}
    <path d="${line}" fill="none" stroke="${COLORS.s1}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
    <circle cx="${x(points.length - 1)}" cy="${y(last.value)}" r="4.5" fill="${COLORS.s1}" stroke="${COLORS.surface}" stroke-width="2"></circle>
    <line class="crosshair" x1="0" y1="${pad.t}" x2="0" y2="${H - pad.b}" stroke="${COLORS.axis}" stroke-width="1" opacity="0"></line>
    <circle class="focus-dot" r="5" fill="${COLORS.s1}" stroke="${COLORS.surface}" stroke-width="2" opacity="0"></circle>
    ${hits}
    <text class="axis-label" x="${pad.l}" y="${H - 6}">${esc(fmtDate(first.date))}</text>
    <text class="axis-label" x="${W - pad.r}" y="${H - 6}" text-anchor="end">${esc(fmtDate(last.date))}</text>
  </svg>`;
}

/* ── Компоненты разметки ───────────────────────────────────────────────── */

const tile = (label, value, foot = '') => `
  <div class="card tile">
    <div class="glow"></div>
    <div class="label">${label}</div>
    <div class="value">${value}</div>
    ${foot ? `<div class="foot">${foot}</div>` : ''}
  </div>`;

const posTag = (p) => {
  const g = p?.positionGroup || 'other';
  return `<span class="tag tag--${g}">${esc(p?.position || '—')}</span>`;
};

const avatar = (p) =>
  p?.image
    ? `<span class="avatar"><img src="${esc(p.image)}" alt="" loading="lazy" onerror="this.remove()"></span>`
    : `<span class="avatar">${esc(initials(p?.name))}</span>`;

/* ── Представления ─────────────────────────────────────────────────────── */

function viewOverview() {
  const { players, clubs, competitions, transfers } = S.data;
  const totalValue = clubs.reduce((s, c) => s + (c.totalValue || 0), 0);
  const window26 = transfers.filter((t) => Number.isFinite(t.fee) && t.fee > 0);
  const feeSum = window26.reduce((s, t) => s + t.fee, 0);
  const top = players[0];
  const risers = players
    .filter((p) => Number.isFinite(p.previousValue) && Number.isFinite(p.marketValue) && p.previousValue > 0)
    .map((p) => ({ ...p, pct: ((p.marketValue - p.previousValue) / p.previousValue) * 100 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 6);

  const topRows = players.slice(0, 10).map((p) => ({
    id: p.id, label: p.name, value: p.marketValue || 0, sub: p.clubName,
  }));

  const bigDeals = [...transfers]
    .filter((t) => Number.isFinite(t.fee))
    .sort((a, b) => b.fee - a.fee)
    .slice(0, 6);

  const leagueRows = competitions
    .filter((c) => c.spent || c.income)
    .sort((a, b) => (b.spent + b.income) - (a.spent + a.income))
    .slice(0, 6);

  return `
  ${S.data.source === 'seed' ? noteBlock() : ''}
  <div class="page-head">
    <div>
      <h1>Обзор рынка</h1>
      <p>${esc(competitions.map((c) => c.name).join(' · '))}</p>
    </div>
  </div>

  <div class="grid grid-4" style="margin-bottom:16px">
    ${tile('Суммарная стоимость составов', fmtMoney(totalValue), `${clubs.length} клубов в выборке`)}
    ${tile('Трансферов в ленте', String(transfers.length), `с суммой: ${window26.length}`)}
    ${tile('Сумма сделок', fmtMoney(feeSum), 'по сделкам с раскрытой суммой')}
    ${tile(
      'Самый дорогой игрок',
      top ? fmtMoney(top.marketValue) : '—',
      top ? `${esc(top.name)} · ${esc(top.clubName)}` : '',
    )}
  </div>

  <div class="grid grid-7-5">
    <div class="col">
      <div class="card">
        <div class="card-head"><h2>Топ-10 по рыночной стоимости</h2><span class="sub">клик — карточка игрока</span></div>
        ${hBarChart(topRows)}
      </div>
      <div class="card">
        <div class="card-head"><h2>Баланс трансферов по лигам</h2></div>
        ${divergingChart(leagueRows.map((c) => ({ label: c.name, spent: c.spent || 0, income: c.income || 0 })))}
      </div>
    </div>

    <div class="col">
      <div class="card">
        <div class="card-head"><h2>Крупнейшие сделки</h2></div>
        <div class="feed">
          ${bigDeals.length ? bigDeals.map((t) => transferRow(t, true)).join('') : '<div class="empty">Нет сделок с раскрытой суммой</div>'}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Рост стоимости</h2><span class="sub">к предыдущей оценке</span></div>
        ${
          risers.length
            ? `<div class="feed">${risers
                .map(
                  (p) => `
          <div class="transfer transfer--riser" data-player="${esc(p.id)}">
            <div class="who">${avatar(p)}<div class="who-main"><div class="who-name">${esc(p.name)}</div>
              <div class="who-sub">${esc(p.clubName)}</div></div></div>
            <div class="fee"><div class="amt">${fmtMoney(p.marketValue)}</div>
              <div class="cap">с ${fmtMoney(p.previousValue)}</div></div>
            <div class="meta">${deltaHtml(p.marketValue, p.previousValue)}</div>
          </div>`,
                )
                .join('')}</div>`
            : `<div class="empty">Журнал изменений пока пуст.<br>Он наполняется по мере обновлений из API.</div>`
        }
      </div>
    </div>
  </div>
  ${footnote()}`;
}

function viewPlayers() {
  const f = S.filters.players;
  const rows = filteredPlayers();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  f.page = Math.min(f.page, pages - 1);
  const slice = rows.slice(f.page * PAGE_SIZE, (f.page + 1) * PAGE_SIZE);

  const th = (key, label, cls = '') => {
    const on = f.sort === key;
    return `<th class="sortable ${cls} ${on ? 'sorted' : ''}" data-sort="${key}">${label}
      <span class="arrow">${on ? (f.dir < 0 ? '▼' : '▲') : '↕'}</span></th>`;
  };

  return `
  ${S.data.source === 'seed' ? noteBlock() : ''}
  <div class="page-head">
    <div><h1>Рейтинг рыночной стоимости</h1>
    <p>Оценки игроков и изменение к предыдущему замеру</p></div>
  </div>

  <div class="filters">
    <select data-filter="comp">
      <option value="all">Все лиги</option>
      ${S.data.competitions.map((c) => `<option value="${esc(c.id)}" ${f.comp === c.id ? 'selected' : ''}>${esc(c.flag || '')} ${esc(c.name)}</option>`).join('')}
    </select>
    <div class="chips" data-filter-group="pos">
      ${[['all', 'Все'], ['GK', 'ВР'], ['DF', 'ЗЩ'], ['MF', 'ПЗ'], ['FW', 'НП']]
        .map(([v, l]) => `<button class="chip ${f.pos === v ? 'active' : ''}" data-pos="${v}">${l}</button>`)
        .join('')}
    </div>
    <select data-filter="ageMax">
      <option value="all">Любой возраст</option>
      <option value="21" ${f.ageMax === '21' ? 'selected' : ''}>до 21 года</option>
      <option value="23" ${f.ageMax === '23' ? 'selected' : ''}>до 23 лет</option>
      <option value="26" ${f.ageMax === '26' ? 'selected' : ''}>до 26 лет</option>
    </select>
    <input type="text" data-filter="q" placeholder="Имя или клуб" value="${esc(f.q)}" />
    <span class="spacer">${rows.length.toLocaleString('ru-RU')} игроков</span>
  </div>

  <div class="table-wrap">
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th class="rank">#</th>
          ${th('name', 'Игрок')}
          <th>Позиция</th>
          ${th('age', 'Возраст', 'num')}
          <th>Клуб</th>
          ${th('marketValue', 'Стоимость', 'num')}
          <th class="num">Δ</th>
        </tr></thead>
        <tbody>
          ${
            slice.length
              ? slice
                  .map(
                    (p, i) => `
            <tr data-player="${esc(p.id)}">
              <td class="rank">${f.page * PAGE_SIZE + i + 1}</td>
              <td><div class="who">${avatar(p)}<div class="who-main">
                <div class="who-name">${esc(p.name)}</div>
                <div class="who-sub">${esc((p.nationality || []).slice(0, 2).join(', ') || '—')}</div>
              </div></div></td>
              <td>${posTag(p)}</td>
              <td class="num">${p.age ?? '—'}</td>
              <td><div class="who-main"><div class="who-name" style="font-weight:400">${esc(p.clubName)}</div>
                <div class="who-sub">${esc(p.competitionName || '')}</div></div></td>
              <td class="num money">${fmtMoney(p.marketValue)}</td>
              <td class="num">${deltaHtml(p.marketValue, p.previousValue)}</td>
            </tr>`,
                  )
                  .join('')
              : '<tr><td colspan="7"><div class="empty">Ничего не найдено</div></td></tr>'
          }
        </tbody>
      </table>
    </div>
    <div class="pager">
      <button class="btn" data-page="prev" ${f.page === 0 ? 'disabled' : ''}>← Назад</button>
      <span>Страница ${f.page + 1} из ${pages}</span>
      <button class="btn" data-page="next" ${f.page >= pages - 1 ? 'disabled' : ''}>Вперёд →</button>
    </div>
  </div>
  ${footnote()}`;
}

const ARROW = `<svg class="arr" viewBox="0 0 20 12" width="20" height="11" aria-hidden="true"><path d="M1 6h16m0 0l-4.5-4.5M17 6l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * @param {object} t     трансфер
 * @param {boolean} compact  узкий вариант для боковой карточки: маршрут переносится
 *                           на вторую строку, чтобы названия клубов не схлопывались
 */
function transferRow(t, compact = false) {
  const badge = t.upcoming
    ? '<span class="badge badge--upcoming">Ожидается</span>'
    : t.fee === 0
      ? '<span class="badge badge--free">Свободный агент</span>'
      : '';
  const fee = t.fee === null || t.fee === undefined ? '—' : fmtMoney(t.fee);
  const est = Number.isFinite(t.marketValue) ? `оценка ${fmtMoney(t.marketValue)}` : '';
  return `
  <div class="transfer${compact ? ' transfer--compact' : ''}" ${t.playerId ? `data-player="${esc(t.playerId)}"` : ''}>
    <div class="who">${avatar({ name: t.playerName })}<div class="who-main">
      <div class="who-name">${esc(t.playerName)}</div>
      <div class="who-sub">${esc(t.position || '')}${t.age ? ` · ${t.age} лет` : ''}</div>
    </div></div>
    <div class="route">
      <span class="club">${esc(t.from.name)}</span>${ARROW}<span class="club to">${esc(t.to.name)}</span>
    </div>
    <div class="fee">
      <div class="amt">${fee}</div>
      ${est ? `<div class="cap">${est}</div>` : ''}
    </div>
    <div class="meta">${badge || fmtDate(t.date)}</div>
  </div>`;
}

function viewTransfers() {
  const f = S.filters.transfers;
  let rows = S.data.transfers.slice();
  if (f.comp !== 'all') {
    const ids = new Set(S.data.clubs.filter((c) => c.competitionId === f.comp).map((c) => c.name));
    rows = rows.filter((t) => ids.has(t.to.name) || ids.has(t.from.name));
  }
  if (f.min) rows = rows.filter((t) => (t.fee || 0) >= f.min);
  rows.sort((a, b) => (f.sort === 'fee' ? (b.fee || 0) - (a.fee || 0) : (b.date || '').localeCompare(a.date || '')));

  const sum = rows.reduce((s, t) => s + (t.fee || 0), 0);

  return `
  ${S.data.source === 'seed' ? noteBlock() : ''}
  <div class="page-head">
    <div><h1>Лента трансферов</h1><p>Переходы игроков из отслеживаемых лиг</p></div>
  </div>

  <div class="grid grid-3" style="margin-bottom:18px">
    ${tile('Сделок в выборке', String(rows.length))}
    ${tile('Общая сумма', fmtMoney(sum))}
    ${tile('Средняя сумма', fmtMoney(rows.filter((t) => t.fee).length ? sum / rows.filter((t) => t.fee).length : 0))}
  </div>

  <div class="filters">
    <select data-tfilter="comp">
      <option value="all">Все лиги</option>
      ${S.data.competitions.map((c) => `<option value="${esc(c.id)}" ${f.comp === c.id ? 'selected' : ''}>${esc(c.flag || '')} ${esc(c.name)}</option>`).join('')}
    </select>
    <select data-tfilter="min">
      <option value="0">Любая сумма</option>
      <option value="10000000" ${f.min == 10000000 ? 'selected' : ''}>от €10 млн</option>
      <option value="30000000" ${f.min == 30000000 ? 'selected' : ''}>от €30 млн</option>
      <option value="60000000" ${f.min == 60000000 ? 'selected' : ''}>от €60 млн</option>
    </select>
    <div class="chips" data-tsort-group>
      <button class="chip ${f.sort === 'date' ? 'active' : ''}" data-tsort="date">По дате</button>
      <button class="chip ${f.sort === 'fee' ? 'active' : ''}" data-tsort="fee">По сумме</button>
    </div>
  </div>

  <div class="feed">${rows.length ? rows.map(transferRow).join('') : '<div class="card"><div class="empty">Трансферов не найдено</div></div>'}</div>
  ${footnote()}`;
}

function viewClubs() {
  const f = S.filters.clubs;
  let clubs = S.data.clubs.slice();
  if (f.comp !== 'all') clubs = clubs.filter((c) => c.competitionId === f.comp);
  const max = Math.max(...clubs.map((c) => c.totalValue || 0), 1);

  return `
  ${S.data.source === 'seed' ? noteBlock() : ''}
  <div class="page-head"><div><h1>Клубы</h1><p>Стоимость составов и баланс трансферного окна</p></div></div>

  <div class="filters">
    <select data-cfilter="comp">
      <option value="all">Все лиги</option>
      ${S.data.competitions.map((c) => `<option value="${esc(c.id)}" ${f.comp === c.id ? 'selected' : ''}>${esc(c.flag || '')} ${esc(c.name)}</option>`).join('')}
    </select>
    <span class="spacer">${clubs.length} клубов</span>
  </div>

  <div class="grid grid-3">
    ${clubs
      .map(
        (c) => `
      <div class="card club-card">
        <div class="club-top">
          ${c.image ? `<span class="avatar"><img src="${esc(c.image)}" alt="" loading="lazy" onerror="this.remove()"></span>` : `<span class="avatar">${esc(initials(c.name))}</span>`}
          <div><div class="club-name">${esc(c.name)}</div><div class="club-league">${esc(c.competitionName)}</div></div>
        </div>
        <div>
          <div class="club-value">${fmtMoney(c.totalValue)}</div>
          <div class="bar-track" style="margin-top:8px"><div class="bar-fill" style="width:${((c.totalValue || 0) / max) * 100}%"></div></div>
        </div>
        <div class="club-stats">
          <span>Состав <b>${c.squadSize ?? '—'}</b></span>
          <span>Ср. возраст <b>${c.avgAge ?? '—'}</b></span>
          <span>Баланс ${
            Number.isFinite(c.balance)
              ? `<span class="delta delta--${c.balance >= 0 ? 'up' : 'down'}">${fmtMoney(c.balance, { sign: true })}</span>`
              : '<b>—</b>'
          }</span>
        </div>
      </div>`,
      )
      .join('')}
  </div>
  ${footnote()}`;
}

function viewLeagues() {
  const comps = S.data.competitions.slice().sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0));
  const rows = comps.map((c) => ({ label: c.name, value: c.totalValue || 0 }));

  return `
  ${S.data.source === 'seed' ? noteBlock() : ''}
  <div class="page-head"><div><h1>Лиги</h1><p>Суммарная стоимость составов и трансферный баланс</p></div></div>

  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card">
      <div class="card-head"><h2>Стоимость лиг</h2><span class="sub">сумма по клубам выборки</span></div>
      ${hBarChart(rows, { labelW: 150 })}
    </div>
    <div class="card">
      <div class="card-head"><h2>Потрачено / заработано</h2></div>
      ${divergingChart(comps.map((c) => ({ label: c.name, spent: c.spent || 0, income: c.income || 0 })))}
    </div>
  </div>

  <div class="table-wrap"><div class="table-scroll"><table>
    <thead><tr><th>Лига</th><th>Страна</th><th class="num">Клубов</th><th class="num">Стоимость</th>
      <th class="num">Потрачено</th><th class="num">Заработано</th><th class="num">Баланс</th></tr></thead>
    <tbody>${comps
      .map((c) => {
        const bal = (c.income || 0) - (c.spent || 0);
        return `<tr style="cursor:default">
        <td><b>${esc(c.flag || '')} ${esc(c.name)}</b></td>
        <td style="color:var(--text-2)">${esc(c.country)}</td>
        <td class="num">${c.clubs}</td>
        <td class="num money">${fmtMoney(c.totalValue)}</td>
        <td class="num money">${fmtMoney(c.spent)}</td>
        <td class="num money">${fmtMoney(c.income)}</td>
        <td class="num"><span class="delta delta--${bal >= 0 ? 'up' : 'down'}">${fmtMoney(bal, { sign: true })}</span></td>
      </tr>`;
      })
      .join('')}</tbody>
  </table></div></div>
  ${footnote()}`;
}

function noteBlock() {
  return `<div class="note">
    <span>⚠</span>
    <div><b>Демо-данные.</b> Живой API (<code>${esc(S.status?.config?.apiUrl || 'transfermarkt-api')}</code>) сейчас недоступен,
    поэтому показан офлайн-срез из открытых публикаций на 25.08.2026; помесячная история стоимости в нём синтезирована.
    Запустите API и нажмите «Обновить» — данные заменятся на живые.</div>
  </div>`;
}

function footnote() {
  const s = S.status;
  return `<div class="footnote">
    Источник: ${
      S.data.source === 'live'
        ? `self-hosted <a class="ext-link" href="https://github.com/felipeall/transfermarkt-api" target="_blank" rel="noopener">transfermarkt-api</a> → данные Transfermarkt`
        : 'офлайн-срез из открытых публикаций'
    }.
    Обновлено: ${fmtDateTime(S.data.generatedAt)}${s?.counts ? ` · ${s.counts.players} игроков, ${s.counts.clubs} клубов` : ''}.
  </div>`;
}

/* ── Карточка игрока ───────────────────────────────────────────────────── */

async function openPlayer(id) {
  const drawer = $('#drawer');
  const body = $('#drawer-body');
  drawer.hidden = false;
  document.body.style.overflow = 'hidden';
  body.innerHTML = `
    <div class="p-head"><div class="skeleton" style="width:58px;height:58px;border-radius:14px"></div>
      <div style="flex:1"><div class="skeleton" style="height:20px;width:60%"></div>
      <div class="skeleton" style="height:14px;width:40%;margin-top:8px"></div></div></div>
    <div class="skeleton" style="height:190px;margin-top:20px"></div>`;

  let d;
  try {
    d = await api(`/api/players/${encodeURIComponent(id)}`);
  } catch {
    body.innerHTML = '<div class="empty">Не удалось загрузить карточку игрока</div>';
    return;
  }
  const p = d.player;
  if (!p) {
    body.innerHTML = '<div class="empty">Игрок не найден</div>';
    return;
  }
  const hist = (d.history || []).filter((h) => Number.isFinite(h.value));
  const peak = hist.length ? Math.max(...hist.map((h) => h.value)) : null;
  // Дельта считается по журналу сервера (та же цифра, что в таблице рейтинга);
  // история — только запасной источник.
  const prev = Number.isFinite(p.previousValue)
    ? p.previousValue
    : hist.length > 1
      ? hist[hist.length - 2].value
      : null;

  body.innerHTML = `
  <div class="p-head">
    ${avatar(p)}
    <div>
      <h2>${esc(p.name)}</h2>
      <div class="p-sub">${esc(p.clubName)}${p.competitionName && p.competitionName !== '—' ? ' · ' + esc(p.competitionName) : ''}</div>
    </div>
  </div>

  <div class="p-hero">
    <div class="big">${fmtMoney(p.marketValue)}</div>
    <div style="padding-bottom:6px">${deltaHtml(p.marketValue, prev)}</div>
  </div>

  <div class="p-facts">
    <div class="p-fact"><div class="k">Позиция</div><div class="v">${esc(p.position || '—')}</div></div>
    <div class="p-fact"><div class="k">Возраст</div><div class="v">${p.age ?? '—'}</div></div>
    <div class="p-fact"><div class="k">Гражданство</div><div class="v">${esc((p.nationality || []).slice(0, 2).join(', ') || '—')}</div></div>
    <div class="p-fact"><div class="k">Рост</div><div class="v">${p.height ? p.height + ' см' : '—'}</div></div>
    <div class="p-fact"><div class="k">Нога</div><div class="v">${esc(FOOT_RU[p.foot] || p.foot || '—')}</div></div>
    <div class="p-fact"><div class="k">Контракт до</div><div class="v">${fmtDateFull(p.contract)}</div></div>
  </div>

  <div class="p-section-title">Динамика рыночной стоимости</div>
  ${lineChart(hist.map((h) => ({ date: h.date, value: h.value, clubName: h.clubName })))}
  ${peak ? `<div class="footnote" style="margin-top:8px">Пик: ${fmtMoney(peak)}${d.ranking?.Worldwide ? ` · место в мире: ${d.ranking.Worldwide}` : ''}</div>` : ''}

  <div class="p-section-title">История трансферов</div>
  ${
    (d.transfers || []).length
      ? `<div class="timeline">${d.transfers
          .slice(0, 12)
          .map(
            (t) => `<div class="tl-item">
        <div class="tl-date">${esc(t.season || fmtDate(t.date))}</div>
        <div class="route"><span class="club">${esc(t.from.name)}</span>${ARROW}<span class="club to">${esc(t.to.name)}</span></div>
        <div class="money">${t.fee === 0 ? 'свободный' : fmtMoney(t.fee)}</div>
      </div>`,
          )
          .join('')}</div>`
      : '<div class="empty">Нет данных о трансферах</div>'
  }

  ${p.url ? `<div style="margin-top:20px"><a class="ext-link" href="${esc(p.url)}" target="_blank" rel="noopener">Профиль на Transfermarkt ↗</a></div>` : ''}
  ${d.source === 'seed' ? '<div class="footnote">Карточка построена по офлайн-срезу: история стоимости синтезирована.</div>' : ''}`;
}

function closeDrawer() {
  $('#drawer').hidden = true;
  document.body.style.overflow = '';
}

/* ── Фильтрация ────────────────────────────────────────────────────────── */

function filteredPlayers() {
  const f = S.filters.players;
  let rows = S.data.players.slice();
  if (f.comp !== 'all') rows = rows.filter((p) => p.competitionId === f.comp);
  if (f.pos !== 'all') rows = rows.filter((p) => p.positionGroup === f.pos);
  if (f.ageMax !== 'all') rows = rows.filter((p) => Number.isFinite(p.age) && p.age <= Number(f.ageMax));
  if (f.q.trim()) {
    const q = f.q.trim().toLowerCase();
    rows = rows.filter((p) => p.name.toLowerCase().includes(q) || (p.clubName || '').toLowerCase().includes(q));
  }
  const key = f.sort;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av || '').localeCompare(String(bv || ''), 'ru') * f.dir * -1;
    }
    return ((bv ?? -Infinity) - (av ?? -Infinity)) * (f.dir < 0 ? 1 : -1);
  });
  return rows;
}

/* ── Роутер ────────────────────────────────────────────────────────────── */

const VIEWS = {
  overview: viewOverview,
  players: viewPlayers,
  transfers: viewTransfers,
  clubs: viewClubs,
  leagues: viewLeagues,
};

function currentView() {
  const name = (location.hash.replace(/^#\//, '') || 'overview').split('?')[0];
  return VIEWS[name] ? name : 'overview';
}

function render() {
  const name = currentView();
  $('#view').innerHTML = VIEWS[name]();
  document.querySelectorAll('.rail a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  window.scrollTo({ top: 0 });
}

/* ── События ───────────────────────────────────────────────────────────── */

addEventListener('hashchange', render);

document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) return closeDrawer();

  const row = e.target.closest('[data-player]');
  if (row) {
    const id = row.dataset.player;
    if (id) openPlayer(id);
    return;
  }

  const sortTh = e.target.closest('th[data-sort]');
  if (sortTh) {
    const f = S.filters.players;
    const k = sortTh.dataset.sort;
    if (f.sort === k) f.dir *= -1;
    else { f.sort = k; f.dir = -1; }
    f.page = 0;
    return render();
  }

  const pos = e.target.closest('[data-pos]');
  if (pos) { S.filters.players.pos = pos.dataset.pos; S.filters.players.page = 0; return render(); }

  const tsort = e.target.closest('[data-tsort]');
  if (tsort) { S.filters.transfers.sort = tsort.dataset.tsort; return render(); }

  const pg = e.target.closest('[data-page]');
  if (pg && !pg.disabled) {
    S.filters.players.page += pg.dataset.page === 'next' ? 1 : -1;
    return render();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.filter) {
    S.filters.players[t.dataset.filter] = t.value;
    S.filters.players.page = 0;
    return render();
  }
  if (t.dataset.tfilter) {
    S.filters.transfers[t.dataset.tfilter] = t.dataset.tfilter === 'min' ? Number(t.value) : t.value;
    return render();
  }
  if (t.dataset.cfilter) { S.filters.clubs[t.dataset.cfilter] = t.value; return render(); }
});

let qTimer;
document.addEventListener('input', (e) => {
  if (e.target.dataset.filter === 'q') {
    clearTimeout(qTimer);
    const v = e.target.value;
    qTimer = setTimeout(() => {
      S.filters.players.q = v;
      S.filters.players.page = 0;
      render();
      const inp = $('input[data-filter="q"]');
      if (inp) { inp.focus(); inp.setSelectionRange(v.length, v.length); }
    }, 220);
  }
});

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDrawer(); $('#search-results').hidden = true; }
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('#search-input').focus(); }
});

/* Тултипы графиков */
document.addEventListener('mousemove', (e) => {
  const hit = e.target.closest('[data-tip]');
  if (!hit) { hideTip(); clearFocus(); return; }
  const parts = hit.dataset.tip.split('|');
  showTip(`<b>${parts[0]}</b>${parts.slice(1).map((p) => `<div class="tt-row">${p}</div>`).join('')}`, e.clientX, e.clientY);

  if (hit.classList.contains('pt-hit')) {
    const svg = hit.closest('svg');
    const cross = svg.querySelector('.crosshair');
    const dot = svg.querySelector('.focus-dot');
    const cx = hit.dataset.cx, cy = hit.dataset.cy;
    if (cross) { cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('opacity', '.9'); }
    if (dot) { dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('opacity', '1'); }
  } else clearFocus();
});

function clearFocus() {
  document.querySelectorAll('.crosshair, .focus-dot').forEach((n) => n.setAttribute('opacity', '0'));
}

/* Глобальный поиск */
const searchInput = $('#search-input');
const searchBox = $('#search-results');
let sTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(sTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { searchBox.hidden = true; return; }
  sTimer = setTimeout(async () => {
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
      searchBox.hidden = false;
      searchBox.innerHTML = r.results.length
        ? r.results
            .map(
              (x) => `<button data-player="${esc(x.id)}">
          <span class="avatar">${esc(initials(x.name))}</span>
          <span><span class="sr-name">${esc(x.name)}</span><br><span class="sr-club">${esc(x.club)} · ${esc(x.position)}</span></span>
          <span class="sr-val">${fmtMoney(x.marketValue)}</span></button>`,
            )
            .join('')
        : '<div class="search-empty">Ничего не найдено</div>';
    } catch {
      searchBox.hidden = true;
    }
  }, 280);
});
searchInput.addEventListener('blur', () => setTimeout(() => { searchBox.hidden = true; }, 180));

/* Обновление */
$('#refresh-btn').addEventListener('click', async () => {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  try { await api('/api/refresh'); } catch { /* сервер сам сообщит статус */ }
  setTimeout(() => { btn.disabled = false; }, 2500);
  pollStatus();
});

/* ── Статус и загрузка ─────────────────────────────────────────────────── */

function paintStatus(st) {
  const pill = $('#status-pill');
  const text = $('#status-text');
  const bar = $('#build-bar');
  const fill = $('#build-bar-fill');
  const btext = $('#build-bar-text');

  pill.className = 'pill ' + (st.status === 'live' ? 'pill--live' : st.status === 'error' ? 'pill--error' : 'pill--seed');
  text.textContent =
    st.status === 'live' ? 'Live · API' :
    st.status === 'building' ? 'Обновление…' :
    st.status === 'error' ? 'Демо · API недоступен' : 'Демо-данные';
  pill.title = st.error ? `${st.error}` : `Апстрим: ${st.upstream}`;

  if (st.status === 'building') {
    const { done, total, step } = st.progress || {};
    const pct = total ? Math.round((done / total) * 100) : 0;
    bar.hidden = false;
    fill.style.width = `${pct}%`;
    btext.textContent = `${step} — ${done}/${total} (${pct}%)`;
  } else {
    bar.hidden = true;
  }
}

async function loadDataset() {
  const d = await api('/api/dataset');
  S.data = d;
  S.version = d.version;
  render();
}

async function pollStatus() {
  try {
    const st = await api('/api/status');
    S.status = st;
    paintStatus(st);
    if (st.version !== S.version) await loadDataset();
  } catch {
    /* сервер недоступен — оставляем что есть */
  }
}

(async function init() {
  try {
    await loadDataset();
  } catch {
    $('#view').innerHTML = '<div class="empty">Сервер не отвечает. Запустите <code>node server.js</code>.</div>';
  }
  pollStatus();
  setInterval(pollStatus, 4000);
})();
