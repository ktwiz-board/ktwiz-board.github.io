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

async function games(from, to, size) {
  const u = `${API}/schedule/games?fields=basic,stadium,statusNum,homeStarterName,awayStarterName,winPitcherName,losePitcherName&upperCategoryId=kbaseball&categoryId=kbo&fromDate=${from}&toDate=${to}&size=${size || 200}`;
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

async function fetchYoutube() {
  try {
    const r = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=UCvScyjGkBUx2CJDMNAi9Twg', { headers: UA, signal: AbortSignal.timeout(15000) });
    const xml = await r.text();
    return xml.split('<entry>').slice(1, 9).map(e => {
      const id = (e.match(/<yt:videoId>([^<]+)</) || [])[1];
      const title = (e.match(/<media:title>([^<]+)</) || [])[1] || '';
      const pub = ((e.match(/<published>([^<]+)</) || [])[1] || '').slice(0, 10);
      return id ? { id, title, pub } : null;
    }).filter(Boolean).slice(0, 6);
  } catch (e) { console.error('youtube fail', e.message); return []; }
}

async function fetchShorts() {
  const shorts = [];
  try {
    const seen = new Set();
    for (const q of ['케이티위즈', 'kt위즈']) {
      const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIYAw%253D%253D', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9' },
        signal: AbortSignal.timeout(15000)
      });
      const html = await r.text();
      const re = /"reelWatchEndpoint":\{"videoId":"([a-zA-Z0-9_\-]{11})"/g;
      let m;
      while ((m = re.exec(html)) && shorts.length < 12) {
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        shorts.push({ id });
      }
    }
  } catch (e) { console.error('shorts fail', e.message); }
  return shorts;
}

// kt wiz 관련 뉴스 (구글 뉴스 RSS — 제목·링크·출처만 사용)
async function fetchNews() {
  try {
    const r = await fetch('https://news.google.com/rss/search?q=%22kt%20%EC%9C%84%EC%A6%88%22%20OR%20%22kt%20wiz%22&hl=ko&gl=KR&ceid=KR:ko', { headers: UA, signal: AbortSignal.timeout(15000) });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item><title>([^<]+)<\/title><link>([^<]+)<\/link><guid[^>]*>[^<]*<\/guid><pubDate>([^<]+)<\/pubDate>[\s\S]*?<source url="[^"]*">([^<]+)<\/source>/g)];
    const seen = new Set();
    return items.map(m => {
      const d = new Date(m[3]);
      return {
        title: m[1].replace(/ - [^-]+$/, '').trim(),
        url: m[2],
        src: m[4],
        date: isNaN(d) ? '' : new Date(d.getTime() + 9 * 3600000).toISOString().slice(5, 10).replace('-', '.'),
        ts: isNaN(d) ? 0 : d.getTime()
      };
    })
    .filter(n => { const k = n.title.slice(0, 24); if (seen.has(k)) return false; seen.add(k); return n.title.length > 8; })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 6);
  } catch (e) { console.error('news fail', e.message); return []; }
}

// 피타고라스 기대승률: 시즌 전 경기 스코어 집계 (지수 1.83)
const KBO_TEAMS = ['KT', 'LG', '삼성', '두산', 'KIA', '롯데', 'SSG', 'NC', '키움', '한화'];

