#!/usr/bin/env node
// KBO 정규시즌 예측 모델링 도구 (외부 패키지 없음, Node 18+)
//
//   node tools/predictor/predict.js backtest            최근 N경기 창 크기·가중치별 적중도 비교 (올 시즌 실경기로 채점)
//   node tools/predictor/predict.js sim                 잔여 시즌 몬테카를로 — 최종 순위 확률, 1위 경쟁 경기차 전망
//   node tools/predictor/predict.js sim --window 60 --form 0.5 --n 50000 --rival 삼성
//   node tools/predictor/predict.js form                팀별 최근 폼 요약
//   node tools/predictor/predict.js ag [--write]        아시안게임 차출 선수별 세부 지표·공백 영향 (--write: 보드용 보정값 파일 저장)
//
// 공통 옵션: --refresh (경기 데이터 캐시 무시하고 다시 받기)
// 데이터: 네이버 스포츠 일정 API (보드 수집기와 같은 출처). 하루 1회 캐시(tools/predictor/cache/).

const fs = require('fs');
const path = require('path');

const API = 'https://api-gw.sports.naver.com';
const UA = { 'User-Agent': 'Mozilla/5.0 (ktwiz-board predictor)' };
const TEAMS = ['KT', 'LG', '삼성', '두산', 'KIA', '롯데', 'SSG', 'NC', '키움', '한화'];
const SEASON_START = '2026-03-28';
const SEASON_END = '2026-10-31';
const SEASON_GAMES = 144;
const E = 1.83;           // 피타고리안 지수 (보드와 동일)
const HOME_ADV = 0.02;    // 홈팀 승률 가산 (백테스트로 조정 가능: --home)
const isPs = id => /^(4444|3333|5555|7777)/.test(String(id)); // 포스트시즌 gameId 접두어

// ---------- 인자 ----------
const argv = process.argv.slice(2);
const cmd = argv[0] || 'sim';
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
};

// ---------- 날짜 ----------
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
function ranges(from, to, step) {
  const out = [];
  for (let f = from; f <= to; f = addDays(f, step)) { const t = addDays(f, step - 1); out.push([f, t < to ? t : to]); }
  return out;
}

// ---------- 데이터 ----------
async function fetchGames(from, to) {
  const u = `${API}/schedule/games?fields=basic,stadium&upperCategoryId=kbaseball&categoryId=kbo&fromDate=${from}&toDate=${to}&size=500`;
  const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  const d = await r.json();
  return (d.result && d.result.games) || [];
}
async function loadSeason() {
  const today = kstToday();
  const dir = path.join(__dirname, 'cache');
  const file = path.join(dir, `games-${today}.json`);
  if (!opt('refresh', false) && fs.existsSync(file)) return { today, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  const raw = [];
  for (const [f, t] of ranges(SEASON_START, SEASON_END, 60)) raw.push(...await fetchGames(f, t));
  const reg = raw.filter(g => TEAMS.includes(g.homeTeamName) && TEAMS.includes(g.awayTeamName) && !isPs(g.gameId));
  const played = reg.filter(g => g.statusCode === 'RESULT' && !g.cancel)
    .map(g => ({ t: g.gameDateTime || g.gameDate, d: g.gameDate, h: g.homeTeamName, a: g.awayTeamName, hs: g.homeTeamScore, as: g.awayTeamScore }))
    .sort((x, y) => x.t < y.t ? -1 : 1);
  const future = reg.filter(g => g.statusCode === 'BEFORE' && !g.cancel && g.gameDate >= today)
    .map(g => ({ t: g.gameDateTime || g.gameDate, d: g.gameDate, h: g.homeTeamName, a: g.awayTeamName }))
    .sort((x, y) => x.t < y.t ? -1 : 1);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith('games-') && f !== path.basename(file)) fs.unlinkSync(path.join(dir, f));
  fs.writeFileSync(file, JSON.stringify({ played, future }));
  return { today, played, future };
}

