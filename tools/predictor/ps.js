#!/usr/bin/env node
// 포스트시즌 우승 확률 머신 — 터미널 버전 (보드 화면·수집기와 같은 scripts/psmodel.js를 쓴다)
//
//   node tools/predictor/ps.js                     data/live.json(없으면 data 브랜치 최신본)으로 20,000번
//   node tools/predictor/ps.js --n 100000          더 많이 굴리기
//   node tools/predictor/ps.js --seed 7            다른 시드 (같은 시드 = 같은 결과)
//   node tools/predictor/ps.js --file path.json    특정 수집본으로
//   node tools/predictor/ps.js --history           경기마다 우승 확률이 어떻게 바뀌었나
//   node tools/predictor/ps.js --matchup KT 삼성   두 팀 맞대결 한 경기 승률(에이스 선발 기준)
//
// 머신 입력(psm: 팀별 타선·선발·불펜·팀 득실)은 수집기가 매일 선수 기록으로 만들어 live.json에 넣는다.

const fs = require('fs');
const path = require('path');
const M = require('../../scripts/psmodel');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
};
const pct = v => v == null ? '   —  ' : (v >= 99.995 ? ' 확정 ' : (v.toFixed(1) + '%').padStart(6));

async function load() {
  const file = opt('file', null) || path.join(__dirname, '..', '..', 'data', 'live.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.psm) return j;
  } catch (e) {}
  const r = await fetch('https://raw.githubusercontent.com/ktwiz-board/ktwiz-board.github.io/data/data/live.json?t=' + Date.now());
  if (!r.ok) throw new Error('데이터를 받지 못했습니다: ' + r.status);
  return r.json();
}

(async () => {
  const d = await load();
  if (!d.psm || !d.psm.teams) { console.error('수집본에 머신 입력(psm)이 없습니다 — 새 수집기가 한 번 돈 뒤 다시 실행하세요.'); process.exit(1); }
  const seeds = d.psm.seeds;
  const f = d.focus, st = f && f.state;
  const input = { model: d.psm, seeds, rounds: (d.ps && d.ps.rounds) || {}, live: st && st.inn ? { id: f.id, inn: st.inn, half: st.half, out: st.out } : null };
  console.log(`데이터 ${d.date} ${d.updatedKST || ''} · 정규시즌 1~5위 ${seeds.join(' · ')}`);

  const mu = opt('matchup', null);
  if (mu) {
    const i = argv.indexOf('--matchup'), h = argv[i + 1], a = argv[i + 2];
    if (!d.psm.teams[h] || !d.psm.teams[a]) { console.error('가을야구 팀 이름을 확인하세요: ' + seeds.join(', ')); process.exit(1); }
    const sp = t => d.psm.teams[t].sp[0];
    const g = M.gameProb(d.psm, h, a, sp(h), sp(a));
    console.log(`\n${h}(홈, 선발 ${sp(h).n}) vs ${a}(원정, 선발 ${sp(a).n})`);
    console.log(`  ${h} 승리 ${(g.p * 100).toFixed(1)}%  (선수 단위 ${(g.pP * 100).toFixed(1)}% · 팀 단위 ${(g.pT * 100).toFixed(1)}%)  기대 득점 ${g.rH.toFixed(2)} : ${g.rA.toFixed(2)}`);
    return;
  }

  const n = +opt('n', M.P.N), seed = +opt('seed', M.P.SEED);
  const t0 = Date.now();
  const r = M.simulate(input, { n, seed });
  console.log(`\n${n.toLocaleString()}번 · 시드 ${seed} · ${Date.now() - t0}ms\n`);
  console.log('  팀      준PO    PO     KS    우승');
  seeds.forEach((t, i) => {
    const k = i + 1;
    const spo = k <= 2 ? null : k === 3 ? 100 : r.reach.SPO[t] || 0;
    const po = k === 1 ? null : k === 2 ? 100 : r.reach.PO[t] || 0;
    const ks = k === 1 ? 100 : r.reach.KS[t] || 0;
    console.log(`  ${(t + '    ').slice(0, 4)}${pct(spo)} ${pct(po)} ${pct(ks)} ${pct(r.champ[t] || 0)}`);
  });
  if (r.next) {
    const x = r.next;
    console.log(`\n다음 경기  ${M.META[x.code].ko} ${x.n}차전 ${x.date} ${x.time} · ${x.away}(${x.spA.n || '미정'}${x.spA.ann ? '' : ' 예상'}) at ${x.home}(${x.spH.n || '미정'}${x.spH.ann ? '' : ' 예상'})`);
    console.log(`          ${x.home} 승리 ${(x.p * 100).toFixed(1)}%` + (x.live ? `  → 진행 중 ${(x.live.p * 100).toFixed(1)}% (${x.live.state ? x.live.state.inn + '회' + x.live.state.half : ''})` : ''));
  }
  if (r.ks) console.log(`\n${r.ks.team} 한국시리즈 예상 선발  ` + r.ks.games.map(g => g.n + '차전 ' + g.sp).join(' · '));
  if (opt('history', false)) {
    const h = M.history({ model: d.psm, seeds, rounds: input.rounds }, { n: 10000, seed });
    console.log('\n경기마다 바뀐 우승 확률 (10,000번씩)');
    h.forEach(e => console.log('  ' + (e.k ? `${M.META[e.code].short} ${e.n}차전 ${e.away} ${e.as}:${e.hs} ${e.home}` : '가을야구 시작 전').padEnd(28) + seeds.map(t => t + ' ' + pct(e.champ[t] || 0).trim()).join('  ')));
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
