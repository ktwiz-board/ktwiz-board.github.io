// 정규시즌 최종 순위 확률 (가을야구 시드 경쟁 추적표용)
//
// - 지금: 현재 성적 + 남은 일정을 팀 전력으로 3,000번 굴려 팀별 최종 1~10위 확률
// - 추적: 9월 1일부터 매일 '그날 시작 시점'(전날까지의 결과 + 그 뒤 실제 대진)으로 같은 계산을 해 기록
//   과거 날짜는 한 번 계산하면 고정(다음 날 다시 계산하지 않음)
// - 확정: 남은 경기를 전승/전패해도 바뀌지 않는 최고·최저 순위 (승률 비교, 동률은 확정으로 보지 않음)
//
// 팀 전력은 보드의 다른 확률과 같은 값(선수 WAR 합산 roster.full, 없으면 시즌 피타고리안 블렌드)을 쓴다.

const N = 3000, HOME = 0.02, HIST_FROM = '2026-09-01', SEASON_GAMES = 144;
const log5 = (a, b) => { const v = (a - a * b) / (a + b - 2 * a * b); return isFinite(v) ? v : 0.5; };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const key = (d, a, h) => d + '|' + a + '|' + h;

// base: {팀: {w,l,d}}, remaining: [[날짜, 원정, 홈], ...]
function simulate(teams, base, remaining, S) {
  const cnt = {}; for (const t of teams) cnt[t] = new Array(teams.length).fill(0);
  const games = remaining.filter(g => S[g[1]] != null && S[g[2]] != null).map(g => [g[1], g[2], log5(S[g[2]], S[g[1]]) + HOME]);
  const W = {}, L = {};
  for (let i = 0; i < N; i++) {
    for (const t of teams) { W[t] = base[t].w; L[t] = base[t].l; }
    for (const [a, h, pH] of games) { if (Math.random() < pH) { W[h]++; L[a]++; } else { W[a]++; L[h]++; } }
    teams.map(t => ({ t, p: W[t] / Math.max(1, W[t] + L[t]) + Math.random() * 1e-9 }))   // 동률은 무작위(실제로는 상대전적 등)
      .sort((x, y) => y.p - x.p).forEach((o, r) => cnt[o.t][r]++);
  }
  const out = {};
  for (const t of teams) {
    const p = cnt[t].map(c => c / N);
    out[t] = { p: [p[0], p[1], p[2], p[3], p[4], p.slice(5).reduce((a, b) => a + b, 0)].map(v => +v.toFixed(3)),
               er: +p.reduce((a, v, r) => a + v * (r + 1), 0).toFixed(2) };
  }
  return out;
}

// 남은 경기를 모두 이기거나 모두 져도 바뀌지 않는 순위 범위
function clinch(teams, base, remCount) {
  const out = {};
  const maxP = t => (base[t].w + remCount[t]) / Math.max(1, base[t].w + base[t].l + remCount[t]);
  const minP = t => base[t].w / Math.max(1, base[t].w + base[t].l + remCount[t]);
  for (const t of teams) {
    const above = teams.filter(o => o !== t && minP(o) > maxP(t)).length;   // 무조건 나보다 위
    const below = teams.filter(o => o !== t && maxP(o) < minP(t)).length;   // 무조건 나보다 아래
    out[t] = { best: above + 1, worst: teams.length - below };
  }
  return out;
}

// played: [{d, a, h, as, hs}] 정규시즌 완료 경기, league: [[날짜, 원정, 홈]] 남은 편성, standings: 현재 순위표
function seedProjection({ today, played, league, standings, strength, prev }) {
  const teams = standings.map(t => t.name);
  const S = strength;
  const playedKey = new Set(played.map(g => key(g.d, g.a, g.h)));
  const future = (league || []).filter(g => !playedKey.has(key(g[0], g[1], g[2])));   // 아직 안 치른 편성 경기

  // 지금
  const base = {}; for (const t of standings) base[t.name] = { w: t.w, l: t.l, d: t.d };
  const remCount = {}; for (const t of teams) remCount[t] = Math.max(0, SEASON_GAMES - (base[t].w + base[t].l + base[t].d));
  const now = simulate(teams, base, future, S);
  const lock = clinch(teams, base, remCount);
  for (const t of teams) Object.assign(now[t], lock[t], { rem: remCount[t] });

  // 추적: 날짜별 시작 시점 스냅샷 (이미 있는 날짜는 그대로)
  const hist = (prev && prev.v === 1 && Array.isArray(prev.hist)) ? prev.hist.filter(h => h.d >= HIST_FROM && h.d <= today) : [];
  const have = new Set(hist.map(h => h.d));
  for (let d = HIST_FROM; d <= today; d = addDays(d, 1)) {
    if (have.has(d)) continue;
    const b = {}; for (const t of teams) b[t] = { w: 0, l: 0, d: 0 };
    const rem = [];
    for (const g of played) {
      if (g.d < d) { const [hw, aw] = g.hs > g.as ? ['w', 'l'] : g.hs < g.as ? ['l', 'w'] : ['d', 'd']; b[g.h][hw]++; b[g.a][aw]++; }
      else rem.push([g.d, g.a, g.h]);
    }
    const snap = simulate(teams, b, rem.concat(future), S);
    const e = { d, er: {}, p: {} };
    for (const t of teams) { e.er[t] = snap[t].er; e.p[t] = snap[t].p; }
    hist.push(e);
  }
  hist.sort((x, y) => x.d < y.d ? -1 : 1);
  return { v: 1, date: today, n: N, now, hist };
}

module.exports = { seedProjection };
