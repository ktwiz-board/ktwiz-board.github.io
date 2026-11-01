const assert=require('node:assert/strict');
const M=require('./psmodel'),{enrich}=require('./postseason-inputs'),j=require('./fixtures/postseason-nov1.json');
const model=M.applyPostseason(enrich(j.psm),j.psStats),input={model,seeds:model.seeds,rounds:j.ps.rounds};
const r=M.runner(input);assert.deepEqual(Object.keys(r.base.m.teams),['KT','삼성']);
r.step(20000);const v=r.result();assert.equal(v.mode,'KS');assert.deepEqual(v.teams,['KT','삼성']);
assert.deepEqual(Object.keys(v.champ).sort(),['KT','삼성'].sort());
assert.deepEqual(v.win.WC,{});assert.deepEqual(v.win.SPO,{});assert.deepEqual(v.win.PO,{});
assert(v.samples.every(p=>p.slice(0,6).every(x=>x===null)));
assert.equal(v.next.code,'KS');assert.equal(v.next.away,'삼성');assert.equal(v.next.home,'KT');
assert(Math.abs(v.champ.KT+v.champ['삼성']-100)<.02);
assert(Math.abs(Object.values(v.len.KS).reduce((s,v)=>s+v,0)-100)<.05);
// 탈락 팀의 모델이 없어도 결승 두 팀만으로 계산 가능.
const minimal={...input,seeds:['KT','삼성'],model:{...model,teams:Object.fromEntries(v.teams.map(t=>[t,model.teams[t]]))}};
assert.deepEqual(M.simulate(minimal,{n:20000}).champ,v.champ);
assert.equal(M.history(input,{n:100}).length,1,'KS starts a new probability history');
// 이미 끝난 KS 승패는 다시 추첨하지 않는다.
const rounds=JSON.parse(JSON.stringify(j.ps.rounds));rounds.KS={teams:['KT','삼성'],games:Array.from({length:4},(_,i)=>({date:['2026-11-03','2026-11-04','2026-11-06','2026-11-07'][i],time:'18:30',code:'RESULT',home:'KT',away:'삼성',hs:4,as:0}))};
const clinched=M.simulate({...input,rounds},{n:100});assert.equal(clinched.champ.KT,100);assert.equal(clinched.next,null);assert.equal(clinched.len.KS['KT 4-0'],100);
// PO가 확정되기 전에는 기존 전체 포스트시즌 계산을 유지.
const pending=JSON.parse(JSON.stringify(j.ps.rounds));pending.PO.games=pending.PO.games.filter(g=>g.date!=='2026-11-01');
assert.equal(M.simulate({...input,rounds:pending},{n:100}).mode,'postseason');
console.log('KS-only teams, no earlier-round draws, two-team inputs, fixed results, result distribution, pre-clinch fallback: OK',v.champ);
