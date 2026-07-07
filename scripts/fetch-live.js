// KBO 라이브 데이터 수집 — GitHub Actions에서 5분마다 실행되어 data/live.json 생성
// 소스: 네이버 스포츠 공개 API (서버사이드라 CORS 무관)
const fs = require('fs');
const path = require('path');

const UA = { 'User-Agent': 'Mozilla/5.0 (ktwiz-board live fetcher)' };
const API = 'https://api-gw.sports.naver.com';

function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000); // UTC+9, use UTC getters below
}
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

async function j(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function games(from, to) {
  const u = `${API}/schedule/games?fields=basic,stadium,statusNum,homeStarterName,awayStarterName,winPitcherName,losePitcherName&upperCategoryId=kbaseball&categoryId=kbo&fromDate=${from}&toDate=${to}&size=200`;
  const d = await j(u);
  return (d.result && d.result.games) || [];
}

function mapGame(g) {
  return {
    id: g.gameId,
    date: g.gameDate,
    time: (g.gameDateTime || '').slice(11, 16),
    stadium: g.stadium,
    away: g.awayTeamName, home: g.homeTeamName,
    as: g.awayTeamScore, hs: g.homeTeamScore,
    status: g.cancel ? '취소' : g.statusInfo,
    code: g.cancel ? 'CANCEL' : g.statusCode,
    ap: g.awayStarterName || '', hp: g.homeStarterName || '',
    wp: g.winPitcherName || '', lp: g.losePitcherName || ''
  };
}

function mapLineup(lu) {
  if (!lu || !lu.fullLineUp || lu.fullLineUp.length < 9) return null;
  const starter = lu.fullLineUp.find(p => p.positionName === '선발투수');
  const batters = lu.fullLineUp
    .filter(p => +p.batorder > 0)
    .sort((a, b) => +a.batorder - +b.batorder)
    .map(p => ({ o: +p.batorder, name: p.playerName, pos: p.positionName }));
  if (batters.length < 9) return null;
  return { starter: starter ? starter.playerName : '', batters };
}

(async () => {
  const now = kstNow();
  const today = ymd(now);

  // 1) 오늘 경기
  const todayGames = (await games(today, today)).map(mapGame);

  // 2) 순위표: 오늘 경기들의 preview에서 양팀 standings 수집 (10팀 커버)
  const standings = {};
  let ktLineup = null, oppLineup = null, ktGameId = null;
  for (const g of todayGames) {
    try {
      const p = await j(`${API}/schedule/games/${g.id}/preview`);
      const pd = p.result && p.result.previewData;
      if (!pd) continue;
      for (const s of [pd.homeStandings, pd.awayStandings]) {
        if (s && s.name) standings[s.name] = {
          name: s.name, rank: s.rank, w: s.w, l: s.l, d: s.d,
          wra: s.wra, era: s.era, hra: s.hra, hr: s.hr
        };
      }
      // KT 라인업 (발표 시 fullLineUp에 타자 9명 포함)
      if (g.home === 'KT' || g.away === 'KT') {
        ktGameId = g.id;
        const ktSide = g.home === 'KT' ? 'homeTeamLineUp' : 'awayTeamLineUp';
        const opSide = g.home === 'KT' ? 'awayTeamLineUp' : 'homeTeamLineUp';
        ktLineup = mapLineup(pd[ktSide]);
        oppLineup = mapLineup(pd[opSide]);
      }
    } catch (e) { console.error('preview fail', g.id, e.message); }
  }

  // 3) KT 주간 일정 (오늘 ~ +7일)
  const week = (await games(today, ymd(addDays(now, 7))))
    .map(mapGame)
    .filter(g => g.home === 'KT' || g.away === 'KT');

  // 4) KT 최근 결과 (지난 12일, 종료 경기 최근 5)
  const recent = (await games(ymd(addDays(now, -12)), ymd(addDays(now, -1))))
    .map(mapGame)
    .filter(g => (g.home === 'KT' || g.away === 'KT') && (g.code === 'RESULT' || g.code === 'ENDED'))
    .slice(-5)
    .map(g => {
      const ktHome = g.home === 'KT';
      const my = ktHome ? g.hs : g.as, op = ktHome ? g.as : g.hs;
      return { ...g, opp: ktHome ? g.away : g.home, my, op, r: my > op ? 'W' : (my < op ? 'L' : 'D') };
    });

  const out = {
    updated: new Date().toISOString(),
    updatedKST: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`,
    date: today,
    games: todayGames,
    standings: Object.values(standings).sort((a, b) => a.rank - b.rank),
    kt: { gameId: ktGameId, lineup: ktLineup, oppLineup, week, recent }
  };

  const file = path.join(__dirname, '..', 'data', 'live.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`ok: ${todayGames.length} games, ${out.standings.length} teams, lineup=${!!ktLineup}, week=${week.length}, recent=${recent.length}`);
})().catch(e => { console.error(e); process.exit(1); });
