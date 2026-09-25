// 선수 단위 팀 전력 (보드 수집기·예측 도구 공용)
//
// 네이버 스포츠 통계 API의 선수별 시즌 기록(WAR 포함 — 타격·수비·주루·투구를 한 숫자로 합친 대체선수 대비 승리 기여)으로
// "지금 로스터가 한 경기에서 대체선수 팀보다 몇 승을 더 만드는가"를 구해 팀 전력(평균 상대에 대한 기대 승률)으로 쓴다.
//
//  1) 선수 기여율: 타자 WAR/(타석+100), 투수 WAR/(이닝+25) — 표본이 적은 선수는 대체선수(0) 쪽으로 자동 수축
//  2) 출전 비중: 시즌 타석·이닝 그대로(주전은 많이, 백업은 적게)
//  3) 팀 경기당 WAR = Σ(기여율 × 타석·이닝) ÷ 팀 경기 수   → 방출·은퇴 선수는 제외(현재 로스터 기준)
//  4) 팀 전력 = .500 + k × (경기당 WAR − 리그 평균). WAR 합은 팀 간 격차를 실제보다 작게 잡는 경향이 있어(수축·대체선수 기준 차이)
//     k는 10개 팀의 피타고리안 기대승률에 최소제곱으로 맞춘 배율 — 순서·구성·결장 효과는 WAR에서, 격차의 크기만 실제 득실에 맞춘다
//  5) 결장 선수(아시안게임 차출 등)는 그 몫을 대체선수(0)로 바꾼 전력을 따로 만든다
//
// 한계: 경기별 선발 로테이션·부상자 명단은 반영하지 않는다(공개 데이터 없음). WAR 산식은 네이버(스탯티즈 계열) 기준.

const API = 'https://api-gw.sports.naver.com';
const TEAM_CODE = { KT: 'KT', 삼성: 'SS', LG: 'LG', 두산: 'OB', KIA: 'HT', 롯데: 'LT', SSG: 'SK', NC: 'NC', 키움: 'WO', 한화: 'HH' };
const PA0 = 100, IP0 = 25, REGRESS = 0.15;

const innings = s => {
  s = String(s == null ? '0' : s).trim();
  const [a, b] = s.includes(' ') ? s.split(/\s+/) : (s.includes('/') ? ['0', s] : [s, '']);
  return (+a || 0) + (b ? (+b.split('/')[0]) / 3 : 0);
};

async function fetchTeam(code, type, ua) {
  const u = `${API}/statistics/categories/kbo/seasons/2026/players?playerType=${type}&teamCode=${code}&pageSize=200`;
  const r = await fetch(u, { headers: ua || { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  const d = await r.json();
  return (d.result && d.result.seasonPlayerStats) || [];
}

// games: {팀: 소화 경기 수}, absent: [{name, team}] 결장 선수, pyth: {팀: 피타고리안 기대승률}(배율 보정용, 없으면 k=1)
async function rosterStrength(games, absent, ua, pyth) {
  const teams = {};
  for (const [name, code] of Object.entries(TEAM_CODE)) {
    const [hs, ps] = await Promise.all([fetchTeam(code, 'HITTER', ua), fetchTeam(code, 'PITCHER', ua)]);
    const active = p => p.isRetire !== 'Y' && p.isPlayer !== 'N';
    const players = [];
    for (const p of hs.filter(active)) {
      const pa = (p.hitterAb || 0) + (p.hitterBb || 0) + (p.hitterHp || 0);
      if (!pa || p.hitterWar == null) continue;
      players.push({ n: p.playerName, t: 'H', war: p.hitterWar, amt: pa, v: pa * p.hitterWar / (pa + PA0),
        s: `타율 ${(p.hitterHra || 0).toFixed(3).slice(1)} OPS ${(p.hitterOps || 0).toFixed(3)} wRC+ ${Math.round(p.hitterWrcPlus || 0)} · ${pa}타석` });
    }
    for (const p of ps.filter(active)) {
      const ip = innings(p.pitcherInning);
      if (!ip || p.pitcherWar == null) continue;
      players.push({ n: p.playerName, t: 'P', war: p.pitcherWar, amt: ip, v: ip * p.pitcherWar / (ip + IP0),
        s: `ERA ${(p.pitcherEra || 0).toFixed(2)} · ${p.pitcherInning}이닝` + (p.pitcherSave ? ` ${p.pitcherSave}세` : '') + (p.pitcherHold ? ` ${p.pitcherHold}홀` : '') });
    }
    const G = Math.max(1, games[name] || 1);
    const hit = players.filter(x => x.t === 'H').reduce((a, x) => a + x.v, 0);
    const pit = players.filter(x => x.t === 'P').reduce((a, x) => a + x.v, 0);
    const out = players.filter(x => (absent || []).some(a => a.team === name && a.name === x.n));
    const lost = out.reduce((a, x) => a + x.v, 0);
    teams[name] = {
      G, hitWar: +hit.toFixed(2), pitWar: +pit.toFixed(2), wpg: (hit + pit) / G, lostPg: lost / G,
      out: out.map(x => ({ n: x.n, t: x.t, war: x.war, pg: +(x.v / G).toFixed(4), s: x.s })),
      top: players.slice().sort((a, b) => b.v - a.v).slice(0, 8).map(x => ({ n: x.n, t: x.t, war: x.war, s: x.s })),
      nPlayers: players.length
    };
  }
  const names = Object.keys(teams);
  const mean = names.reduce((a, t) => a + teams[t].wpg, 0) / names.length;
  let k = 1;
  if (pyth && names.every(t => pyth[t] != null)) {
    let sxy = 0, sxx = 0;
    for (const t of names) { const dx = teams[t].wpg - mean; sxy += dx * (pyth[t] - 0.5); sxx += dx * dx; }
    if (sxx > 0 && sxy > 0) k = sxy / sxx;
  }
  const full = {}, abs = {};
  for (const t of names) {
    const dx = teams[t].wpg - mean;
    full[t] = +((0.5 + k * dx) * (1 - REGRESS) + 0.5 * REGRESS).toFixed(4);
    abs[t] = +((0.5 + k * (dx - teams[t].lostPg)) * (1 - REGRESS) + 0.5 * REGRESS).toFixed(4);
    teams[t].wpg = +teams[t].wpg.toFixed(4); teams[t].lostPg = +teams[t].lostPg.toFixed(4);
  }
  return { v: 2, k: +k.toFixed(3), regress: REGRESS, full, abs, teams };
}

module.exports = { rosterStrength, TEAM_CODE };