// ---------- 모델 ----------
// 팀 전력 = form(최근 window경기: 승률·피타고리안 반반) × formWeight + season(피타고리안 70%·승률 30%) × (1-formWeight),
// 그 다음 리그 평균(.5)으로 regress만큼 회귀. 경기 승률 = log5(홈, 원정) + 홈 어드밴티지.
const pyth = (rs, ra) => (rs + ra) ? Math.pow(rs, E) / (Math.pow(rs, E) + Math.pow(ra, E)) : 0.5;
const log5 = (a, b) => { const v = (a - a * b) / (a + b - 2 * a * b); return isFinite(v) ? v : 0.5; };
function logs(played) {
  const L = {}; for (const t of TEAMS) L[t] = [];
  for (const g of played) {
    L[g.h].push({ d: g.d, rs: g.hs, ra: g.as });
    L[g.a].push({ d: g.d, rs: g.as, ra: g.hs });
  }
  return L;
}
function agg(arr) {
  const s = { n: arr.length, w: 0, l: 0, d: 0, rs: 0, ra: 0 };
  for (const x of arr) { s.rs += x.rs; s.ra += x.ra; s[x.rs > x.ra ? 'w' : x.rs < x.ra ? 'l' : 'd']++; }
  return s;
}
function strength(hist, cfg) {
  if (hist.length < 5) return 0.5;
  const sea = agg(hist);
  const seaStr = 0.7 * pyth(sea.rs, sea.ra) + 0.3 * sea.w / Math.max(1, sea.w + sea.l);
  let s = seaStr;
  if (cfg.window !== 'season' && cfg.formWeight > 0) {
    const f = agg(hist.slice(-cfg.window));
    const formStr = 0.5 * f.w / Math.max(1, f.w + f.l) + 0.5 * pyth(f.rs, f.ra);
    s = cfg.formWeight * formStr + (1 - cfg.formWeight) * seaStr;
  }
  return s * (1 - cfg.regress) + 0.5 * cfg.regress;
}
// 기본값 = 백테스트 최상위권(2026-09-25): 최근 60경기 30% + 시즌 70%, 회귀 0.3
const DEFAULT = { window: 60, formWeight: 0.3, regress: 0.3, home: HOME_ADV };

