/* wiz board — 포스트시즌 우승 확률 머신 (scripts/psmodel.js)
 *
 * 수집기(scripts/fetch-live.js) · 화면(index.html) · 예측 도구(tools/predictor/ps.js)가 이 파일 하나를 같이 쓴다.
 * 같은 입력 + 같은 시드면 어디서 돌려도 같은 숫자가 나온다(시드 고정 난수).
 *
 * ── 한 경기 승률 = 선수 단위 65% + 팀 단위 35% ──────────────────────────────────────────
 *  선수 단위: 그날 양 팀의 기대 득점을 내고 피타고리안(지수 1.83)으로 승률을 구한다.
 *    · 타선   — 가을야구 실제 선발 타순 9명(없으면 시즌 타석 많은 9명)의 wRC+ (타석 적은 선수는 100 쪽으로 수축)
 *    · 선발   — 그날 선발의 실점 지표(평균자책·FIP 평균, 이닝 적으면 리그 평균 쪽으로 수축) × 예상 이닝 비중
 *               발표된 선발이 있으면 그 투수, 없으면 로테이션 앞 4명 중 4일 이상 쉰 가장 좋은 투수.
 *               다 덜 쉬었으면 가장 오래 쉰 투수가 짧은 휴식으로 등판(선발 실점 +12%)
 *    · 불펜   — 선발 외 상위 7명(필승조 3명 가중). 직전 3일 경기 1개당 불펜 실점 +3%(연투 피로)
 *    · 홈 팀 득점 +3.5% (승률 약 +2%p)
 *  팀 단위: 시즌 득실 피타고리안 65% + 최근 60경기 35% → log5, 홈 +2%p.
 *           가을야구에서 낸 득실차로 최대 ±3%p 보정(4경기 이상이면 최대치)
 *  모든 지표는 리그 평균(10개 팀의 같은 기준 — 주전 9명·선발 4명·불펜 7명)에 대한 비율로 쓴다.
 *
 * ── 시리즈 ──────────────────────────────────────────────────────────────────────────────
 *  와일드카드(4위 1승 안고 최대 2경기, 4위 홈) → 준PO·PO(5전 3선승, 홈 2-2-1) → 한국시리즈(7전 4선승, 홈 2-3-2)
 *  실제 결과·발표된 선발·진행 중인 경기(점수·이닝·아웃)는 그대로 반영하고 남은 경기만 굴린다.
 *  우천 등으로 실제 경기가 계획보다 밀리면 그 라운드의 남은 일정도 같은 만큼 민다(휴식일 계산용).
 *
 * 한계: 부상·엔트리 변경·불펜 개별 등판 순서·수비·구장 효과는 넣지 않았다. 무승부는 굴리지 않는다(실제 무승부는 반영).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PSModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const ROUNDS = ['WC', 'SPO', 'PO', 'KS'];
  const META = {
    WC:  { ko: '와일드카드 결정전', short: '와일드카드', abbr: 'WC',   seed: 4, need: 0, fmt: '4위 1승 안고 최대 2경기' },
    SPO: { ko: '준플레이오프',     short: '준PO',       abbr: '준PO', seed: 3, need: 3, fmt: '5전 3선승' },
    PO:  { ko: '플레이오프',       short: 'PO',         abbr: 'PO',   seed: 2, need: 3, fmt: '5전 3선승' },
    KS:  { ko: '한국시리즈',       short: '한국시리즈', abbr: 'KS',   seed: 1, need: 4, fmt: '7전 4선승' }
  };
  const PREV = { SPO: 'WC', PO: 'SPO', KS: 'PO' };
  // KBO 발표 일정(예정) — [날짜, 시각, 홈(hi = 상위 시드), 필요 시 열리는 경기]
  const SCHEDULE = {
    WC:  [['2026-10-14', '18:30', 'hi'], ['2026-10-15', '18:30', 'hi', 1]],
    SPO: [['2026-10-17', '14:00', 'hi'], ['2026-10-18', '14:00', 'hi'], ['2026-10-20', '18:30', 'lo'],
          ['2026-10-21', '18:30', 'lo', 1], ['2026-10-23', '18:30', 'hi', 1]],
    PO:  [['2026-10-25', '14:00', 'hi'], ['2026-10-26', '18:30', 'hi'], ['2026-10-28', '18:30', 'lo'],
          ['2026-10-29', '18:30', 'lo', 1], ['2026-10-31', '14:00', 'hi', 1]],
    KS:  [['2026-11-02', '18:30', 'hi'], ['2026-11-03', '18:30', 'hi'], ['2026-11-05', '18:30', 'lo'],
          ['2026-11-06', '18:30', 'lo', 1], ['2026-11-07', '14:00', 'lo', 1], ['2026-11-09', '18:30', 'hi', 1], ['2026-11-10', '18:30', 'hi', 1]]
  };
  const P = {
    W_PLAYER: 0.65,   // 선수 단위 비중 (나머지는 팀 득실 기반)
    HOME_RUN: 1.035,  // 홈 팀 득점 배율
    HOME_P: 0.02,     // 팀 단위 홈 가산
    EXP: 1.83,        // 피타고리안 지수
    REST: 5,          // 선발 정상 등판 간격(일) = 4일 휴식
    SHORT: 1.12,      // 짧은 휴식 등판 시 선발 실점 배율
    FATIGUE: 0.03,    // 직전 3일 경기 1개당 불펜 실점 배율 가산
    FORM_MAX: 0.03,   // 가을야구 득실 보정 한도
    SP_SHARE_MAX: 0.72,
    N: 20000,
    SEED: 20261014
  };

  /* ---------- 공통 ---------- */
  const DAY = 864e5;
  const dnum = d => Math.round(Date.parse(d + 'T00:00:00Z') / DAY);
  const dstr = n => new Date(n * DAY).toISOString().slice(0, 10);
  function rng(seed) {   // mulberry32 — 시드가 같으면 어디서든 같은 수열
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pois(l, rand) {   // 포아송 (λ가 작아 곱셈법으로 충분)
    if (l <= 0) return 0;
    const L = Math.exp(-l); let k = 0, p = 1;
    do { k++; p *= rand(); } while (p > L);
    return k - 1;
  }
  // 이닝 표기: 시즌 기록 "172 2/3", 경기 중 박스스코어 "5.1"(=5⅓)·"6.0", 경기 후 박스스코어 "4 ⅓"·"0 ⅔"·"6"
  function innings(s) {
    s = String(s == null ? '0' : s).replace(/⅓/g, ' 1/3').replace(/⅔/g, ' 2/3').replace(/\s+/g, ' ').trim();
    if (/^\d+\.\d$/.test(s)) { const [a, b] = s.split('.'); return +a + (+b) / 3; }
    const [a, b] = s.includes(' ') ? s.split(/\s+/) : (s.includes('/') ? ['0', s] : [s, '']);
    return (+a || 0) + (b ? (+b.split('/')[0]) / 3 : 0);
  }
  const pyth = (a, b) => { const e = P.EXP; return a + b > 0 ? Math.pow(a, e) / (Math.pow(a, e) + Math.pow(b, e)) : 0.5; };
  const log5 = (a, b) => { const v = (a - a * b) / (a + b - 2 * a * b); return isFinite(v) ? v : 0.5; };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const done = g => g && (g.code === 'RESULT' || g.code === 'ENDED');
  const isLive = g => g && (g.code === 'STARTED' || g.code === 'LIVE');

  /* ---------- 팀 모델 만들기 (수집기에서 하루 1회) ----------
     raw: { 팀: { hitters: [네이버 선수 기록], pitchers: [...] } } — 리그 평균 기준을 잡으려고 10개 팀 전부
     pythag: 수집기 pythag(teams[{name, rs, ra, f60}]), games: { 팀: 경기 수 }, lineups: { 팀: [가을 실제 선발 타순 9명] } */
  function buildTeams(raw, opt) {
    opt = opt || {};
    const names = Object.keys(raw);
    const active = p => p.isRetire !== 'Y' && p.isPlayer !== 'N';
    let er = 0, ipT = 0, hr = 0, bb = 0, hbp = 0, k = 0;
    names.forEach(t => (raw[t].pitchers || []).forEach(p => {
      const i = innings(p.pitcherInning); if (!i) return;
      er += p.pitcherEr || 0; ipT += i; hr += p.pitcherHr || 0; bb += p.pitcherBb || 0; hbp += p.pitcherHp || 0; k += p.pitcherKk || 0;
    }));
    const lgEra = ipT ? 9 * er / ipT : 4.5;
    const cFip = ipT ? lgEra - (13 * hr + 3 * (bb + hbp) - 2 * k) / ipT : 3.1;

    const pit = p => {
      const ip = innings(p.pitcherInning), g = p.pitcherGameCount || 0;
      if (!ip) return null;
      const era = p.pitcherEra != null ? p.pitcherEra : 9 * (p.pitcherEr || 0) / ip;
      const fip = (13 * (p.pitcherHr || 0) + 3 * ((p.pitcherBb || 0) + (p.pitcherHp || 0)) - 2 * (p.pitcherKk || 0)) / ip + cFip;
      const st = (g >= 4 && ip / g >= 3.3) || (p.pitcherQs || 0) >= 2;
      const ip0 = st ? 45 : 25;
      return {
        n: p.playerName, ip: +ip.toFixed(1), g, era: +era.toFixed(2), fip: +fip.toFixed(2),
        q: +(((era + fip) / 2 * ip + lgEra * ip0) / (ip + ip0)).toFixed(3), st,
        ips: st ? +clamp(ip / Math.max(1, g) * 0.92, 4.3, 6).toFixed(2) : 0,
        w: p.pitcherWin || 0, l: p.pitcherLose || 0, sv: p.pitcherSave || 0, hd: p.pitcherHold || 0,
        k9: +(9 * (p.pitcherKk || 0) / ip).toFixed(1), war: p.pitcherWar != null ? +(+p.pitcherWar).toFixed(2) : null
      };
    };
    const hit = p => {
      const pa = (p.hitterAb || 0) + (p.hitterBb || 0) + (p.hitterHp || 0);
      if (!pa || p.hitterWrcPlus == null) return null;
      let pos = '';
      try { pos = (JSON.parse(p.profile || '{}').position) || ''; } catch (e) {}
      return {
        n: p.playerName, pa, wrc: Math.round(p.hitterWrcPlus), reg: (p.hitterWrcPlus * pa + 100 * 150) / (pa + 150),
        avg: p.hitterHra != null ? +(+p.hitterHra).toFixed(3) : null, ops: p.hitterOps, hr: p.hitterHr || 0,
        war: p.hitterWar != null ? +(+p.hitterWar).toFixed(2) : null, pos
      };
    };

    const T = {};
    names.forEach(t => {
      const Ps = (raw[t].pitchers || []).filter(active).map(pit).filter(Boolean);
      const Hs = (raw[t].hitters || []).filter(active).map(hit).filter(Boolean);
      let lu = [];
      const want = opt.lineups && opt.lineups[t];
      if (want && want.length) lu = want.map(n => Hs.find(h => h.n === n)).filter(Boolean);
      if (lu.length < 9) lu = lu.concat(Hs.filter(h => lu.indexOf(h) < 0).sort((a, b) => b.pa - a.pa)).slice(0, 9);
      const off = lu.reduce((a, h) => a + h.reg, 0) / Math.max(1, lu.length) / 100;
      const sp = Ps.filter(p => p.st && p.ip >= 30).sort((a, b) => a.q - b.q).slice(0, 5);
      const rp = Ps.filter(p => !p.st && p.ip >= 12).sort((a, b) => a.q - b.q).slice(0, 7);
      let ws = 0, wq = 0;
      rp.forEach((p, i) => { const w = p.ip * (i < 3 ? 1.5 : 1); ws += w; wq += w * p.q; });
      let s1 = 0, s2 = 0;
      sp.slice(0, 4).forEach(p => { s1 += p.ip; s2 += p.ip * p.q; });
      const py = ((opt.pythag && opt.pythag.teams) || []).find(x => x.name === t);
      const exp = py ? pyth(py.rs, py.ra) : 0.5;
      const exp60 = py && py.f60 && py.f60.n ? pyth(py.f60.rs, py.f60.ra) : exp;
      T[t] = {
        off: +off.toFixed(4), spq: +(s1 ? s2 / s1 : lgEra).toFixed(3), pen: +(ws ? wq / ws : lgEra).toFixed(3),
        t: +(0.65 * exp + 0.35 * exp60).toFixed(4), exp: +exp.toFixed(3), exp60: +exp60.toFixed(3),
        rs: py ? py.rs : null, ra: py ? py.ra : null, g: (opt.games && opt.games[t]) || 144,
        lineup: lu.map(h => ({ n: h.n, pos: h.pos, pa: h.pa, wrc: h.wrc, avg: h.avg, ops: h.ops, hr: h.hr, war: h.war })),
        luFrom: want && want.length ? 'ps' : 'season',
        sp, rp,
        pAll: Object.fromEntries(Ps.filter(p => p.ip >= 3).map(p => [p.n, [p.q, p.ips || 0]]))
      };
    });
    const mean = f => names.reduce((a, t) => a + f(T[t]), 0) / Math.max(1, names.length);
    let R = 0, G = 0;
    names.forEach(t => { if (T[t].rs != null) { R += T[t].rs; G += T[t].g; } });
    const lg = { era: +lgEra.toFixed(3), r: +(G ? R / G : 4.8).toFixed(3), off: +mean(x => x.off).toFixed(4), sp: +mean(x => x.spq).toFixed(3), pen: +mean(x => x.pen).toFixed(3) };
    const teams = {};
    (opt.only || names).forEach(t => { if (T[t]) teams[t] = T[t]; });
    return { v: VERSION, lg, teams };
  }

  /* ---------- 한 경기 ---------- */
  // 실점 비율(리그 평균 = 1): 선발(예상 이닝 비중) + 불펜(피로 반영)
  function allowRel(lg, T, sp, fat) {
    const share = Math.min(P.SP_SHARE_MAX, ((sp && sp.ips) || 5) / 9);
    const spq = sp && sp.q ? sp.q * (sp.short ? P.SHORT : 1) : T.spq;
    return share * spq / lg.sp + (1 - share) * T.pen * (fat || 1) / lg.pen;
  }
  // o: { fatH, fatA, formH, formA } → { p: 홈 승리 확률, rH, rA: 기대 득점 }
  function gameProb(m, home, away, spH, spA, o) {
    o = o || {};
    const lg = m.lg, H = m.teams[home], A = m.teams[away];
    const rH = lg.r * (H.off / lg.off) * allowRel(lg, A, spA, o.fatA) * P.HOME_RUN;
    const rA = lg.r * (A.off / lg.off) * allowRel(lg, H, spH, o.fatH);
    const pP = pyth(rH, rA);
    const pT = clamp(log5(clamp(H.t + (o.formH || 0), .05, .95), clamp(A.t + (o.formA || 0), .05, .95)) + P.HOME_P, .05, .95);
    return { p: P.W_PLAYER * pP + (1 - P.W_PLAYER) * pT, pP, pT, rH, rA };
  }
  // 로테이션 앞 4명 중 휴식이 찬 가장 좋은 투수(번호). 없으면 가장 오래 쉰 투수
  function pickStarter(T, last, day) {
    let best = -1, bestGap = -1e9;
    for (let i = 0; i < Math.min(4, T.sp.length); i++) {
      const gap = day - (last[i] == null ? -99 : last[i]);
      if (gap >= P.REST) return i;
      if (gap > bestGap) { bestGap = gap; best = i; }
    }
    return best;
  }
  // 그날 선발: 발표된 이름이 있으면 그 투수(로테이션 밖이면 시즌 기록으로), 없으면 휴식일 규칙
  function starterFor(m, team, day, last, announced) {
    const T = m.teams[team];
    if (announced) {
      const i = T.sp.findIndex(p => p.n === announced);
      if (i >= 0 && i < 4) return { i, n: announced, q: T.sp[i].q, ips: T.sp[i].ips, ann: true };
      const a = T.pAll[announced];
      if (a) return { i: -1, n: announced, q: a[0], ips: a[1] || 3, ann: true };
    }
    const i = pickStarter(T, last, day);
    if (i < 0) return { i: -1, n: '', q: T.spq, ips: 5 };
    const gap = day - (last[i] == null ? -99 : last[i]);
    return { i, n: T.sp[i].n, q: T.sp[i].q, ips: T.sp[i].ips, short: gap < P.REST };
  }
  function fatigue(days, day) {
    let c = 0;
    for (let i = days.length - 1; i >= 0; i--) { const d = days[i]; if (d < day && d >= day - 3) c++; }
    return 1 + P.FATIGUE * c;
  }
  // 진행 중인 경기: 남은 아웃 수만큼 기대 득점을 포아송으로 굴려 최종 점수 비교 (동점이면 경기 전 승률)
  function liveHomeProb(g, st, gp, seed) {
    const inn = st && st.inn, top = st && st.half === '초', out = Math.min(3, (st && st.out) || 0);
    if (!inn) return gp.p;
    const remA = Math.max(0, top ? (9 - inn) * 3 + (3 - out) : (9 - inn) * 3);
    const remH = Math.max(0, top ? (10 - inn) * 3 : (9 - inn) * 3 + (3 - out));
    const lA = gp.rA / 27 * remA, lH = gp.rH / 27 * remH;
    const rand = rng(seed), N = 4000;
    let w = 0;
    for (let i = 0; i < N; i++) {
      const a = (g.as || 0) + pois(lA, rand), h = (g.hs || 0) + pois(lH, rand);
      w += h > a ? 1 : h === a ? gp.p : 0;
    }
    return w / N;
  }
  function parseInning(status) {   // "7회말" → { inn: 7, half: '말' }
    const m = String(status || '').match(/(\d+)회(초|말)/);
    return m ? { inn: +m[1], half: m[2], out: 0 } : null;
  }

  /* ---------- 현재 상태 정리 ---------- */
  // input: { model, seeds: [1~5위 팀], rounds: ps.rounds, live: { id, inn, half, out } }
  function prepare(input) {
    const m = input.model, seeds = input.seeds || [], R = input.rounds || {};
    if (!m || !m.teams || seeds.length < 5 || seeds.some(t => !m.teams[t])) return null;
    const base = { m, seeds, rounds: {}, last: {}, days: {}, form: {} };
    Object.keys(m.teams).forEach(t => { base.last[t] = []; base.days[t] = []; base.form[t] = { g: 0, rd: 0 }; });
    const mark = (team, name, day) => {
      const T = m.teams[team]; if (!T || !name) return;
      const i = T.sp.findIndex(p => p.n === name);
      if (i >= 0 && i < 4) base.last[team][i] = Math.max(base.last[team][i] == null ? -99 : base.last[team][i], day);
    };
    ROUNDS.forEach(code => {
      const r = R[code];
      const real = r ? (r.games || []).filter(g => g.code !== 'CANCEL')
        .slice().sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))) : [];
      const plan = SCHEDULE[code], slots = [];
      let shift = 0;
      for (let i = 0; i < Math.max(plan.length, real.length) + 3; i++) {   // +3: 무승부로 경기가 늘어날 때
        const g = real[i], pl = plan[i];
        let d, time, maybe = false;
        if (g) { d = g.date; time = g.time; maybe = pl ? !!pl[3] : true; if (pl) shift = Math.max(0, dnum(g.date) - dnum(pl[0])); }
        else if (pl) { d = dstr(dnum(pl[0]) + shift); time = pl[1]; maybe = !!pl[3]; }
        else { d = dstr(slots[i - 1].day + 1); time = '18:30'; maybe = true; }
        slots.push({ n: i + 1, d, day: dnum(d), time, side: pl ? pl[2] : 'hi', maybe, g: g || null });
      }
      const wins = {}, ties = {};
      let played = 0, live = null;
      real.forEach((g, i) => {
        const day = dnum(g.date);
        if (done(g)) {
          played = i + 1;
          if (g.as > g.hs) wins[g.away] = (wins[g.away] || 0) + 1;
          else if (g.hs > g.as) wins[g.home] = (wins[g.home] || 0) + 1;
          else { ties[g.home] = (ties[g.home] || 0) + 1; ties[g.away] = (ties[g.away] || 0) + 1; }
          mark(g.home, g.hp, day); mark(g.away, g.ap, day);
          [[g.home, g.hs - g.as], [g.away, g.as - g.hs]].forEach(([t, rd]) => {
            if (base.days[t]) { base.days[t].push(day); base.form[t].g++; base.form[t].rd += rd; }
          });
        } else if (isLive(g) && live == null) {
          live = { i, g };
          mark(g.home, g.hp, day); mark(g.away, g.ap, day);
        }
      });
      base.rounds[code] = { slots, wins, ties, played, live, teams: r && r.teams && r.teams.length === 2 ? r.teams.slice() : null };
    });
    base.formAdj = {};
    Object.keys(base.form).forEach(t => {
      const f = base.form[t];
      base.formAdj[t] = f.g ? clamp(f.rd / f.g * 0.01 * Math.min(1, f.g / 4), -P.FORM_MAX, P.FORM_MAX) : 0;
    });
    // 진행 중인 경기의 현재 승률 (모든 시뮬레이션이 같은 값을 쓴다)
    ROUNDS.forEach(code => {
      const B = base.rounds[code];
      if (!B.live) return;
      const g = B.live.g, day = dnum(g.date);
      if (!m.teams[g.home] || !m.teams[g.away]) { B.live = null; return; }
      const sH = starterFor(m, g.home, day, base.last[g.home], g.hp), sA = starterFor(m, g.away, day, base.last[g.away], g.ap);
      const gp = gameProb(m, g.home, g.away, sH, sA, {
        fatH: fatigue(base.days[g.home], day), fatA: fatigue(base.days[g.away], day), formH: base.formAdj[g.home], formA: base.formAdj[g.away]
      });
      const st = (input.live && input.live.id === g.id && input.live.inn) ? input.live : parseInning(g.status);
      B.live.pre = gp.p;
      B.live.p = liveHomeProb(g, st, gp, P.SEED + 7);
      B.live.state = st;
    });
    base.realWinner = (code, hi, lo) => {   // 실제 결과로 이미 끝난 시리즈의 승자 (아니면 null)
      const B = base.rounds[code], w = B.wins, t = B.ties;
      if (code === 'WC') {
        if ((w[hi] || 0) >= 1 || (t[hi] || 0) >= 1) return hi;
        if ((w[lo] || 0) >= 2) return lo;
        return B.played >= 2 ? hi : null;
      }
      const need = META[code].need;
      return (w[hi] || 0) >= need ? hi : (w[lo] || 0) >= need ? lo : null;
    };
    return base;
  }

  // 다음(또는 진행 중) 경기 — 결정된 값으로 한 번 계산 (화면의 '다음 경기 승률'용)
  function nextGame(base) {
    const m = base.m, seeds = base.seeds;
    let pw = null;
    for (const code of ROUNDS) {
      const hi = seeds[META[code].seed - 1], lo = code === 'WC' ? seeds[4] : pw;
      if (!lo) return null;
      const w = base.realWinner(code, hi, lo);
      if (w) { pw = w; continue; }
      const B = base.rounds[code], s = B.slots[B.played];
      const home = s.g ? s.g.home : (s.side === 'hi' ? hi : lo), away = home === hi ? lo : hi;
      const sH = starterFor(m, home, s.day, base.last[home], s.g && s.g.hp), sA = starterFor(m, away, s.day, base.last[away], s.g && s.g.ap);
      const gp = gameProb(m, home, away, sH, sA, {
        fatH: fatigue(base.days[home], s.day), fatA: fatigue(base.days[away], s.day), formH: base.formAdj[home], formA: base.formAdj[away]
      });
      const live = B.live && B.live.i === B.played ? B.live : null;
      return {
        code, n: s.n, date: s.d, time: s.time, maybe: s.maybe, id: s.g ? s.g.id : null, home, away, hi, lo,
        wins: { [hi]: B.wins[hi] || 0, [lo]: B.wins[lo] || 0 },
        spH: { n: sH.n, ann: !!sH.ann, short: !!sH.short }, spA: { n: sA.n, ann: !!sA.ann, short: !!sA.short },
        p: live ? live.pre : gp.p, pP: gp.pP, pT: gp.pT, rH: +gp.rH.toFixed(2), rA: +gp.rA.toFixed(2),
        live: live ? { p: live.p, state: live.state || null } : null
      };
    }
    return null;
  }

  // 1위 팀의 한국시리즈 예상 선발 순서 (지금 휴식 상태 기준)
  function ksRotation(base) {
    const m = base.m, t = base.seeds[0], T = m.teams[t], B = base.rounds.KS;
    const last = base.last[t].slice(), out = [];
    B.slots.slice(0, 7).forEach(s => {
      const sp = starterFor(m, t, s.day, last, s.g && (s.g.home === t ? s.g.hp : s.g.ap));
      if (sp.i >= 0) last[sp.i] = s.day;
      out.push({ n: s.n, d: s.d, sp: sp.n, short: !!sp.short });
    });
    return { team: t, games: out, rotation: T.sp.slice(0, 4).map(p => p.n) };
  }

  /* ---------- 몬테카를로 ---------- */
  function runner(input, opt) {
    opt = opt || {};
    const base = prepare(input);
    if (!base) return null;
    const m = base.m, seeds = base.seeds, seed = opt.seed || P.SEED, rand = rng(seed);
    const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
    const acc = { n: 0, champ: {}, reach: { SPO: {}, PO: {}, KS: {} }, win: { WC: {}, SPO: {}, PO: {}, KS: {} },
      len: { WC: {}, SPO: {}, PO: {}, KS: {} }, ksPair: {}, samples: [], recent: [] };

    function series(code, hi, lo, st) {
      const B = base.rounds[code], need = META[code].need;
      const w = {}, t = {};
      w[hi] = B.wins[hi] || 0; w[lo] = B.wins[lo] || 0; t[hi] = B.ties[hi] || 0; t[lo] = B.ties[lo] || 0;
      let k = B.played;
      const over = () => code === 'WC' ? (w[hi] >= 1 || t[hi] >= 1 || w[lo] >= 2 || k >= 2) : (w[hi] >= need || w[lo] >= need);
      while (!over()) {
        const s = B.slots[Math.min(k, B.slots.length - 1)];
        const home = s.g && (s.g.home === hi || s.g.home === lo) ? s.g.home : (s.side === 'hi' ? hi : lo), away = home === hi ? lo : hi;
        let p;
        if (B.live && B.live.i === k) p = B.live.p;
        else {
          const sH = starterFor(m, home, s.day, st.last[home], s.g && s.g.hp), sA = starterFor(m, away, s.day, st.last[away], s.g && s.g.ap);
          p = gameProb(m, home, away, sH, sA, {
            fatH: fatigue(st.days[home], s.day), fatA: fatigue(st.days[away], s.day), formH: base.formAdj[home], formA: base.formAdj[away]
          }).p;
          if (sH.i >= 0) st.last[home][sH.i] = s.day;
          if (sA.i >= 0) st.last[away][sA.i] = s.day;
        }
        st.days[home].push(s.day); st.days[away].push(s.day);
        w[rand() < p ? home : away]++;
        k++;
      }
      const winner = code === 'WC' ? (w[lo] >= 2 ? lo : hi) : (w[hi] >= need ? hi : lo), loser = winner === hi ? lo : hi;
      return { w: winner, s: w[winner] + '-' + w[loser] };
    }
    function once() {
      const st = { last: {}, days: {} };
      for (const t in base.last) { st.last[t] = base.last[t].slice(); st.days[t] = base.days[t].slice(); }
      const wc = series('WC', seeds[3], seeds[4], st);
      const spo = series('SPO', seeds[2], wc.w, st);
      const po = series('PO', seeds[1], spo.w, st);
      const ks = series('KS', seeds[0], po.w, st);
      return { wc, spo, po, ks };
    }
    function step(n) {
      for (let i = 0; i < n; i++) {
        const r = once();
        acc.n++;
        inc(acc.win.WC, r.wc.w); inc(acc.win.SPO, r.spo.w); inc(acc.win.PO, r.po.w); inc(acc.win.KS, r.ks.w);
        inc(acc.reach.SPO, seeds[2]); inc(acc.reach.SPO, r.wc.w);
        inc(acc.reach.PO, seeds[1]); inc(acc.reach.PO, r.spo.w);
        inc(acc.reach.KS, seeds[0]); inc(acc.reach.KS, r.po.w);
        inc(acc.champ, r.ks.w);
        inc(acc.len.WC, r.wc.w + ' ' + r.wc.s); inc(acc.len.SPO, r.spo.w + ' ' + r.spo.s);
        inc(acc.len.PO, r.po.w + ' ' + r.po.s); inc(acc.len.KS, r.ks.w + ' ' + r.ks.s);
        inc(acc.ksPair, r.po.w + '>' + r.ks.w);
        const path = [r.wc.w, r.wc.s, r.spo.w, r.spo.s, r.po.w, r.po.s, r.ks.w, r.ks.s];
        if (acc.samples.length < 60) acc.samples.push(path);
        acc.recent.push([acc.n, path]); if (acc.recent.length > 6) acc.recent.shift();   // 화면의 '방금 돌린 가을' 목록용
      }
      return acc;
    }
    function result() {
      const pct = o => { const r = {}; Object.keys(o).forEach(k => { r[k] = +(100 * o[k] / acc.n).toFixed(2); }); return r; };
      const map = o => { const r = {}; Object.keys(o).forEach(k => { r[k] = pct(o[k]); }); return r; };
      return {
        v: VERSION, n: acc.n, seed, seeds: seeds.slice(),
        champ: pct(acc.champ), reach: map(acc.reach), win: map(acc.win), len: map(acc.len), ksPair: pct(acc.ksPair),
        samples: acc.samples, next: nextGame(base), ks: ksRotation(base),
        live: ROUNDS.map(c => base.rounds[c].live).filter(Boolean).map(l => ({ id: l.g.id, pre: +l.pre.toFixed(4), p: +l.p.toFixed(4), state: l.state || null }))[0] || null
      };
    }
    return { base, step, result, acc };
  }
  function simulate(input, opt) {
    opt = opt || {};
    const r = runner(input, opt);
    if (!r) return null;
    r.step(opt.n || P.N);
    return r.result();
  }

  // 경기마다 우승 확률이 어떻게 바뀌었나 — 끝난 가을야구 경기를 하나씩 더해 가며 다시 굴린다
  function history(input, opt) {
    opt = opt || {};
    const R = input.rounds || {}, all = [];
    // 주의: 경기 객체의 code는 경기 상태(RESULT 등) — 라운드는 rc에 따로 둔다
    ROUNDS.forEach(rc => ((R[rc] && R[rc].games) || []).forEach(g => { if (done(g)) all.push(Object.assign({}, g, { rc })); }));
    all.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    const nOf = {};
    const out = [];
    for (let k = 0; k <= all.length; k++) {
      const upto = all.slice(0, k), rounds = {};
      upto.forEach(g => {
        const r = rounds[g.rc] || (rounds[g.rc] = { code: g.rc, teams: [], games: [] });
        [g.away, g.home].forEach(t => { if (r.teams.indexOf(t) < 0) r.teams.push(t); });
        r.games.push(g);
      });
      const res = simulate({ model: input.model, seeds: input.seeds, rounds }, { n: opt.n || 10000, seed: opt.seed || P.SEED });
      if (!res) return null;
      const g = all[k - 1];
      if (g) nOf[g.rc] = (nOf[g.rc] || 0) + 1;
      out.push({
        k, id: g ? g.id : null, code: g ? g.rc : null, n: g ? nOf[g.rc] : 0, date: g ? g.date : null,
        away: g ? g.away : null, home: g ? g.home : null, as: g ? g.as : null, hs: g ? g.hs : null,
        champ: res.champ, ks: res.reach.KS
      });
    }
    return out;
  }

  return { VERSION, ROUNDS, META, PREV, SCHEDULE, P, innings, rng, buildTeams, gameProb, starterFor, prepare, runner, simulate, history, dnum, dstr };
});