// 구장 좌표 (이동거리 계산용 — 위경도는 지리적 사실)
const STADIUM_LL = {
  '수원': [37.2997, 127.0097], '잠실': [37.512, 127.072], '대구': [35.841, 128.6819],
  '대전': [36.3173, 127.4290], '사직': [35.1941, 129.0615], '고척': [37.498, 126.867],
  '창원': [35.2225, 128.5822], '광주': [35.1683, 126.8889], '문학': [37.437, 126.6933],
  '포항': [36.008, 129.359], '울산': [35.532, 129.265], '청주': [36.639, 127.470]
};
function haversineKm(a, b) {
  const R = 6371, d = Math.PI / 180;
  const dLat = (b[0] - a[0]) * d, dLon = (b[1] - a[1]) * d;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * d) * Math.cos(b[0] * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function stadiumKey(name) {
  return Object.keys(STADIUM_LL).find(k => (name || '').indexOf(k) === 0) || null;
}

async function pythagorean(today) {
  // 2026 정규시즌 개막일 = 3/28 (KBO 공식 팀순위 경기수와 전 구단 대조로 확정, 그 이전은 시범경기)
  const ranges = [['2026-03-28', '2026-04-30'], ['2026-05-01', '2026-06-30'], ['2026-07-01', today]];
  const agg = {}; // name -> {rs, ra, w, l, d}
  const h2h = {}; // name -> opp -> {w, l, d} (팀간 상대전적 — 같은 경기 수집을 재활용)
  const seq = {}; // name -> [{date, st}] 경기 구장 시퀀스 (이동거리용)
  for (const [f, t] of ranges) {
    if (f > today) break;
    const gs = await games(f, t, 500);
    for (const g of gs) {
      if (g.statusCode !== 'RESULT' && g.statusCode !== 'ENDED') continue;
      // 올스타전(나눔·드림)·시범경기 등 정규 10개 구단 매치가 아닌 경기 제외
      if (!KBO_TEAMS.includes(g.homeTeamName) || !KBO_TEAMS.includes(g.awayTeamName)) continue;
      const sk = stadiumKey(g.stadium);
      if (sk) {
        for (const nm of [g.homeTeamName, g.awayTeamName]) {
          if (!seq[nm]) seq[nm] = [];
          const last = seq[nm][seq[nm].length - 1];
          if (!last || last.st !== sk) seq[nm].push({ date: g.gameDate, st: sk }); // 같은 구장 연속(시리즈/DH)은 1회
        }
      }
      for (const [me, op, my, opsc] of [[g.homeTeamName, g.awayTeamName, g.homeTeamScore, g.awayTeamScore], [g.awayTeamName, g.homeTeamName, g.awayTeamScore, g.homeTeamScore]]) {
        if (!agg[me]) agg[me] = { rs: 0, ra: 0, w: 0, l: 0, d: 0 };
        agg[me].rs += my; agg[me].ra += opsc;
        if (!h2h[me]) h2h[me] = {};
        if (!h2h[me][op]) h2h[me][op] = { w: 0, l: 0, d: 0 };
        if (my > opsc) { agg[me].w++; h2h[me][op].w++; }
        else if (my < opsc) { agg[me].l++; h2h[me][op].l++; }
        else { agg[me].d++; h2h[me][op].d++; }
      }
    }
  }
  // 누적 이동거리: 홈구장 출발 → 경기 구장 시퀀스 직선거리 합 (자체 산식)
  const HOME_ST = { 'KT': '수원', 'LG': '잠실', '두산': '잠실', '삼성': '대구', 'KIA': '광주', '롯데': '사직', 'SSG': '문학', 'NC': '창원', '키움': '고척', '한화': '대전' };
  const travelTeams = [];
  for (const nm of KBO_TEAMS) {
    const s = seq[nm] || [];
    let km = 0, prevSt = HOME_ST[nm], moves = 0;
    for (const e of s) {
      if (e.st !== prevSt) {
        km += haversineKm(STADIUM_LL[prevSt], STADIUM_LL[e.st]);
        moves++;
        prevSt = e.st;
      }
    }
    travelTeams.push({ name: nm, km: Math.round(km), moves, last: prevSt });
  }
  travelTeams.sort((a, b) => b.km - a.km);
  const ktSeq = (seq['KT'] || []).slice(-6).map(e => e.st);

  const E = 1.83;
  return {
    date: today,
    v: 5,
    h2h,
    travel: { teams: travelTeams, ktSeq },
    teams: Object.entries(agg).map(([name, a]) => {
      const exp = Math.pow(a.rs, E) / (Math.pow(a.rs, E) + Math.pow(a.ra, E));
      const act = (a.w + a.l) > 0 ? a.w / (a.w + a.l) : 0;
      return { name, rs: a.rs, ra: a.ra, exp: +exp.toFixed(3), act: +act.toFixed(3), diff: +(act - exp).toFixed(3) };
    }).sort((x, y) => y.exp - x.exp)
  };
}

// 잔여 일정 난이도: 남은 상대들의 현재 승률 가중 평균 (자체 산식)
async function scheduleDifficulty(today, standings) {
  const wraMap = {};
  for (const t of standings) wraMap[t.name] = parseFloat(t.wra) || 0.5;
  const future = [
    ...(await games(today, '2026-08-31', 500)),
    ...(await games('2026-09-01', '2026-10-10', 500))
  ].filter(g => g.statusCode === 'BEFORE' && !g.cancel
    && KBO_TEAMS.includes(g.homeTeamName) && KBO_TEAMS.includes(g.awayTeamName));
  const acc = {};
  for (const g of future) {
    for (const [me, op] of [[g.homeTeamName, g.awayTeamName], [g.awayTeamName, g.homeTeamName]]) {
      if (!acc[me]) acc[me] = { n: 0, sum: 0 };
      acc[me].n++; acc[me].sum += (wraMap[op] != null ? wraMap[op] : 0.5);
    }
  }
  return {
    date: today, v: 1,
    teams: Object.entries(acc).map(([name, a]) => ({
      name, remaining: a.n, oppWra: +(a.sum / a.n).toFixed(3)
    })).sort((x, y) => x.oppWra - y.oppWra) // 쉬운 순
  };
}

(async () => {
  const now = kstNow();
  const today = ymd(now);

  // 이전 수집본 (모드 판단·부분 갱신용)
  const file = path.join(__dirname, '..', 'data', 'live.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}

  // 1) 오늘 경기
  const todayGames = (await games(today, today)).map(mapGame);

  // ---- 수집 모드 결정 ----
  // live: 진행 중 경기 있음 → 5분 주기 풀 수집
  // pre : 경기 전         → 10분 주기 풀 수집 (라인업 발표 감지)
  // post: 전 경기 종료 또는 경기 없는 날 → 하루 첫 스냅샷 후 유튜브·쇼츠만, 30분 주기
  const anyLive = todayGames.some(g => g.code === 'STARTED' || g.code === 'LIVE');
  const allDone = todayGames.length > 0 && todayGames.every(g => ['RESULT', 'ENDED', 'CANCEL'].includes(g.code));
  const noGames = todayGames.length === 0;
  const mode = anyLive ? 'live' : ((allDone || noGames) ? 'post' : 'pre');
  const SLEEP = { live: 300, pre: 600, post: 1800 };

  // post 모드 + 이전 파일이 이미 오늘의 종료 상태를 반영("post" 마킹) → 유튜브·쇼츠만 부분 갱신
  const prevIsCurrentSchema = prev && prev.pythag && prev.pythag.v === 5 && prev.sched;
  if (mode === 'post' && prev && prev.mode === 'post' && prev.date === today && prevIsCurrentSchema) {
    const [yt2, sh2, nw2] = await Promise.all([fetchYoutube(), fetchShorts(), fetchNews()]);
    if (yt2.length) prev.youtube = yt2;
    if (sh2.length) prev.shorts = sh2;
    if (nw2.length) prev.news = nw2;
    prev.updated = new Date().toISOString();
    prev.updatedKST = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    fs.writeFileSync(file, JSON.stringify(prev, null, 1));
    console.log(`ok(post-partial): yt=${yt2.length} shorts=${sh2.length} news=${nw2.length}`);
    console.log(`SLEEP=${SLEEP.post}`);
    return;
  }

  // 2) 순위표: 오늘 경기들의 preview에서 양팀 standings 수집 (10팀 커버)
  const standings = {};
  let ktLineup = null, oppLineup = null, ktGameId = null, ktTop = null, ktStarters = null;
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
        // 오늘 선발 맞대결: 구종 구성·구속 (통계 수치만 사용)
        const mapStarter = (s) => s && s.playerInfo ? {
          name: s.playerInfo.name,
          era: (s.currentSeasonStats || {}).era,
          w: (s.currentSeasonStats || {}).w, l: (s.currentSeasonStats || {}).l,
          pitches: (s.currentPitKindStats || []).map(p => ({ type: p.type, rt: p.pit_rt, spd: p.speed }))
        } : null;
        ktStarters = {
          kt: mapStarter(g.home === 'KT' ? pd.homeStarter : pd.awayStarter),
          opp: mapStarter(g.home === 'KT' ? pd.awayStarter : pd.homeStarter),
          oppName: g.home === 'KT' ? g.away : g.home
        };
        // 오늘의 키플레이어 (네이버 프리뷰 선정) — 스포트라이트 자동 교체용
        const tp = g.home === 'KT' ? pd.homeTopPlayer : pd.awayTopPlayer;
        if (tp && tp.playerInfo) {
          const st = tp.currentSeasonStats || {};
          const r5 = tp.recentFiveGamesStats || {};
          ktTop = {
            name: tp.playerInfo.name, backnum: tp.playerInfo.backnum, hitType: tp.playerInfo.hitType,
            opp: g.home === 'KT' ? g.away : g.home,
            hra: st.hra, hr: st.hr, rbi: st.rbi, obp: st.obp, games: st.gameCount,
            r5hra: r5.hra, r5hit: r5.hit, r5ab: r5.ab
          };
        }
      }
    } catch (e) { console.error('preview fail', g.id, e.message); }
  }

  // 2.5) KT 경기 박스스코어 (선수 기록 — 경기 중/종료 시)
  let box = null;
  if (ktGameId) {
    try {
      const rec = await j(`${API}/schedule/games/${ktGameId}/record`);
      const rd = rec.result && rec.result.recordData;
      const g = todayGames.find(x => x.id === ktGameId);
      if (rd && rd.battersBoxscore && g) {
        const side = g.home === 'KT' ? 'home' : 'away';
        const opSide = side === 'home' ? 'away' : 'home';
        const mapBat = b => ({ o: b.batOrder, name: b.name, pos: b.pos, ab: b.ab, h: b.hit, rbi: b.rbi, r: b.run, hr: b.hr, bb: b.bb, kk: b.kk, avg: b.hra });
        const mapPit = p => ({ name: p.name, inn: p.inn, h: p.hit, r: p.r, er: p.er, bb: p.bb, kk: p.kk, era: p.era, wls: p.wls || '' });
        box = {
          rheb: rd.scoreBoard && rd.scoreBoard.rheb,
          inn: rd.scoreBoard && rd.scoreBoard.inn,
          ktSide: side,
          batters: (rd.battersBoxscore[side] || []).map(mapBat),
          batTotal: rd.battersBoxscore[side + 'Total'] || null,
          pitchers: (rd.pitchersBoxscore[side] || []).map(mapPit),
          oppPitchers: (rd.pitchersBoxscore[opSide] || []).map(mapPit),
          keys: (rd.etcRecords || []).slice(0, 8).map(e => ({ how: e.how, result: e.result }))
        };
      }
    } catch (e) { console.error('record fail', e.message); }
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

  // 4.5) 지난 경기(오늘 이전 가장 최근 종료 경기) 상세
  let lastGame = null;
  const prevDone = (await games(ymd(addDays(now, -12)), ymd(addDays(now, -1))))
    .map(mapGame)
    .filter(g => (g.home === 'KT' || g.away === 'KT') && (g.code === 'RESULT' || g.code === 'ENDED'));
  const lg = prevDone[prevDone.length - 1];
  if (lg) {
    const ktHome = lg.home === 'KT';
    lastGame = {
      date: lg.date, stadium: lg.stadium, opp: ktHome ? lg.away : lg.home, ktHome,
      my: ktHome ? lg.hs : lg.as, op: ktHome ? lg.as : lg.hs,
      as: lg.as, hs: lg.hs, away: lg.away, home: lg.home,
      starter: ktHome ? lg.hp : lg.ap, keys: [], pitchers: []
    };
    lastGame.r = lastGame.my > lastGame.op ? 'W' : (lastGame.my < lastGame.op ? 'L' : 'D');
    try {
      const rec = await j(`${API}/schedule/games/${lg.id}/record`);
      const rd = rec.result && rec.result.recordData;
      if (rd) {
        const side = ktHome ? 'home' : 'away';
        const mapPit = p => ({ name: p.name, inn: p.inn, h: p.hit, r: p.r, er: p.er, kk: p.kk, wls: p.wls || '' });
        lastGame.keys = (rd.etcRecords || []).slice(0, 6).map(e => ({ how: e.how, result: e.result }));
        lastGame.pitchers = ((rd.pitchersBoxscore && rd.pitchersBoxscore[side]) || []).map(mapPit)
          .filter(p => p.wls || p.inn); // 선발/승패/세이브 위주
      }
    } catch (e) { console.error('lastGame record fail', e.message); }
  }

  // 4.7) 관련 뉴스
  const news = await fetchNews();

  // 5) kt wiz 공식 유튜브 최신 영상 (RSS)
  const youtube = await fetchYoutube();

  // 5.5) kt위즈/케이티위즈 유튜브 쇼츠 검색
  const shorts = await fetchShorts();

  // 6) kt위즈 갤러리 최신 글 (욕설/공지 필터) — 차단 시 빈 배열
  let gall = [];
  try {
    const r = await fetch('https://gall.dcinside.com/board/lists?id=ktwiz', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9' },
      signal: AbortSignal.timeout(15000)
    });
    const html = await r.text();
    const bad = /(씨발|시발|씨빨|병신|븅신|지랄|좆|졷|개새|새끼|썅|엠창|염병|느금|니미|닥쳐|꺼져|미친놈|미친년|호로|걸레|한남|김치녀)/;
    const rows = [...html.matchAll(/<tr[^>]*data-no="(\d+)"[\s\S]*?class="gall_tit[^"]*"[^>]*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="gall_date"[^>]*(?:title="([^"]*)")?[^>]*>([^<]*)</g)];
    gall = rows.map(m => ({
      no: m[1],
      url: 'https://gall.dcinside.com' + m[2].replace(/&amp;/g, '&'),
      title: m[3].replace(/<[^>]+>/g, '').trim(),
      date: (m[5] || '').trim()
    }))
    .filter(p => p.title && !bad.test(p.title) && !/공지|설문|이벤트 안내|일정표|이용 안내/.test(p.title))
    .slice(0, 8);
    // 봇 차단으로 축소 페이지(공지만)를 받은 경우 → 빈 배열 (페이지는 바로가기 링크 폴백)
    if (gall.length < 3) gall = [];
  } catch (e) { console.error('gall fail', e.message); }

  // 7) 피타고라스 기대승률 — 하루 1회(이전 데이터가 오늘자면 재사용), 실패 시 이전 값 유지
  const prevPyValid = prev && prev.pythag && prev.pythag.date === today
    && prev.pythag.v === 5
    && prev.pythag.teams && prev.pythag.teams.length === 10
    && prev.pythag.teams.every(t => KBO_TEAMS.includes(t.name));
  let pythag = prevPyValid ? prev.pythag : null;
  if (!pythag) {
    try { pythag = await pythagorean(today); } catch (e) { console.error('pythag fail', e.message); pythag = (prev && prev.pythag) || null; }
  }

  // 7.5) 잔여 일정 난이도 — 하루 1회 (순위 확정 후 계산)
  const stForSched = Object.keys(standings).length >= 10
    ? Object.values(standings) : ((prev && prev.standings) || []);
  let sched = (prev && prev.sched && prev.sched.date === today && prev.sched.v === 1) ? prev.sched : null;
  if (!sched && stForSched.length >= 10) {
    try { sched = await scheduleDifficulty(today, stForSched); }
    catch (e) { console.error('sched fail', e.message); sched = (prev && prev.sched) || null; }
  }
  if (!sched) sched = (prev && prev.sched) || null;

  const out = {
    updated: new Date().toISOString(),
    updatedKST: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`,
    date: today,
    mode,
    games: todayGames,
    // 경기 없는 날엔 preview가 없어 순위를 못 구함 → 직전 순위 유지
    standings: Object.keys(standings).length >= 10
      ? Object.values(standings).sort((a, b) => a.rank - b.rank)
      : ((prev && prev.standings) || Object.values(standings).sort((a, b) => a.rank - b.rank)),
    kt: {
      gameId: ktGameId, lineup: ktLineup, oppLineup, week, recent, box, lastGame,
      // 경기 없는 날엔 프리뷰가 없어 키플레이어를 못 구함 → 직전 값 유지
      top: ktTop || (prev && prev.kt && prev.kt.top) || null,
      starters: ktStarters || (prev && prev.kt && prev.kt.starters) || null
    },
    news: news.length ? news : ((prev && prev.news) || []),
    youtube, shorts, gall, pythag, sched
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 1));

  // 8) 순위 히스토리 스냅샷 — 하루 1개, 최대 90일 보관 (시즌 순위 변동 그래프용)
  try {
    if (out.standings.length >= 10) {
      const histFile = path.join(__dirname, '..', 'data', 'standings-history.json');
      let hist = [];
      try { hist = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch (e) {}
      if (!hist.length || hist[hist.length - 1].date !== today) {
        hist.push({ date: today, teams: out.standings.map(t => ({ name: t.name, rank: t.rank, w: t.w, l: t.l, d: t.d })) });
        if (hist.length > 90) hist = hist.slice(-90);
        fs.writeFileSync(histFile, JSON.stringify(hist));
      }
    }
  } catch (e) { console.error('history snapshot fail', e.message); }

  console.log(`ok(${mode}): ${todayGames.length} games, ${out.standings.length} teams, lineup=${!!ktLineup}, pythag=${!!pythag}`);
  console.log(`SLEEP=${SLEEP[mode]}`);
})().catch(e => { console.error(e); process.exit(1); });
