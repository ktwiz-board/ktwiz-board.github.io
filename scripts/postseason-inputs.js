// 공식 시즌 페이지에서 보완한 선수 기준 + 연습경기 출전 이력. 실제 확인값과 모델 추정값을 구분한다.
const supplement=require('./season-supplement.json'), practice=require('./kt-practice.json');
function enrich(model) {
 if(!model)return model;
 const m=JSON.parse(JSON.stringify(model));
 const ops=Object.values(m.teams).flatMap(t=>(t.psBase?.lineup||t.lineup).map(h=>h.ops)).filter(v=>v>0);
 const meanOps=ops.reduce((a,b)=>a+b,0)/ops.length;
 for(const [team,list] of Object.entries(supplement.hitters)) {
  const T=m.teams[team];if(!T)continue;const b=T.psBase||T;b.hAll=b.hAll||{};
  for(const h of list) if(!b.hAll[h.n]) b.hAll[h.n]={...h,wrc:null,war:null,offPrior:(h.ops/meanOps*h.pa+150)/(h.pa+150),prior:'season-OPS',priorOpsMean:meanOps};
 }
 for(const [team,list] of Object.entries(supplement.pitchers)) {
  const T=m.teams[team];if(!T)continue;const b=T.psBase||T;
  for(const p of list) {
   if(b.sp.some(x=>x.n===p.n))continue;
   // 리그 FIP 상수 원본 미확보: 수집기 기본값 3.1을 사용하는 추정 FIP.
   const fip=(13*p.hr+3*(p.bb+p.hp)-2*p.k)/p.ip+3.1;
   const q=((p.era+fip)/2*p.ip+m.lg.era*45)/(p.ip+45);
   const x={...p,ip:+p.ip.toFixed(1),fip:+fip.toFixed(2),fipEstimated:true,q:+q.toFixed(3),st:true,ips:+Math.min(6,Math.max(4.3,p.ip/p.g*.92)).toFixed(2),sv:0,hd:0,k9:+(9*p.k/p.ip).toFixed(1),war:null};
   b.sp.push(x);b.pAll[p.n]=[x.q,x.ips];
  }
  b.sp.sort((a,b)=>a.q-b.q);b.sp=b.sp.slice(0,5);
 }
 m.practice=practice;
 return m;
}
module.exports={enrich};
