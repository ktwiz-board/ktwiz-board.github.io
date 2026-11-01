// KBO 공식 리뷰 박스스코어를 수집기 공통 형식으로 변환한다.
const PS = {4444:4,3333:3,5555:5,7777:7};
const text = s => String(s || '').replace(/<br\s*\/?>/gi,' ').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').trim();
const table = s => { const t = typeof s === 'string' ? JSON.parse(s) : s; return (t.rows || []).map(r => r.row.map(c => text(c.Text))); };
function parseKboBox(j, game) {
  if(String(j.code) !== '100' || j.arrHitter?.length !== 2 || j.arrPitcher?.length !== 2) throw Error('KBO box unavailable');
  const rd = {source:'kbo', battersBoxscore:{}, pitchersBoxscore:{}};
  for(const [i, side] of ['away','home'].entries()) {
    const a = table(j.arrHitter[i].table1), events = table(j.arrHitter[i].table2), nums = table(j.arrHitter[i].table3);
    if(a.length !== nums.length || a.length !== events.length) throw Error('KBO row mismatch');
    rd.battersBoxscore[side] = a.map((r,k) => {
      const ev = events[k].flatMap(s=>s.split(/<br\s*\/?>|\s+/)).filter(Boolean), n=nums[k];
      const count = re => ev.filter(e=>re.test(e)).length;
      return {name:r[2], batOrder:+r[0], pos:r[1], ab:+n[0],hit:+n[1],rbi:+n[2],run:+n[3],
        bb:count(/^(4구|고4)$/), hp:count(/^사구$/), sf:count(/희비/), sh:count(/희번/),
        kk:count(/삼진/),hr:count(/홈/),d2:count(/2$/),d3:count(/3$/), sb:0,
        // 도루는 타석별 결과에 없으므로 0을 실적이라고 표시하지 않는다.
        sbAvailable:false, extraAvailable:true};
    });
    rd.pitchersBoxscore[side] = table(j.arrPitcher[i].table).map(r=>({name:r[0],inn:r[6],hit:+r[10],hr:+r[11],bb:+r[12],kk:+r[13],r:+r[14],er:+r[15],wls:r[2],bbIncludesHp:true}));
    const bat=rd.battersBoxscore[side],pit=rd.pitchersBoxscore[side];
    if(bat.some(b=>!b.name || [b.ab,b.hit,b.rbi,b.run,b.hr,b.d2,b.d3].some(v=>!Number.isInteger(v)||v<0) || b.hit>b.ab || b.d2+b.d3+b.hr>b.hit) || pit.some(p=>!p.name || [p.hit,p.hr,p.bb,p.kk,p.r,p.er].some(v=>!Number.isInteger(v)||v<0))) throw Error('KBO invalid box numbers');
    const runs=bat.reduce((s,b)=>s+b.run,0), expected=game[side==='home'?'hs':'as'];
    if(!bat.length || !pit.length || runs!==expected) throw Error('KBO runs mismatch '+game.id);
  }
  for(const side of ['away','home']) {
    const other=side==='away'?'home':'away';
    if(rd.battersBoxscore[side].reduce((s,b)=>s+b.hit,0)!==rd.pitchersBoxscore[other].reduce((s,p)=>s+p.hit,0)) throw Error('KBO hits mismatch');
  }
  return rd;
}
async function fetchKboRecord(game) {
  const id=String(game.id), srId=PS[id.slice(0,4)];
  if(!srId) throw Error('KBO PS game id required');
  const gameId='2026'+id.slice(4,12)+id.slice(12,13);
  const r=await fetch('https://www.koreabaseball.com/ws/Schedule.asmx/GetBoxScoreScroll',{
    method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent':'Mozilla/5.0','Referer':'https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx','X-Requested-With':'XMLHttpRequest'},
    body:new URLSearchParams({leId:'1',srId:String(srId),seasonId:'2026',gameId})});
  if(!r.ok) throw Error('KBO box '+r.status);
  return parseKboBox(await r.json(),game);
}
module.exports={parseKboBox,fetchKboRecord};


