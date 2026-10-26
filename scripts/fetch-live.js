// KBO 라이브 데이터 수집 — GitHub Actions에서 5분마다 실행되어 data/live.json 생성
// 소스: 네이버 스포츠 공개 API (서버사이드라 CORS 무관)
const fs = require('fs');
const path = require('path');

const UA = { 'User-Agent': 'Mozilla/5.0 (ktwiz-board live fetcher)' };
const { fetchTeam, TEAM_CODE } = require('./roster');
const PSModel = require('./psmodel');   // 포스트시즌 우승 확률 머신 (화면과 같은 파일)
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

// 2026 정규시즌 개막일 = 3/28 (KBO 공식 팀순위 경기수와 전 구단 대조로 확정, 그 이전은 시범경기)
const SEASON_START = '2026-03-28';
const SEASON_END = '2026-10-31';
// 포스트시즌 — 네이버 gameId 앞 4자리가 라운드 코드 (2025 시즌 실데이터로 확인)
const PS_FROM = '2026-09-20';
const PS_END = '2026-11-20';
const PS_ROUND = { '4444': 'WC', '3333': 'SPO', '5555': 'PO', '7777': 'KS' };
const isPs = id => !!PS_ROUND[String(id || '').slice(0, 4)];

// [from,to] 구간을 chunkDays 단위로 잘라 반환.
// 일정 조회 범위를 날짜 상수로 박아두면 시즌이 진행되며 from > to 로 역전돼 API가 400을 내고
// (2026-09-01 이후 실제로 발생) 계산 전체가 실패하므로, 항상 오늘 기준으로 구간을 만든다.
function dateRanges(from, to, chunkDays) {
  const out = [];
  const end = new Date(to + 'T00:00:00Z').getTime();
  let s = new Date(from + 'T00:00:00Z').getTime();
  while (s <= end) {
    const e = Math.min(s + (chunkDays - 1) * 86400000, end);
    out.push([ymd(new Date(s)), ymd(new Date(e))]);
    s = e + 86400000;
  }
  return out;
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

// KBO 공식 일정 — 취소 경기 목록(폭염취소·우천취소 등 사유 포함). 네이버 API는 cancel 여부만 주고 사유가 없음.
// 반환: [{ date, away, home, stadium, reason }]
async function fetchCancelledList(yearMonths) {
  const out = [];
  for (const ym of yearMonths) {
    const [season, month] = ym.split('-');
    const r = await fetch('https://www.koreabaseball.com/ws/Schedule.asmx/GetScheduleList', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        'Referer': 'https://www.koreabaseball.com/Schedule/Schedule.aspx',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: `leId=1&srIdList=0%2C9%2C6&seasonId=${season}&gameMonth=${month}&teamId=`,
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) continue;
    const d = await r.json();
    let curDate = null;
    for (const row of d.rows || []) {
      let cells = row.row || [];
      if (cells[0] && cells[0].Class === 'day') {
        const m = (cells[0].Text || '').match(/(\d{2})\.(\d{2})/);
        if (m) curDate = `${season}-${m[1]}-${m[2]}`;
        cells = cells.slice(1);
      }
      if (!curDate || cells.length < 2) continue;
      const play = cells.find(c => c.Class === 'play');
      const remark = (cells[cells.length - 1].Text || '').replace(/<[^>]+>/g, '').trim();
      if (!play || !remark.includes('취소')) continue;
      const txt = (play.Text || '').replace(/<em>[\s\S]*?<\/em>/, '|');
      const [awayRaw, homeRaw] = txt.split('|');
      const clean = s => (s || '').replace(/<[^>]+>/g, '').replace(/\d+/g, '').trim();
      const away = clean(awayRaw), home = clean(homeRaw);
      const stadium = cells.length >= 2 ? (cells[cells.length - 2].Text || '').replace(/<[^>]+>/g, '').trim() : '';
      if (away && home) out.push({ date: curDate, away, home, stadium, reason: remark });
    }
  }
  return out;
}

// KBO 공식 메인 개인 기록 랭킹 (타자: 타율·홈런·타점 / 투수: 평균자책·다승·탈삼진, 각 TOP3) — 수치 텍스트만 사용
async function fetchTitleRace() {
  const H = {
    'Content-Type': 'application/json; charset=UTF-8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    'Referer': 'https://www.koreabaseball.com/',
    'X-Requested-With': 'XMLHttpRequest'
  };
  const get = async (ep, cats) => {
    const r = await fetch('https://www.koreabaseball.com/ws/Main.asmx/' + ep, { method: 'POST', headers: H, body: '{}', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const t = await r.text();
    const cut = t.indexOf('<!DOCTYPE'); // 응답 뒤에 에러 HTML이 붙는 경우 대비
    const tb = JSON.parse(JSON.parse(t.slice(0, cut > 0 ? cut : t.length)).table);
    const out = cats.map(c => ({ cat: c, top: [] }));
    for (const row of tb.rows || []) {
      const cells = row.row.map(c => c.Text.replace(/<[^>]+>/g, '').trim());
      for (let k = 0; k < 3; k++) {
        const rank = parseInt(cells[k * 2]) || 0;
        const m = (cells[k * 2 + 1] || '').match(/^(.+?)\(([^)]+)\)([\d.]+)$/);
        if (m) out[k].top.push({ rank, name: m[1], team: m[2], val: m[3] });
      }
    }
    return out.every(c => c.top.length >= 3) ? out : null;
  };
  try {
    const h = await get('GetHitterRank', ['타율', '홈런', '타점']);
    const p = await get('GetPitcherRank', ['평균자책', '다승', '탈삼진']);
    return (h && p) ? [...h, ...p] : null;
  } catch (e) { console.error('title race fail', e.message); return null; }
}

async function fetchYoutube() {
  try {
    const r = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=UCvScyjGkBUx2CJDMNAi9Twg', { headers: UA, signal: AbortSignal.timeout(15000) });
    const xml = await r.text();
    const vids = xml.split('<entry>').slice(1, 9).map(e => {
      const id = (e.match(/<yt:videoId>([^<]+)</) || [])[1];
      const title = (e.match(/<media:title>([^<]+)</) || [])[1] || '';
      const pub = ((e.match(/<published>([^<]+)</) || [])[1] || '').slice(0, 10);
      return id ? { id, title, pub } : null;
    }).filter(Boolean);
    return (await filterAliveVideos(vids)).slice(0, 6);
  } catch (e) { console.error('youtube fail', e.message); return []; }
}

// 비공개·삭제 영상 제거 — oembed가 비공개=401, 삭제=404를 정확히 반환
// (썸네일 URL은 비공개 영상도 200 + 회색 대체 이미지가 와서 검증 불가)
async function filterAliveVideos(list) {
  try {
    const alive = await Promise.all(list.map(async v => {
      try {
        const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${v.id}&format=json`,
          { headers: UA, signal: AbortSignal.timeout(8000) });
        return (r.status === 401 || r.status === 403 || r.status === 404) ? null : v;
      } catch (e) { return v; } // 네트워크 오류·타임아웃은 판단 불가 → 유지
    }));
    return alive.filter(Boolean);
  } catch (e) { return list; }
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

// 피타고리안 기대승률: 시즌 전 경기 스코어 집계 (지수 1.83)
const KBO_TEAMS = ['KT', 'LG', '삼성', '두산', 'KIA', '롯데', 'SSG', 'NC', '키움', '한화'];

// 아시안게임 야구 (네이버 categoryId=agbaseball) — 대회 기간에만 수집. 한국 경기만 추린다.
const AG_FROM = '2026-09-20', AG_TO = '2026-09-27';
const AG_LEAVE = '2026-09-14'; // 대표팀 소집일 (선수 공백 시작)
// 선수별 공백 영향 보정값 — tools/predictor에서 `node tools/predictor/predict.js ag --write`로 생성
function agAdjust() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'predictor', 'ag-impact.json'), 'utf8')); }
  catch (e) { return null; }
}
async function asianGames(today) {
  if (today < AG_FROM || today > AG_TO) return null;
  const u = `${API}/schedule/games?fields=basic,stadium,statusNum,homeStarterName,awayStarterName,winPitcherName,losePitcherName&upperCategoryId=kbaseball&categoryId=agbaseball&fromDate=${AG_FROM}&toDate=${AG_TO}&size=100`;
  const d = await j(u);
  const games = ((d.result && d.result.games) || [])
    .filter(g => g.homeTeamName === '대한민국' || g.awayTeamName === '대한민국')
    .map(g => { // gameId 예: 88880925S2S402026 — 9~10번째 글자 S?=슈퍼라운드, F1·F3=금·동메달 결정전
      const id = String(g.gameId), c = id.slice(8, 10);
      const round = c[0] === 'S' ? '슈퍼라운드' : c === 'F1' ? '금메달 결정전' : c === 'F3' ? '동메달 결정전' : '오프닝 라운드'; // 오프닝 라운드는 팀코드(예: TWKR)
      return Object.assign(mapGame(g), { round });
    })
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { date: today, games };
}

// 포스트시즌 라운드별 경기·시리즈 전적. 대진·확률 계산은 화면 쪽에서(정규시즌 최종 순위와 결합)
async function postseason() {
  const raw = [];
  for (const [f, t] of dateRanges(PS_FROM, PS_END, 60)) raw.push(...(await games(f, t, 500)));
  const rounds = {};
  for (const g of raw) {
    const code = PS_ROUND[String(g.gameId).slice(0, 4)];
    if (!code) continue;
    const r = rounds[code] || (rounds[code] = { code, teams: [], wins: {}, games: [] });
    for (const nm of [g.awayTeamName, g.homeTeamName]) {
      if (!r.teams.includes(nm)) { r.teams.push(nm); r.wins[nm] = 0; }
    }
    const m = mapGame(g);
    if (!g.cancel && g.statusCode === 'RESULT') {
      if (g.awayTeamScore > g.homeTeamScore) r.wins[g.awayTeamName]++;
      else if (g.homeTeamScore > g.awayTeamScore) r.wins[g.homeTeamName]++;
      else m.tie = true;
    }
    r.games.push(m);
  }
  for (const r of Object.values(rounds)) r.games.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { v: 1, rounds };
}

async function pythagorean(today) {
  const ranges = dateRanges(SEASON_START, today, 60);
  const agg = {}; // name -> {rs, ra, w, l, d}
  const h2h = {}; // name -> opp -> {w, l, d} (팀간 상대전적 — 같은 경기 수집을 재활용)
  const log = {}; // name -> [{t, my, op}] 최근 폼(최근 60경기) 계산용
  for (const [f, t] of ranges) {
    if (f > today) break;
    const gs = await games(f, t, 500);
    for (const g of gs) {
      if (g.statusCode !== 'RESULT' && g.statusCode !== 'ENDED') continue;
      // 올스타전(나눔·드림)·시범경기 등 정규 10개 구단 매치가 아닌 경기 제외
      if (!KBO_TEAMS.includes(g.homeTeamName) || !KBO_TEAMS.includes(g.awayTeamName)) continue;
      if (isPs(g.gameId)) continue; // 포스트시즌은 정규시즌 집계에서 제외
      for (const [me, op, my, opsc] of [[g.homeTeamName, g.awayTeamName, g.homeTeamScore, g.awayTeamScore], [g.awayTeamName, g.homeTeamName, g.awayTeamScore, g.homeTeamScore]]) {
        if (!agg[me]) agg[me] = { rs: 0, ra: 0, w: 0, l: 0, d: 0 };
        agg[me].rs += my; agg[me].ra += opsc;
        (log[me] = log[me] || []).push({ t: g.gameDateTime || g.gameDate, d: g.gameDate, my, op: opsc });
        if (!h2h[me]) h2h[me] = {};
        if (!h2h[me][op]) h2h[me][op] = { w: 0, l: 0, d: 0 };
        if (my > opsc) { agg[me].w++; h2h[me][op].w++; }
        else if (my < opsc) { agg[me].l++; h2h[me][op].l++; }
        else { agg[me].d++; h2h[me][op].d++; }
      }
    }
  }
  const E = 1.83;
  return {
    date: today,
    v: 9,
    h2h,
    teams: Object.entries(agg).map(([name, a]) => {
      const exp = Math.pow(a.rs, E) / (Math.pow(a.rs, E) + Math.pow(a.ra, E));
      const act = (a.w + a.l) > 0 ? a.w / (a.w + a.l) : 0;
      // 최근 60경기 폼 (경기차 전망 시뮬레이션용) — 30·45·60경기 창 백테스트에서 60경기가 가장 정확(tools/predictor)
      const last = (log[name] || []).sort((x, y) => x.t < y.t ? -1 : x.t > y.t ? 1 : 0).slice(-60);
      const f60 = { n: last.length, w: 0, l: 0, d: 0, rs: 0, ra: 0 };
      for (const x of last) { f60.rs += x.my; f60.ra += x.op; f60[x.my > x.op ? 'w' : x.my < x.op ? 'l' : 'd']++; }
      // 아시안게임 차출 기간(AG_LEAVE~)에 치른 경기 수 — 화면에서 시즌 성적에 섞인 공백 몫을 되돌리는 데 사용
      const agN = (log[name] || []).filter(x => x.d >= AG_LEAVE).length;
      return { name, rs: a.rs, ra: a.ra, exp: +exp.toFixed(3), act: +act.toFixed(3), diff: +(act - exp).toFixed(3), f60, agN };
    }).sort((x, y) => y.exp - x.exp)
  };
}

/* ==========================================================================
   가을야구 — 오늘의 경기(포커스) · 가을 개인 기록 · 우승 확률 머신 입력/결과
   ========================================================================== */
const isDone = g => g && (g.code === 'RESULT' || g.code === 'ENDED');
const isLiveG = g => g && (g.code === 'STARTED' || g.code === 'LIVE');
const psGamesOf = ps => {
  const out = [];
  for (const [round, r] of Object.entries((ps && ps.rounds) || {})) for (const g of r.games || []) out.push(Object.assign({ round }, g));   // g.code는 경기 상태
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
};

// 오늘 보여줄 경기: 오늘의 가을야구 경기(진행 중 > 예정 > 종료) → 오늘 KT 경기 → 가장 최근에 끝난 가을야구 경기
function pickFocus(todayGames, ps) {
  const pool = todayGames.filter(g => isPs(g.id));
  const kt = todayGames.filter(g => g.home === 'KT' || g.away === 'KT');
  const from = pool.length ? pool : kt;
  const g = from.find(isLiveG) || from.find(x => !isDone(x) && x.code !== 'CANCEL') || from[from.length - 1];
  if (g) return g;
  const fin = psGamesOf(ps).filter(isDone);
  return fin[fin.length - 1] || null;
}

// 문자중계: 득점 순간(홈인·홈런) · 지금 상황(볼카운트·아웃·주자·타자/투수)
// (투구수는 기록 API의 bf가 정확해서 그걸 쓴다 — 문자중계로 세면 중립 경기에서 양 팀 투수가 섞였다)
// 네이버 relay API는 inning 파라미터로 그 이닝 전체(초+말)를 최신순으로 묶어 주므로, 시간순으로 뒤집어
// "N회초/말 OOO 공격" 마커를 지날 때마다 공격팀을 바꾸는 상태기계로 읽는다. 끝난 이닝은 캐시해 다시 받지 않는다.
async function relayLog(gameId, g, prevLog, box) {
  const base = await j(`${API}/schedule/games/${gameId}/relay`);
  const rd = base.result && base.result.textRelayData;
  if (!rd || !rd.inningScore) return null;
  const names = {};   // pcode → 이름 (라인업 + 박스스코어)
  for (const side of ['homeLineup', 'awayLineup', 'homeEntry', 'awayEntry']) {
    const s = rd[side] || {};
    [...(s.batter || []), ...(s.pitcher || [])].forEach(p => { if (p.pcode) names[p.pcode] = p.name; });
  }
  [...((box && box.pitchers && box.pitchers.away) || []), ...((box && box.pitchers && box.pitchers.home) || [])].forEach(p => { if (p.pcode) names[p.pcode] = p.name; });
  const doneFull = new Set((prevLog && prevLog.doneFull) || []);
  const byInning = Object.assign({}, (prevLog && prevLog.events) || {});
  const finished = isDone(g);
  let lastState = null;
  for (let n = 1; n <= 15; n++) {
    const a = rd.inningScore.away && rd.inningScore.away[n];
    const h = rd.inningScore.home && rd.inningScore.home[n];
    if (a == null || a === '-') continue;
    if (doneFull.has(n)) continue;
    try {
      const rr = await j(`${API}/schedule/games/${gameId}/relay?inning=${n}`);
      const trd = rr.result && rr.result.textRelayData;
      const list = ((trd && trd.textRelays) || []).slice().reverse();
      const evs = [];
      let curTeam = null, curHalf = null;
      for (const e of list) {
        const first = e.textOptions && e.textOptions[0];
        if (first && first.type === 0) {
          const m = (first.text || '').match(/^(\d+)회(초|말)\s*(.+?)\s*공격/);
          if (m) { curHalf = m[2]; curTeam = m[3]; }
          continue;
        }
        for (const o of (e.textOptions || [])) {
          const cgsState = o.currentGameState;
          if (cgsState) lastState = Object.assign({ inn: n, half: curHalf }, cgsState);
          if (o.type === 24 && /홈인/.test(o.text || '')) {
            const scorer = (o.text.match(/^(.+?)\s*[:：]\s*홈인/) || [])[1] || '';
            const hitLine = (e.textOptions || []).find(x => x.type === 13 || x.type === 23);
            const how = hitLine ? hitLine.text.replace(/^[^:：]+[:：]\s*/, '') : '';
            evs.push({ inn: n, half: curHalf || '?', team: curTeam || '', scorer, how, batter: (e.title || '').replace(/^\d+번타자\s*/, '') });
          }
        }
        // 홈런은 주자 이동("홈인") 없이 타자가 직접 득점하므로 따로 기록 — 안 하면 홈런 득점이 빠진다
        const batterName = (e.title || '').replace(/^\d+번타자\s*/, '');
        const homerLine = (e.textOptions || []).find(x => (x.type === 13 || x.type === 23) && /홈런/.test(x.text || ''));
        if (homerLine) evs.push({ inn: n, half: curHalf || '?', team: curTeam || '', scorer: batterName, how: homerLine.text.replace(/^[^:：]+[:：]\s*/, ''), batter: batterName });
      }
      byInning[n] = evs;
      if (finished || (h != null && h !== '-')) doneFull.add(n);
    } catch (e) { console.error('relay fail', n, e.message); }
  }
  // 지금 상황 (경기 중일 때만) — 기본 relay 응답의 최신 상태가 가장 정확
  let state = null;
  const cur = rd.currentGameState || (lastState || null);
  if (isLiveG(g) && cur) {
    const m = String(g.status || '').match(/(\d+)회(초|말)/);
    state = {
      inn: m ? +m[1] : (lastState && lastState.inn) || null, half: m ? m[2] : (lastState && lastState.half) || null,
      out: +cur.out || 0, b: +cur.ball || 0, s: +cur.strike || 0,
      bases: [cur.base1, cur.base2, cur.base3].map(x => x != null && String(x) !== '0' && x !== ''),
      pitcher: names[cur.pitcher] || '', batter: names[cur.batter] || ''
    };
  }
  return { log: { gameId, doneFull: [...doneFull], events: byInning }, state };
}

const mapStarter = s => s && s.playerInfo ? {
  name: s.playerInfo.name,
  era: (s.currentSeasonStats || {}).era, w: (s.currentSeasonStats || {}).w, l: (s.currentSeasonStats || {}).l,
  pitches: (s.currentPitKindStats || []).map(p => ({ type: p.type, rt: p.pit_rt, spd: p.speed }))
} : null;
const mapBat = b => ({ o: b.batOrder, name: b.name, pos: b.pos, ab: b.ab, h: b.hit, rbi: b.rbi, r: b.run, hr: b.hr, bb: b.bb, kk: b.kk, sb: b.sb || 0, avg: b.hra });
const mapPit = p => ({ name: p.name, pcode: p.pcode, inn: p.inn, h: p.hit, r: p.r, er: p.er, bb: p.bb, kk: p.kk, hr: p.hr || 0, bf: p.bf, era: p.era, wls: p.wls || '' });
const firstNine = bats => {   // 선발 타순: 1~9번 각 첫 선수
  const seen = new Set();
  return (bats || []).filter(b => { const o = +b.batOrder || +b.o; if (!(o >= 1 && o <= 9) || seen.has(o)) return false; seen.add(o); return true; })
    .sort((a, b) => (+a.batOrder || +a.o) - (+b.batOrder || +b.o)).map(b => ({ o: +b.batOrder || +b.o, name: b.name, pos: b.pos }));
};

// 포커스 경기 상세: 라인업·선발 구종(프리뷰) + 라인스코어·박스스코어(기록) + 득점 로그·투구수·현재 상황(문자중계)
async function focusGame(g, prevF) {
  if (!g) return null;
  const code = PS_ROUND[String(g.id).slice(0, 4)] || null;
  const cached = prevF && prevF.id === g.id ? prevF : null;
  if (cached && cached.final && isDone(g)) return cached;   // 끝난 경기는 한 번 완성되면 다시 받지 않음
  const f = Object.assign({}, g, { round: code, lineups: (cached && cached.lineups) || null, starters: (cached && cached.starters) || null });
  try {
    const p = await j(`${API}/schedule/games/${g.id}/preview`);
    const pd = p.result && p.result.previewData;
    if (pd) {
      const la = mapLineup(pd.awayTeamLineUp), lh = mapLineup(pd.homeTeamLineUp);
      if (la || lh) f.lineups = { away: la, home: lh };
      const sa = mapStarter(pd.awayStarter), sh = mapStarter(pd.homeStarter);
      if (sa || sh) f.starters = { away: sa, home: sh };
    }
  } catch (e) { console.error('focus preview fail', e.message); }
  if (g.code !== 'BEFORE' && g.code !== 'CANCEL') {
    try {
      const rec = await j(`${API}/schedule/games/${g.id}/record`);
      const rd = rec.result && rec.result.recordData;
      if (rd && rd.battersBoxscore) {
        f.line = rd.scoreBoard || null;
        f.box = {
          batters: { away: (rd.battersBoxscore.away || []).map(mapBat), home: (rd.battersBoxscore.home || []).map(mapBat) },
          batTotal: { away: rd.battersBoxscore.awayTotal || null, home: rd.battersBoxscore.homeTotal || null },
          pitchers: { away: ((rd.pitchersBoxscore || {}).away || []).map(mapPit), home: ((rd.pitchersBoxscore || {}).home || []).map(mapPit) },
          keys: (rd.etcRecords || []).slice(0, 10).map(e => ({ how: e.how, result: e.result }))
        };
        if (!f.lineups || !f.lineups.away || !f.lineups.home) {
          const fa = firstNine(rd.battersBoxscore.away), fh = firstNine(rd.battersBoxscore.home);
          f.lineups = { away: (f.lineups && f.lineups.away) || (fa.length === 9 ? { starter: (f.box.pitchers.away[0] || {}).name || '', batters: fa } : null),
                        home: (f.lineups && f.lineups.home) || (fh.length === 9 ? { starter: (f.box.pitchers.home[0] || {}).name || '', batters: fh } : null) };
        }
      }
    } catch (e) { console.error('focus record fail', e.message); }
    try {
      const rl = await relayLog(g.id, g, cached && cached.log, f.box);
      if (rl) { f.log = rl.log; f.state = rl.state; }
    } catch (e) { console.error('focus relay fail', e.message); }
  }
  f.final = isDone(g) && !!f.box;
  return f;
}

// 가을야구 개인 기록 — 끝난 가을야구 경기마다 박스스코어를 한 번씩 받아 누적 (경기 id로 캐시)
async function psStatsUpdate(ps, prev) {
  const st = prev && prev.v === 1 ? JSON.parse(JSON.stringify(prev)) : { v: 1, done: [], bat: {}, pit: {}, lineups: {}, teams: {} };
  const todo = psGamesOf(ps).filter(g => isDone(g) && st.done.indexOf(g.id) < 0);
  for (const g of todo) {
    try {
      const rd = ((await j(`${API}/schedule/games/${g.id}/record`)).result || {}).recordData;
      if (!rd || !rd.battersBoxscore) continue;
      for (const side of ['away', 'home']) {
        const team = g[side], my = side === 'home' ? g.hs : g.as, op = side === 'home' ? g.as : g.hs;
        const T = st.teams[team] || (st.teams[team] = { g: 0, w: 0, l: 0, d: 0, rs: 0, ra: 0 });
        T.g++; T.rs += my; T.ra += op; T[my > op ? 'w' : my < op ? 'l' : 'd']++;
        const seenB = new Set();
        for (const b of rd.battersBoxscore[side] || []) {
          const k = team + '|' + b.name;
          const x = st.bat[k] || (st.bat[k] = { n: b.name, t: team, g: 0, ab: 0, h: 0, hr: 0, rbi: 0, r: 0, bb: 0, k: 0, sb: 0 });
          if (!seenB.has(k)) { x.g++; seenB.add(k); }
          x.ab += b.ab || 0; x.h += b.hit || 0; x.hr += b.hr || 0; x.rbi += b.rbi || 0; x.r += b.run || 0; x.bb += b.bb || 0; x.k += b.kk || 0; x.sb += b.sb || 0;
        }
        for (const p of (rd.pitchersBoxscore || {})[side] || []) {
          const k = team + '|' + p.name;
          const x = st.pit[k] || (st.pit[k] = { n: p.name, t: team, g: 0, gs: 0, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, w: 0, l: 0, sv: 0, hd: 0 });
          x.g++; if ((rd.pitchersBoxscore[side] || [])[0] === p) x.gs++;
          x.outs += Math.round(PSModel.innings(p.inn) * 3); x.h += p.hit || 0; x.r += p.r || 0; x.er += p.er || 0; x.bb += p.bb || 0; x.k += p.kk || 0; x.hr += p.hr || 0;
          const r = String(p.wls || '') + String(p.w || '') + String(p.l || '') + String(p.s || '');
          if (/승|W/.test(r)) x.w++; if (/패|L/.test(r)) x.l++; if (/세|S/.test(r)) x.sv++; if (/홀|H/.test(r)) x.hd++;
        }
        const nine = firstNine(rd.battersBoxscore[side]);
        const prevLu = st.lineups[team];
        if (nine.length === 9 && (!prevLu || prevLu.date <= g.date)) st.lineups[team] = { id: g.id, date: g.date, names: nine.map(b => b.name) };
      }
      st.done.push(g.id);
    } catch (e) { console.error('psStats fail', g.id, e.message); }
  }
  return st;
}

// 우승 확률 머신 입력: 가을야구 5개 팀 모델 (선수 기록 기반) — 하루 1회 또는 가을 선발 타순이 바뀌면 다시 만든다
async function psModelFor(today, standings, pythag, psStats, prev) {
  if (!standings || standings.length < 10) return prev || null;
  const seeds = standings.slice().sort((a, b) => a.rank - b.rank).slice(0, 5).map(t => t.name);
  const lineups = {};
  for (const [t, lu] of Object.entries((psStats && psStats.lineups) || {})) lineups[t] = lu.names;
  const luKey = Object.keys(lineups).sort().map(t => t + ':' + psStats.lineups[t].id).join(',');
  if (prev && prev.v === PSModel.VERSION && prev.date === today && prev.luKey === luKey && prev.seeds && prev.seeds.join() === seeds.join()) return prev;
  const raw = {};
  for (const [name, code] of Object.entries(TEAM_CODE)) {
    const [hitters, pitchers] = await Promise.all([fetchTeam(code, 'HITTER', UA), fetchTeam(code, 'PITCHER', UA)]);
    raw[name] = { hitters, pitchers };
  }
  const gp = {}; for (const t of standings) gp[t.name] = t.w + t.l + t.d;
  // 1군 엔트리: 팀별 정규시즌 마지막 경기의 문자중계 명단(선발 라인업·투수 + 벤치) — 방출·말소 선수 제외용
  const entry = {};
  try {
    const recent = (await games(ymd(addDays(new Date(Date.parse(today)), -20)), today, 500))
      .filter(g => g.statusCode === 'RESULT' && !g.cancel && !isPs(g.gameId)).sort((a, b) => (b.gameDate + b.gameDateTime).localeCompare(a.gameDate + a.gameDateTime));
    for (const t of seeds) {
      const set = new Set();
      for (const g of recent.filter(x => x.homeTeamName === t || x.awayTeamName === t).slice(0, 1)) {
        try {
          const rd = ((await j(`${API}/schedule/games/${g.gameId}/relay`)).result || {}).textRelayData || {};
          const side = g.homeTeamName === t ? 'home' : 'away';
          for (const k of ['Lineup', 'Entry']) for (const kind of ['batter', 'pitcher']) ((rd[side + k] || {})[kind] || []).forEach(p => p.name && set.add(p.name));
        } catch (e) { console.error('entry fail', g.gameId, e.message); }
      }
      // 가을야구에서 실제로 뛴 선수는 정규시즌 마지막 명단에 없었어도 포함 (예: 복귀한 선발)
      for (const x of [...Object.values((psStats && psStats.bat) || {}), ...Object.values((psStats && psStats.pit) || {})]) if (x.t === t) set.add(x.n);
      if (set.size) entry[t] = [...set];
    }
  } catch (e) { console.error('entry fail', e.message); }
  return Object.assign(PSModel.buildTeams(raw, { pythag, games: gp, lineups, only: seeds, entry }), { date: today, luKey, seeds });
}

// 우승 확률: 지금(진행 중 경기 포함) + 경기마다의 추이(끝난 경기 목록이 바뀔 때만 다시 계산)
function psOddsFor(psm, ps, focus, prev, nowKST) {
  if (!psm || !psm.teams) return prev || null;
  const live = focus && focus.state && focus.state.inn ? { id: focus.id, inn: focus.state.inn, half: focus.state.half, out: focus.state.out } : null;
  const input = { model: psm, seeds: psm.seeds, rounds: (ps && ps.rounds) || {}, live };
  const now = PSModel.simulate(input, { n: PSModel.P.N });
  if (!now) return prev || null;
  delete now.samples;
  const fin = psGamesOf(ps).filter(isDone).map(g => g.id + ':' + g.as + '-' + g.hs);
  const hkey = ['v' + PSModel.VERSION, psm.date, psm.luKey, fin.join(',')].join('|');
  const hist = prev && prev.hkey === hkey ? prev.hist : PSModel.history({ model: psm, seeds: psm.seeds, rounds: input.rounds }, { n: 10000 });
  return { v: PSModel.VERSION, at: nowKST, hkey, now, hist };
}

// 자체 순위 계산: 시즌 전 경기 결과를 직접 집계 (네이버 순위표 반영 지연과 무관하게 경기 종료 즉시 갱신)
async function selfStandings(today, sink) {   // sink: 완료 경기 [{d,a,h,as,hs}]를 모을 배열(선택)
  const ranges = dateRanges(SEASON_START, today, 60);
  const agg = {};
  for (const [f, t] of ranges) {
    if (f > today) break;
    const gs = await games(f, t, 500);
    for (const g of gs) {
      if (g.statusCode !== 'RESULT' && g.statusCode !== 'ENDED') continue;
      if (!KBO_TEAMS.includes(g.homeTeamName) || !KBO_TEAMS.includes(g.awayTeamName)) continue;
      if (isPs(g.gameId)) continue; // 포스트시즌은 정규시즌 집계에서 제외
      if (sink) sink.push({ d: g.gameDate, a: g.awayTeamName, h: g.homeTeamName, as: g.awayTeamScore, hs: g.homeTeamScore });
      for (const [me, my, opsc] of [[g.homeTeamName, g.homeTeamScore, g.awayTeamScore], [g.awayTeamName, g.awayTeamScore, g.homeTeamScore]]) {
        if (!agg[me]) agg[me] = { w: 0, l: 0, d: 0 };
        if (my > opsc) agg[me].w++; else if (my < opsc) agg[me].l++; else agg[me].d++;
      }
    }
  }
  if (Object.keys(agg).length < 10) return null;
  return KBO_TEAMS.map(name => {
    const a = agg[name];
    const pct = a.w / Math.max(1, a.w + a.l);
    return { name, w: a.w, l: a.l, d: a.d, pct, wra: +pct.toFixed(3) };
  }).sort((x, y) => (y.pct - x.pct) || (y.w - x.w)) // 반올림 전 정확한 승률로 정렬
    .map((t, i) => ({ name: t.name, w: t.w, l: t.l, d: t.d, wra: t.wra, rank: i + 1 }));
}

// 잔여 일정 난이도: 남은 상대들의 현재 승률 가중 평균 (자체 산식)
// 주의: KBO가 잔여 일정을 시즌 중 나눠서 공개하므로(취소 경기 재편성 포함) 시점에 따라 표본이 달라진다.
// 공개된 만큼의 표본으로 "상대 평균 승률"을 추정하고, "남은 경기수"는 정규시즌 144경기 - 소화경기로
// 정확히 계산한다 (표본 수와 혼동 금지). 표본이 잔여 경기 전체를 덮으면 추정이 아니라 확정값이 된다.
async function scheduleDifficulty(today, standings, cancelledList) {
  const SEASON_GAMES = 144;
  const wraMap = {}, playedMap = {};
  for (const t of standings) { wraMap[t.name] = parseFloat(t.wra) || 0.5; playedMap[t.name] = t.w + t.l + t.d; }
  const futureRaw = [];
  for (const [f, t] of dateRanges(today, SEASON_END, 60)) futureRaw.push(...(await games(f, t, 500)));
  const future = futureRaw.filter(g => g.statusCode === 'BEFORE' && !g.cancel
    && KBO_TEAMS.includes(g.homeTeamName) && KBO_TEAMS.includes(g.awayTeamName) && !isPs(g.gameId));
  const acc = {};
  for (const g of future) {
    for (const [me, op] of [[g.homeTeamName, g.awayTeamName], [g.awayTeamName, g.homeTeamName]]) {
      if (!acc[me]) acc[me] = { n: 0, sum: 0 };
      acc[me].n++; acc[me].sum += (wraMap[op] != null ? wraMap[op] : 0.5);
    }
  }
  const sampleTotal = future.length;

  // 취소 경기의 재편성 날짜 추적 — KBO는 재편성 경기를 일정에 따로 표시하지 않으므로 대진 수 제약으로 역산한다.
  // 같은 대진·같은 홈/원정의 잔여 경기 수가 그 대진의 취소 경기 수와 같으면, 그 잔여 경기가 곧 재편성분(수학적 확정).
  // 잔여가 더 많으면 어느 쪽이 재편성분인지 특정할 수 없어, 재편성분을 시즌 후반에 배치하는 KBO 관행에 따라
  // 뒤쪽 N경기로 추정한다(sure=false로 표시해 화면에서 '추정'임을 밝힌다).
  const makeups = {};
  const futByPair = {}, cancByPair = {};
  for (const g of future) {
    const k = g.awayTeamName + '|' + g.homeTeamName;
    (futByPair[k] = futByPair[k] || []).push(g.gameDate);
  }
  for (const c of (cancelledList || [])) {
    const k = c.away + '|' + c.home;
    (cancByPair[k] = cancByPair[k] || []).push(c);
  }
  for (const k of Object.keys(cancByPair)) {
    const cs = cancByPair[k].slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const fs = (futByPair[k] || []).slice().sort();
    const sure = fs.length > 0 && fs.length === cs.length;
    // 시즌 중 이미 소화된 재편성분이 있을 수 있으므로 '최근 취소분 ↔ 뒤쪽 잔여 경기'로 짝짓는다
    const n = Math.min(cs.length, fs.length);
    const csTail = cs.slice(cs.length - n), fsTail = fs.slice(fs.length - n);
    csTail.forEach((c, i) => { makeups[c.date + '|' + c.away + '|' + c.home] = { date: fsTail[i], sure }; });
  }

  // 우리 팀 잔여 경기 전체 (화면에서 "이번 주" 대신 시즌 끝까지 보여주기 위함)
  const mine = future
    .filter(g => g.homeTeamName === 'KT' || g.awayTeamName === 'KT')
    .map(g => ({ date: g.gameDate, away: g.awayTeamName, home: g.homeTeamName, stadium: g.stadium, time: (g.gameDateTime || '').slice(11, 16) }))
    .sort((a, b) => a.date < b.date ? -1 : 1);

  return {
    date: today, v: 6, sampleGames: sampleTotal, makeups, mine,
    // 리그 전체 잔여 경기 [날짜, 원정, 홈] — 화면의 경기차 전망 시뮬레이션용
    league: future.map(g => [g.gameDate, g.awayTeamName, g.homeTeamName]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    teams: KBO_TEAMS.map(name => {
      const a = acc[name] || { n: 0, sum: 0 };
      const remaining = Math.max(0, SEASON_GAMES - (playedMap[name] || 0));
      return {
        name, remaining, sampleN: a.n,
        oppWra: a.n ? +(a.sum / a.n).toFixed(3) : 0.5
      };
    }).sort((x, y) => x.oppWra - y.oppWra) // 쉬운 순
  };
}

async function main() {
  const now = kstNow();
  const today = ymd(now);

  // 이전 수집본 (모드 판단·부분 갱신용)
  const file = path.join(__dirname, '..', 'data', 'live.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}

  // 1) 오늘 경기 — 네이버가 응답하지 않으면 KBO 공식 기록으로 점수만 갱신하고 끝낸다(예비 경로)
  let todayGames;
  try { todayGames = (await games(today, today)).map(mapGame); }
  catch (e) {
    console.error('naver fail', e.message);
    if (await kboFallback(today, prev, file, now)) return;
    throw e;
  }

  // ---- 수집 모드 결정 ----
  // live: 진행 중 경기 있음 → 5분 주기 풀 수집
  // pre : 경기 전         → 10분 주기 풀 수집 (라인업 발표 감지)
  // post: 전 경기 종료 또는 경기 없는 날 → 하루 첫 스냅샷 후 유튜브·쇼츠만, 30분 주기
  // 아시안게임 한국 경기도 '오늘 경기'로 취급해 수집 주기를 맞춘다 (경기 중 5분 주기)
  let agToday = [];
  try { const a = await asianGames(today); agToday = a ? a.games.filter(g => g.date === today) : []; } catch (e) {}
  const watch = todayGames.concat(agToday);
  const anyLive = watch.some(g => g.code === 'STARTED' || g.code === 'LIVE');
  const allDone = watch.length > 0 && watch.every(g => ['RESULT', 'ENDED', 'CANCEL'].includes(g.code));
  const noGames = watch.length === 0;
  const mode = anyLive ? 'live' : ((allDone || noGames) ? 'post' : 'pre');
  const SLEEP = { live: 300, pre: 600, post: 1800 };

  // post 모드 + 이전 파일이 이미 오늘의 종료 상태를 반영("post" 마킹) → 유튜브·쇼츠만 부분 갱신
  const prevIsCurrentSchema = prev && prev.pythag && prev.pythag.v === 9 && prev.sched && prev.sched.v === 6 && prev.cancelled && prev.titleRace && prev.psm && prev.psm.v === PSModel.VERSION;
  if (mode === 'post' && prev && prev.mode === 'post' && prev.date === today && prevIsCurrentSchema) {
    const [yt2, nw2] = await Promise.all([fetchYoutube(), fetchNews()]);
    try { prev.ps = await postseason(); } catch (e) { console.error('ps fail', e.message); }
    try { prev.ag = await asianGames(today); } catch (e) { console.error('ag fail', e.message); }
    delete prev.agAdj; delete prev.roster; delete prev.seeds;   // 정규시즌 전용 값(예전 수집본) 정리
    // 가을 기록·머신 입력·우승 확률은 풀 수집 때 갱신된 값을 그대로 둔다(경기가 끝나면 첫 수집이 풀 수집)
    if (yt2.length) prev.youtube = yt2;
    if (nw2.length) prev.news = nw2;
    // 순위는 경기 결과 자체 집계로 갱신 (네이버 순위표는 종료 후 반영이 늦음)
    try {
      const self = await selfStandings(today);
      if (self) {
        const byName = {};
        (prev.standings || []).forEach(t => { byName[t.name] = t; });
        prev.standings = self.map(t => Object.assign({}, byName[t.name] || {}, t));
        const histFile = path.join(__dirname, '..', 'data', 'standings-history.json');
        try {
          let hist = JSON.parse(fs.readFileSync(histFile, 'utf8'));
          const snap = { date: today, teams: prev.standings.map(t => ({ name: t.name, rank: t.rank, w: t.w, l: t.l, d: t.d })) };
          if (hist.length && hist[hist.length - 1].date === today) hist[hist.length - 1] = snap; else hist.push(snap);
          fs.writeFileSync(histFile, JSON.stringify(hist));
        } catch (e) {}
      }
    } catch (e) { console.error('selfStandings(post) fail', e.message); }
    prev.updated = new Date().toISOString();
    prev.updatedKST = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    fs.writeFileSync(file, JSON.stringify(prev, null, 1));
    console.log(`ok(post-partial): yt=${yt2.length} news=${nw2.length}`);
    console.log(`SLEEP=${SLEEP.post}`);
    return;
  }

  // 2) 가을야구 대진·시리즈 전적 (실패 시 직전 값 유지) — 포커스 경기 선택에 필요해 먼저 받는다
  const standings = {};   // (예전: 프리뷰 순위 보조 지표) 정규시즌이 끝나 자체 집계만 쓴다
  let ps = (prev && prev.ps) || null;
  try { ps = await postseason(); } catch (e) { console.error('ps fail', e.message); }

  // 2.5) 오늘의 경기(포커스): 가을야구 경기 → KT 경기 → 가장 최근에 끝난 가을야구 경기
  let focus = (prev && prev.focus) || null;
  try { focus = await focusGame(pickFocus(todayGames, ps), prev && prev.focus); } catch (e) { console.error('focus fail', e.message); }

  // 3) KT 주간 일정 (오늘 ~ +7일)
  const week = (await games(today, ymd(addDays(now, 7))))
    .map(mapGame)
    .filter(g => g.home === 'KT' || g.away === 'KT');

  // 3.5) 시즌 취소 경기 목록 (KBO 공식 일정, 하루 1회 캐시) + 오늘·주간 취소 경기 사유 부착
  const seasonMonths = [];
  for (let m = 3; m <= +today.slice(5, 7); m++) seasonMonths.push(`${today.slice(0, 4)}-${String(m).padStart(2, '0')}`);
  let cancelledList = (prev && prev.cancelled && prev.cancelled.date === today) ? prev.cancelled.list : null;
  const cancelledGames = [...todayGames, ...week].filter(g => g.code === 'CANCEL');
  const cKey = x => `${x.date}|${x.away}|${x.home}`;
  // 캐시가 없거나, 오늘 새로 취소된 경기가 캐시에 아직 없으면 재수집
  const needRefresh = !cancelledList || cancelledGames.some(g => !cancelledList.some(c => cKey(c) === cKey(g)));
  if (needRefresh) {
    try { cancelledList = await fetchCancelledList(seasonMonths); }
    catch (e) {
      console.error('cancel list fail', e.message);
      cancelledList = cancelledList || ((prev && prev.cancelled && prev.cancelled.list) || []);
    }
  }
  for (const g of cancelledGames) {
    const c = cancelledList.find(x => cKey(x) === cKey(g));
    if (c) g.reason = c.reason;
  }

  // 3.7) 개인 타이틀 레이스 — 하루 1회 캐시
  let titleRace = (prev && prev.titleRace && prev.titleRace.date === today) ? prev.titleRace : null;
  if (!titleRace) {
    const trList = await fetchTitleRace();
    titleRace = trList ? { date: today, list: trList } : ((prev && prev.titleRace) || null);
  }

  // 4.7) 관련 뉴스
  const news = await fetchNews();

  // 5) kt wiz 공식 유튜브 최신 영상 (RSS)
  const youtube = await fetchYoutube();

  // 7) 피타고리안 기대승률 — 하루 1회(이전 데이터가 오늘자면 재사용), 실패 시 이전 값 유지
  const prevPyValid = prev && prev.pythag && prev.pythag.date === today
    && prev.pythag.v === 9
    && prev.pythag.teams && prev.pythag.teams.length === 10
    && prev.pythag.teams.every(t => KBO_TEAMS.includes(t.name));
  let pythag = prevPyValid ? prev.pythag : null;
  if (!pythag) {
    try { pythag = await pythagorean(today); } catch (e) { console.error('pythag fail', e.message); pythag = (prev && prev.pythag) || null; }
  }

  // 7.5) 잔여 일정 난이도 — 기본은 하루 1회 캐시.
  // 단 KBO가 잔여 일정을 시즌 중 뒤늦게 공개하거나 취소 경기를 재편성하면 표본이 늘어나므로,
  // 캐시된 표본이 실제 잔여 경기 수(순위표 기준)에 못 미치면 같은 날이라도 1시간 주기로 다시 계산한다.
  // (일정이 끝내 완전 공개되지 않는 구간에서 5분마다 재조회하는 낭비를 막기 위한 시간 버킷)
  const stForSched = Object.keys(standings).length >= 10
    ? Object.values(standings) : ((prev && prev.standings) || []);
  const expectedFuture = stForSched.length >= 10
    ? Math.round(stForSched.reduce((s, t) => s + Math.max(0, 144 - (t.w + t.l + t.d)), 0) / 2) : 0;
  const schedStamp = today + '-' + String(now.getUTCHours()).padStart(2, '0'); // now는 KST 기준
  const prevSched = (prev && prev.sched && prev.sched.v === 6 && prev.sched.date === today) ? prev.sched : null;
  const schedUsable = prevSched && (
    expectedFuture === 0 ||
    prevSched.sampleGames >= expectedFuture * 0.9 || // 표본이 잔여 일정 대부분을 덮음 → 완전한 것으로 간주
    prevSched.stamp === schedStamp                    // 이번 시간대에 이미 재시도함
  );
  let sched = schedUsable ? prevSched : null;
  if (!sched && stForSched.length >= 10) {
    try {
      sched = await scheduleDifficulty(today, stForSched, cancelledList);
      sched.stamp = schedStamp;
    }
    catch (e) { console.error('sched fail', e.message); sched = (prev && prev.sched) || null; }
  }
  if (!sched) sched = (prev && prev.sched) || null;

  // 순위: 경기 결과에서 자체 집계가 1순위 (네이버 순위표는 경기 종료 후 반영이 늦음)
  // 성공 시 자체 w/l/d/rank/wra를 쓰고, era 등 부가 지표는 직전 수집본 값을 이어 쓴다
  let finalStandings = null;
  try {
    const self = await selfStandings(today);
    const was = {}; ((prev && prev.standings) || []).forEach(t => { was[t.name] = t; });
    if (self) finalStandings = self.map(t => Object.assign({}, was[t.name] || {}, standings[t.name] || {}, t));
  } catch (e) { console.error('selfStandings fail', e.message); }
  if (!finalStandings) {
    finalStandings = Object.keys(standings).length >= 10
      ? Object.values(standings).sort((a, b) => a.rank - b.rank)
      : ((prev && prev.standings) || Object.values(standings).sort((a, b) => a.rank - b.rank));
  }

  // 가을야구 개인 기록 → 머신 입력(팀 모델) → 우승 확률 (각각 실패 시 직전 값 유지)
  let psStats = (prev && prev.psStats) || null;
  try { psStats = await psStatsUpdate(ps, prev && prev.psStats); } catch (e) { console.error('psStats fail', e.message); }
  let psm = (prev && prev.psm) || null;
  try { psm = await psModelFor(today, finalStandings, pythag, psStats, prev && prev.psm); } catch (e) { console.error('psm fail', e.message); }
  const stampKST = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  let psOdds = (prev && prev.psOdds) || null;
  try { psOdds = psOddsFor(psm, ps, focus, prev && prev.psOdds, stampKST); } catch (e) { console.error('psOdds fail', e.message); }
  let ag = null;
  try { ag = await asianGames(today); } catch (e) { console.error('ag fail', e.message); ag = (prev && prev.ag) || null; }

  const out = {
    updated: new Date().toISOString(),
    updatedKST: stampKST,
    date: today,
    mode,
    games: todayGames,
    standings: finalStandings,
    focus,
    kt: { week },
    cancelled: { date: today, list: cancelledList },
    titleRace: titleRace,
    news: news.length ? news : ((prev && prev.news) || []),
    youtube, pythag, sched, ps, psStats, psm, psOdds, ag, source: 'naver'
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
        if (hist.length > 400) hist = hist.slice(-400); // 한 시즌 전체 보관
        fs.writeFileSync(histFile, JSON.stringify(hist));
      }
    }
  } catch (e) { console.error('history snapshot fail', e.message); }

  console.log(`ok(${mode}): ${todayGames.length} games, ${out.standings.length} teams, focus=${focus ? focus.id + ' ' + focus.code : '-'}, psm=${!!psm}, odds=${psOdds && psOdds.now ? Object.entries(psOdds.now.champ).map(([t, v]) => t + ' ' + v.toFixed(1)).join(' / ') : '-'}`);
  console.log(`SLEEP=${SLEEP[mode]}`);
}

/* ---------- 예비 경로: KBO 공식 메인 경기 목록 ----------
   네이버 API가 막혔을 때(2026-10-26 17시~이튿날 08시 응답 없음) 점수·상태·이닝·볼카운트·선발/승패 투수만 받아
   직전 수집본(경기·가을 대진·포커스 경기)을 갱신하고 우승 확률을 다시 굴린다. 라인업·박스스코어·문자중계는 이전 값 유지. */
async function kboGames(date) {
  const r = await fetch('https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
      'Referer': 'https://www.koreabaseball.com/', 'X-Requested-With': 'XMLHttpRequest' },
    body: `leId=1&srId=0,1,3,4,5,6,7,8,9&date=${date.replace(/-/g, '')}`
  });
  if (!r.ok) throw new Error('kbo ' + r.status);
  const d = await r.json();
  const nm = s => String(s || '').trim();
  return (d.game || []).map(g => {
    const cancel = String(g.CANCEL_SC_ID || '0') !== '0';
    const st = String(g.GAME_STATE_SC);
    const code = cancel ? 'CANCEL' : st === '3' ? 'RESULT' : st === '2' ? 'STARTED' : 'BEFORE';
    const inn = +g.GAME_INN_NO || 0, half = g.GAME_TB_SC === 'B' ? '말' : '초';
    return {
      away: nm(g.AWAY_NM), home: nm(g.HOME_NM), as: +g.T_SCORE_CN || 0, hs: +g.B_SCORE_CN || 0, code,
      status: cancel ? '취소' : code === 'STARTED' ? `${inn}회${half}` : code === 'RESULT' ? '경기종료' : '경기전',
      ap: nm(g.T_PIT_P_NM), hp: nm(g.B_PIT_P_NM), wp: nm(g.W_PIT_P_NM), lp: nm(g.L_PIT_P_NM),
      state: code === 'STARTED' ? { inn, half, out: Math.min(3, +g.OUT_CN || 0), b: +g.BALL_CN || 0, s: +g.STRIKE_CN || 0,
        bases: [g.B1_BAT_ORDER_NO, g.B2_BAT_ORDER_NO, g.B3_BAT_ORDER_NO].map(x => +x > 0),
        pitcher: nm(code === 'STARTED' && half === '초' ? g.B_P_NM : g.T_P_NM), batter: nm(half === '초' ? g.T_P_NM : g.B_P_NM) } : null
    };
  });
}
async function kboFallback(today, prev, file, now) {
  if (!prev || !prev.psm) return false;
  // 오늘 + 어제(밤새 장애가 이어졌을 때 어제 결과도 채우기)
  const yday = ymd(addDays(new Date(Date.parse(today + 'T00:00:00Z')), -1));
  let kg, ky = [];
  try { kg = await kboGames(today); } catch (e) { console.error('kbo fail', e.message); return false; }
  try { ky = await kboGames(yday); } catch (e) {}
  const same = (a, b) => a.away === b.away && a.home === b.home;
  const upd = (g, k) => { const o = Object.assign({}, g, { as: k.as, hs: k.hs, code: k.code, status: k.status, wp: k.wp || g.wp, lp: k.lp || g.lp, ap: g.ap || k.ap, hp: g.hp || k.hp }); delete o.state; return o; };
  const psAll = [];
  for (const r of Object.values((prev.ps && prev.ps.rounds) || {})) {
    r.games = r.games.map(g => { const k = (g.date === today ? kg : g.date === yday ? ky : []).find(x => same(x, g)); return k ? upd(g, k) : g; });
    psAll.push(...r.games);
  }
  // 오늘 경기 목록: 가을 대진에 있는 경기는 그 id·구장을 이어 쓴다
  prev.games = kg.map(k => { const g = psAll.find(x => x.date === today && same(x, k)); return g ? Object.assign({}, g) : Object.assign({ id: '', date: today, time: '', stadium: '' }, k, { state: undefined }); });
  const todayPs = prev.games.find(g => g.id && psAll.some(x => x.id === g.id) && g.code !== 'CANCEL') || null;
  if (todayPs) {
    const k = kg.find(x => same(x, todayPs));
    const keep = prev.focus && prev.focus.id === todayPs.id ? prev.focus : { lineups: null, starters: null };
    prev.focus = Object.assign({}, keep, todayPs, { round: PS_ROUND[String(todayPs.id).slice(0, 4)] || null, state: k && k.state, final: false });
  }
  const stamp = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  try { prev.psOdds = psOddsFor(prev.psm, prev.ps, prev.focus, prev.psOdds, stamp); } catch (e) { console.error('psOdds fail', e.message); }
  const live = kg.some(x => x.code === 'STARTED');
  prev.mode = live ? 'live' : 'pre';   // 'post'로 두면 네이버 복구 후 부분 갱신만 돌아 박스스코어를 놓친다
  prev.date = today;   // 화면이 오늘 경기를 '지난 경기'로 보지 않게
  prev.source = 'kbo'; prev.updated = new Date().toISOString(); prev.updatedKST = stamp;
  fs.writeFileSync(file, JSON.stringify(prev, null, 1));
  console.log(`ok(kbo-fallback): ${kg.length} games`);
  console.log(`SLEEP=${live ? 300 : 600}`);
  return true;
}

// 직접 실행하면 수집, require하면 함수만 (테스트·예측 도구용)
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { kboGames, postseason, focusGame, pickFocus, psStatsUpdate, psModelFor, psOddsFor };
