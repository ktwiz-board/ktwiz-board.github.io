const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const M = require('./psmodel');
const seeds = ['KT', '삼성', 'KIA', 'LG', '두산'];
const model = {teams: Object.fromEntries(seeds.map(t => [t, {sp: []}]))};
const input = {model, seeds, rounds: {}};
const slots = M.prepare(input).rounds.KS.slots.slice(0, 7);
assert.deepEqual(slots.map(s => s.d), ['2026-11-03','2026-11-04','2026-11-06','2026-11-07','2026-11-08','2026-11-10','2026-11-11']);
assert.deepEqual(slots.map(s => s.time), ['18:30','18:30','18:30','14:00','14:00','18:30','18:30']);
assert.deepEqual(slots.map(s => s.side), ['hi','hi','lo','lo','lo','hi','hi']);
assert.deepEqual(slots.map(s => s.maybe), [false,false,false,false,true,true,true]);
assert.equal(M.dnum(slots[0].d) - M.dnum('2026-11-01'), 2);
// 추가 순연 시 실제 편성이 우선이며, 미편성 경기도 그 차이만큼 이동한다.
input.rounds.KS = {teams:['KT','삼성'], games:[{id:'test',date:'2026-11-04',time:'18:30',home:'KT',away:'삼성',code:'BEFORE'}]};
const shifted = M.prepare(input).rounds.KS.slots;
assert.equal(shifted[0].d, '2026-11-04');
assert.equal(shifted[1].d, '2026-11-05');
const html = fs.readFileSync('index.html','utf8');
let n = 0;
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (/src=|application\/ld\+json/.test(m[1])) continue;
  new vm.Script(m[2]); n++;
}
assert(!html.includes('11. 02 (월) 18:30'));
assert(html.includes("'2026-11-02':'미디어데이', '2026-11-05':'이동일', '2026-11-09':'이동일'"));
assert(html.includes('scripts/psmodel.js?v=' + fs.readFileSync('version.txt','utf8').trim()));
console.log('KS dates, times, home allocation, optional games, D-day, API precedence, build version: OK; inline scripts:', n);