// ---------- 선수 공백 (아시안게임 대표 차출) ----------
// 선수별 시즌 성적(KBO 공식 기록실)으로 "이 선수가 빠지면 팀이 경기당 몇 점 손해인가"를 추정한다.
//  - 타자: wOBA(선형 가중치) → 리그 평균 대비 득점(wRAA) + 대체선수 보정(600타석당 20점) × 경기당 타석
//  - 투수: 실점률(RA9) vs 대체선수 실점률(리그 × 선발 1.3 / 불펜 1.15) × 경기당 이닝, 마무리·필승조는 레버리지 가중
//  수비·주루·포지션 가치는 반영하지 않는다(공개 기록만으로는 추정 불가) → 수비형 선수는 과소평가될 수 있음.
const KBO = 'https://www.koreabaseball.com';
async function getHtml(u) {
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.text();
}
const strip = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
const rowsOf = t => (t.match(/<tr[\s\S]*?<\/tr>/g) || []).map(r => (r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/g) || []).map(strip));
const tablesOf = h => (h.match(/<table[\s\S]*?<\/table>/g) || []).map(rowsOf);
function firstRows(tbls, n) { // 앞 n개 표의 [헤더, 첫 데이터행]을 {컬럼: 값}으로 합친다
  const o = {};
  for (const t of tbls.slice(0, n)) if (t.length >= 2) t[0].forEach((k, i) => { if (!(k in o)) o[k] = t[1][i]; });
  return o;
}
const innings = s => { // "56 2/3" · "2/3" · "56"
  s = String(s || '0').trim();
  const [a, b] = s.includes(' ') ? s.split(/\s+/) : (s.includes('/') ? ['0', s] : [s, '']);
  return (+a || 0) + (b ? (+b.split('/')[0]) / 3 : 0);
};
const num = v => +String(v || '0').replace(/,/g, '') || 0;
function wobaOf(s) {
  const H = num(s.H), D = num(s['2B']), T = num(s['3B']), HR = num(s.HR), BB = num(s.BB), IBB = num(s.IBB), HBP = num(s.HBP), AB = num(s.AB), SF = num(s.SF);
  const den = AB + BB - IBB + SF + HBP;
  return den ? (0.69 * (BB - IBB) + 0.72 * HBP + 0.89 * (H - D - T - HR) + 1.27 * D + 1.62 * T + 2.10 * HR) / den : 0;
}
async function loadAG() {
  const cfgFile = path.join(__dirname, 'ag-2026.json');
  const ag = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const file = path.join(__dirname, 'cache', `ag-${kstToday()}.json`);
  if (!opt('refresh', false) && fs.existsSync(file)) return { ...ag, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  // 리그 타격 합계 (wOBA 기준선) + 팀 경기 수
  const [b1] = tablesOf(await getHtml(`${KBO}/Record/Team/Hitter/Basic1.aspx`));
  const [b2] = tablesOf(await getHtml(`${KBO}/Record/Team/Hitter/Basic2.aspx`));
  const col = (t, k) => t[0].indexOf(k);
  const lg = { H: 0, '2B': 0, '3B': 0, HR: 0, BB: 0, IBB: 0, HBP: 0, AB: 0, SF: 0, PA: 0, R: 0 }, teamG = {};
  // 표 끝의 '합계' 행은 칸이 밀려 있으므로 10개 구단 행만 사용
  for (const r of b1.slice(1).filter(r => TEAMS.includes(r[1]))) {
    for (const k of ['H', '2B', '3B', 'HR', 'AB', 'SF', 'PA', 'R']) lg[k] += num(r[col(b1, k)]);
    teamG[r[1]] = num(r[col(b1, 'G')]);
  }
  for (const r of b2.slice(1).filter(r => TEAMS.includes(r[1]))) for (const k of ['BB', 'IBB', 'HBP']) lg[k] += num(r[col(b2, k)]);
  const players = [];
  for (const p of ag.players) {
    const sh = await getHtml(`${KBO}/Player/Search.aspx?searchWord=${encodeURIComponent(p.name)}`);
    let id = null;
    for (const r of (sh.match(/<tr[\s\S]*?<\/tr>/g) || [])) {
      const m = r.match(/playerId=(\d+)/);
      if (m && (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(strip).includes(p.team)) { id = m[1]; break; }
    }
    if (!id) { console.warn(`  ! 선수 검색 실패: ${p.name}(${p.team}) — 제외`); continue; }
    const kind = p.pos === 'P' ? 'PitcherDetail' : 'HitterDetail';
    players.push({ ...p, id, s: firstRows(tablesOf(await getHtml(`${KBO}/Record/Player/${kind}/Basic.aspx?playerId=${id}`)), 2) });
  }
  const out = { lg: { woba: wobaOf(lg), rpa: lg.R / lg.PA, teamG }, stats: players };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return { ...ag, ...out };
}
// 선수별 경기당 손실 득점 → 팀별 전력 변화(피타고리안 기준)
function agImpact(ag, played) {
  const L = logs(played);
  const lgRA9 = played.reduce((a, g) => a + g.hs + g.as, 0) / (played.length * 2); // 팀 경기당 실점 ≈ 9이닝 실점률
  const rows = [], team = {};
  for (const t of TEAMS) team[t] = { dRS: 0, dRA: 0, names: [] };
  for (const p of ag.stats) {
    const s = p.s, tg = ag.lg.teamG[p.team] || agg(L[p.team]).n || 130;
    let dRS = 0, dRA = 0, line = '';
    if (p.pos === 'H') {
      const PA = num(s.PA);
      if (!PA) continue;
      const w = wobaOf(s);
      dRS = ((w - ag.lg.woba) / 1.2 + 20 / 600) * PA / tg;
      line = `타율 ${s.AVG} OPS ${s.OPS} wOBA ${w.toFixed(3).slice(1)} · ${PA}타석 ${s.HR}홈런`;
    } else {
      const IP = innings(s.IP), G = num(s.G);
      if (!IP) continue;
      const ra9 = num(s.R) * 9 / IP, sp = IP / Math.max(1, G) > 3;
      const lev = num(s.SV) >= 10 ? 1.7 : (num(s.HLD) >= 10 ? 1.3 : 1);
      dRA = (lgRA9 * (sp ? 1.3 : 1.15) - ra9) / 9 * IP / tg * lev;
      line = `ERA ${s.ERA} · ${s.IP}이닝 · ${sp ? '선발' : '불펜'}` + (num(s.SV) ? ` ${s.SV}세이브` : '') + (num(s.HLD) ? ` ${s.HLD}홀드` : '') + (lev > 1 ? ` (레버리지 ×${lev})` : '');
    }
    rows.push({ ...p, line, dRS, dRA, runs: dRS + dRA });
    team[p.team].dRS += dRS; team[p.team].dRA += dRA; team[p.team].names.push(p.name);
  }
  // 팀 전력 변화 = 피타고리안(득점 − dRS, 실점 + dRA) − 피타고리안(득점, 실점), 경기당 기준
  for (const t of TEAMS) {
    const a = agg(L[t]), rsg = a.rs / Math.max(1, a.n), rag = a.ra / Math.max(1, a.n);
    team[t].delta = pyth(rsg - team[t].dRS, rag + team[t].dRA) - pyth(rsg, rag);
  }
  return { rows: rows.sort((x, y) => y.runs - x.runs), team, lgRA9 };
}

// ---------- backtest ----------
// 올 시즌 각 경기를 "그 경기 이전 데이터만으로" 예측해 채점한다 (미래 정보 누설 없음).
//  - logloss/Brier: 경기 단위 승패 예측 정확도 (낮을수록 좋음)
//  - next20 MAE: 그 시점 전력으로 예측한 향후 20경기 승률 vs 실제 (경기차 전망에 더 가까운 지표)
function backtest(played, cfg, from) {
  const L = {}; for (const t of TEAMS) L[t] = [];
  let ll = 0, br = 0, n = 0, hit = 0;
  const snaps = []; // {team, idx, pred}
  for (const g of played) {
    if (g.d >= from && g.hs !== g.as) {
      const p = Math.min(0.99, Math.max(0.01, log5(strength(L[g.h], cfg), strength(L[g.a], cfg)) + cfg.home));
      const y = g.hs > g.as ? 1 : 0;
      ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
      br += (p - y) ** 2; n++; if ((p >= 0.5) === (y === 1)) hit++;
    }
    for (const [tm, rs, ra] of [[g.h, g.hs, g.as], [g.a, g.as, g.hs]]) {
      if (g.d >= from && L[tm].length % 10 === 0) snaps.push({ tm, idx: L[tm].length, pred: strength(L[tm], cfg) });
      L[tm].push({ d: g.d, rs, ra });
    }
  }
  let mae = 0, m = 0;
  for (const s of snaps) {
    const next = L[s.tm].slice(s.idx, s.idx + 20);
    if (next.length < 20) continue;
    const a = agg(next);
    mae += Math.abs(s.pred - a.w / Math.max(1, a.w + a.l)); m++;
  }
  return { logloss: ll / n, brier: br / n, acc: hit / n, n, mae20: m ? mae / m : NaN, m };
}

// ---------- 시뮬레이션 ----------
function simulate(played, future, cfg, N, rival, agx) {
  const L = logs(played);
  const S = {}; for (const t of TEAMS) S[t] = strength(L[t], cfg);
  // 대표 차출 공백: 공백 기간에 치른 경기가 폼·시즌 성적에 섞여 있으므로 그 몫을 되돌려 '완전체' 전력(S)을 만들고,
  // 복귀 전 경기(날짜 < agx.ret)에만 공백 전력(Sabs)을 쓴다.
  const Sabs = { ...S };
  if (agx) for (const t of TEAMS) {
    const d = agx.team[t].delta;
    if (!d) continue;
    const h = L[t], n = h.length, season = cfg.window === 'season';
    const w = season ? n : Math.min(cfg.window, n), fw = season ? 0 : cfg.formWeight, k = 1 - cfg.regress;
    const ff = h.slice(-w).filter(x => x.d >= agx.leave).length / Math.max(1, w);
    const fs = h.filter(x => x.d >= agx.leave).length / Math.max(1, n);
    S[t] -= d * k * (fw * ff + (1 - fw) * fs);
    Sabs[t] = S[t] + d * k;
  }
  const str = (t, d) => (agx && d < agx.ret ? Sabs[t] : S[t]);
  const base = {}; for (const t of TEAMS) base[t] = agg(L[t]);
  const unset = {}; for (const t of TEAMS) unset[t] = Math.max(0, SEASON_GAMES - base[t].n - future.filter(g => g.h === t || g.a === t).length);
  const dates = [...new Set(future.filter(g => g.h === 'KT' || g.a === 'KT' || g.h === rival || g.a === rival).map(g => g.d))];
  const gbBuf = dates.map(() => []), gbFinal = [];
  const rankCnt = {}; for (const t of TEAMS) rankCnt[t] = new Array(10).fill(0);
  const winsBuf = {}; for (const t of TEAMS) winsBuf[t] = [];
  for (let i = 0; i < N; i++) {
    const W = {}, Lo = {}; for (const t of TEAMS) { W[t] = base[t].w; Lo[t] = base[t].l; }
    let di = 0;
    for (let k = 0; k < future.length; k++) {
      const g = future[k];
      if (Math.random() < log5(str(g.h, g.d), str(g.a, g.d)) + cfg.home) { W[g.h]++; Lo[g.a]++; } else { W[g.a]++; Lo[g.h]++; }
      const nd = future[k + 1] ? future[k + 1].d : null;
      if (di < dates.length && g.d === dates[di] && nd !== g.d) { gbBuf[di].push(((W.KT - W[rival]) + (Lo[rival] - Lo.KT)) / 2); di++; }
    }
    for (const t of TEAMS) for (let u = 0; u < unset[t]; u++) { if (Math.random() < log5(S[t], 0.5)) W[t]++; else Lo[t]++; }
    gbFinal.push(((W.KT - W[rival]) + (Lo[rival] - Lo.KT)) / 2);
    // 승률 순위 (동률은 무작위 — 실제로는 1위 결정전·상대전적 등 KBO 규정)
    const order = TEAMS.map(t => ({ t, p: W[t] / Math.max(1, W[t] + Lo[t]) + Math.random() * 1e-9 })).sort((a, b) => b.p - a.p);
    order.forEach((o, r) => rankCnt[o.t][r]++);
    for (const t of TEAMS) winsBuf[t].push(W[t]);
  }
  return { S, Sabs, base, unset, dates, gbBuf, gbFinal, rankCnt, winsBuf };
}

// ---------- 출력 ----------
const pct = v => (100 * v).toFixed(1).padStart(5) + '%';
const q = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pad = (s, n) => { s = String(s); const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, n - w)); };
const signed = v => (v > 0 ? '+' : '') + v.toFixed(1);

async function main() {
  const { today, played, future } = await loadSeason();
  console.log(`데이터: ${today} 기준 · 소화 ${played.length}경기 · 잔여 편성 ${future.length}경기\n`);

  if (cmd === 'form') {
    const L = logs(played);
    const w = +opt('window', 30);
    console.log(pad('팀', 6) + pad(`최근${w}경기`, 14) + pad('득/실', 10) + pad('피타고리안', 11) + '시즌');
    for (const t of TEAMS) {
      const f = agg(L[t].slice(-w)), s = agg(L[t]);
      console.log(pad(t, 6) + pad(`${f.w}승${f.l}패${f.d}무`, 14) + pad(`${f.rs}/${f.ra}`, 10) + pad(pyth(f.rs, f.ra).toFixed(3), 11) + `${s.w}-${s.l}-${s.d}`);
    }
    return;
  }

  if (cmd === 'backtest') {
    const from = opt('from', '2026-05-15'); // 초반엔 표본이 적어 모든 모델이 불안정 → 5월 중순부터 채점
    const windows = String(opt('windows', '10,20,30,45,60')).split(',').map(Number);
    const weights = String(opt('weights', '0.3,0.5,0.7,1')).split(',').map(Number);
    const base = { ...DEFAULT, regress: +opt('regress', DEFAULT.regress), home: +opt('home', DEFAULT.home) };
    const rows = [];
    rows.push({ name: '동전 던지기(50%)', r: backtest(played, { window: 'season', formWeight: 0, regress: 1, home: 0 }, from) });
    rows.push({ name: '시즌 전체만', r: backtest(played, { ...base, window: 'season', formWeight: 0 }, from) });
    for (const w of windows) for (const fw of weights)
      rows.push({ name: `최근 ${w}경기 × ${Math.round(fw * 100)}%`, r: backtest(played, { ...base, window: w, formWeight: fw }, from) });
    rows.sort((a, b) => a.r.logloss - b.r.logloss);
    console.log(`회귀 ${base.regress} · 홈 +${base.home}`);
    console.log(`백테스트: ${from} 이후 ${rows[0].r.n}경기를 "그 전날까지 데이터"로만 예측해 채점 (무승부 제외)`);
    console.log('logloss·Brier·20경기MAE는 낮을수록, 적중률은 높을수록 좋음. logloss 순 정렬.\n');
    console.log(pad('모델', 22) + pad('logloss', 10) + pad('Brier', 9) + pad('적중률', 9) + '향후20경기 승률오차');
    for (const { name, r } of rows)
      console.log(pad(name, 22) + pad(r.logloss.toFixed(4), 10) + pad(r.brier.toFixed(4), 9) + pad(pct(r.acc), 9) + (isNaN(r.mae20) ? '-' : (r.mae20 * 1000).toFixed(1) + ' 리(.001)'));
    const coin = rows.find(x => x.name.startsWith('동전')).r.logloss;
    const best = rows[0];
    console.log(`\n최선: ${best.name} — 동전 대비 logloss ${((1 - best.r.logloss / coin) * 100).toFixed(2)}% 개선`);
    console.log('참고: 야구는 한 경기 승패의 운 비중이 커서 어떤 모델도 적중률 55~60% 근처가 한계다. 차이는 작아도 누적되면 의미가 있다.');
    return;
  }

  if (cmd === 'ag') {
    const ag = await loadAG();
    const imp = agImpact(ag, played);
    console.log(ag.note + '\n');
    console.log(`리그 기준선: wOBA ${ag.lg.woba.toFixed(3)} · 경기당 실점 ${imp.lgRA9.toFixed(2)}\n`);
    console.log('■ 선수별 공백 영향 (팀이 경기당 잃는 득점 = 공격 손실 + 추가 실점)');
    console.log(pad('선수', 8) + pad('팀', 6) + pad('경기당', 8) + '세부 지표');
    for (const p of imp.rows) console.log(pad(p.name, 8) + pad(p.team, 6) + pad((p.runs >= 0 ? '-' : '+') + Math.abs(p.runs).toFixed(3), 8) + p.line);
    console.log('\n■ 팀별 합계 (공백 중 피타고리안 승률 변화, 1리 = .001)');
    for (const t of TEAMS.filter(t => imp.team[t].names.length).sort((a, b) => imp.team[a].delta - imp.team[b].delta)) {
      const x = imp.team[t];
      console.log(pad(t, 6) + pad(`${(x.delta * 1000).toFixed(1)}리`, 9) + pad(`득점 ${(-x.dRS).toFixed(2)} · 실점 +${x.dRA.toFixed(2)} /경기`, 32) + x.names.join(', '));
    }
    console.log('\n※ 수비·주루·포지션 가치는 공개 기록만으로 추정이 어려워 제외 — 수비형 선수는 과소평가될 수 있음.');
    // --write: 보드 수집기가 읽는 보정값 파일로 저장 (tools/predictor/ag-impact.json)
    if (opt('write', false)) {
      const out = {
        generated: today, leave: ag.leave, ret: ag.return,
        teams: Object.fromEntries(TEAMS.filter(t => imp.team[t].names.length).map(t => [t, { delta: +imp.team[t].delta.toFixed(4), dRS: +imp.team[t].dRS.toFixed(3), dRA: +imp.team[t].dRA.toFixed(3), names: imp.team[t].names }])),
        players: imp.rows.map(p => ({ name: p.name, team: p.team, pos: p.pos, runs: +p.runs.toFixed(3), line: p.line }))
      };
      fs.writeFileSync(path.join(__dirname, 'ag-impact.json'), JSON.stringify(out, null, 1));
      console.log('\n→ tools/predictor/ag-impact.json 저장 (보드 경기차 전망이 이 값으로 공백을 보정)');
    }
    return;
  }

  if (cmd === 'sim') {
    const cfg = { ...DEFAULT };
    if (opt('window', null)) cfg.window = opt('window') === 'season' ? 'season' : +opt('window');
    if (opt('form', null)) cfg.formWeight = +opt('form');
    if (opt('regress', null)) cfg.regress = +opt('regress');
    if (opt('home', null)) cfg.home = +opt('home');
    const N = +opt('n', 20000);
    const L = logs(played);
    const seaOrder = TEAMS.slice().sort((a, b) => { const x = agg(L[a]), y = agg(L[b]); return y.w / (y.w + y.l) - x.w / (x.w + x.l); });
    const rival = opt('rival', seaOrder.find(t => t !== 'KT'));
    console.log(`모델: 최근 ${cfg.window}경기 폼 ${Math.round(cfg.formWeight * 100)}% + 시즌 ${Math.round((1 - cfg.formWeight) * 100)}%, 회귀 ${cfg.regress}, 홈 +${cfg.home} · ${N.toLocaleString()}회\n`);
    // 대표 차출 공백 (--no-ag로 끔)
    let agx = null;
    if (!opt('no-ag', false)) {
      const ag = await loadAG();
      const imp = agImpact(ag, played);
      agx = { team: imp.team, leave: ag.leave, ret: opt('ag-return', ag.return) };
      const aff = TEAMS.filter(t => imp.team[t].delta);
      console.log(`아시안게임 공백 반영: ${agx.leave} 이후 치른 경기는 '공백 중'으로 보정, ${agx.ret} 전 경기는 공백 전력으로 시뮬레이션`);
      console.log('  ' + aff.map(t => `${t} ${(imp.team[t].delta * 1000).toFixed(0)}리(${imp.team[t].names.join('·')})`).join(' / ') + '\n');
    }
    const r = simulate(played, future, cfg, N, rival, agx);

    console.log('■ 최종 순위 확률');
    console.log(pad('팀', 6) + pad('현재', 12) + pad('전력', 7) + pad('공백중', 7) + pad('예상 최종승', 12) + pad('1위', 8) + pad('2위', 8) + pad('5위 이내', 9) + '미편성');
    for (const t of seaOrder) {
      const b = r.base[t], rc = r.rankCnt[t];
      console.log(pad(t, 6) + pad(`${b.w}-${b.l}-${b.d}`, 12) + pad(r.S[t].toFixed(3), 7) + pad(r.Sabs[t] !== r.S[t] ? r.Sabs[t].toFixed(3) : '-', 7) + pad(`${q(r.winsBuf[t], .5)} (${q(r.winsBuf[t], .1)}~${q(r.winsBuf[t], .9)})`, 12) +
        pad(pct(rc[0] / N), 8) + pad(pct(rc[1] / N), 8) + pad(pct(rc.slice(0, 5).reduce((a, c) => a + c, 0) / N), 9) + r.unset[t]);
    }

    const now = ((r.base.KT.w - r.base[rival].w) + (r.base[rival].l - r.base.KT.l)) / 2;
    console.log(`\n■ KT vs ${rival} 경기차 전망 (+ = KT 우위, 현재 ${signed(now)})`);
    console.log(pad('날짜', 8) + pad('중앙값', 8) + pad('50% 범위', 14) + '80% 범위');
    r.dates.forEach((d, i) => {
      const b = r.gbBuf[i];
      console.log(pad(d.slice(5), 8) + pad(signed(q(b, .5)), 8) + pad(`${signed(q(b, .25))}~${signed(q(b, .75))}`, 14) + `${signed(q(b, .1))}~${signed(q(b, .9))}`);
    });
    const f = r.gbFinal;
    console.log(pad('최종', 8) + pad(signed(q(f, .5)), 8) + pad(`${signed(q(f, .25))}~${signed(q(f, .75))}`, 14) + `${signed(q(f, .1))}~${signed(q(f, .9))}   (미편성 경기 포함)`);
    console.log(`\n※ 동률 순위는 무작위 처리(실제는 1위 결정전·상대전적 등). 미편성 경기는 리그 평균 상대로 가정.`);
    return;
  }

  console.log('사용법: node tools/predictor/predict.js [sim|backtest|form] [옵션]');
}

main().catch(e => { console.error(e.message); process.exit(1); });
