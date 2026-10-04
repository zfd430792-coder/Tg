/* ---------- background: a turning five-dimensional cube ---------- */
const sky=(()=>{
  const cv=$('#sky'),ctx=cv.getContext('2d');
  let W=0,H=0,raf=0,last=0,C={void:'#05080F',signal:'#40C4FF',ember:'#FF8A5C',mint:'#4BE3B0',light:false};
  const t0=performance.now(),V=[],E=[],kind=[];
  for(let i=0;i<32;i++)V.push([0,1,2,3,4].map(d=>(i>>d)&1?1:-1));
  for(let i=0;i<32;i++)for(let d=0;d<5;d++){const j=i^(1<<d);if(i<j){E.push([i,j]);kind.push(d===4?2:(i>>4)&1)}}
  const adj=V.map((_,i)=>E.map((e,k)=>e[0]===i||e[1]===i?k:-1).filter(k=>k>=0));
  const packs=Array.from({length:16},()=>({e:(Math.random()*E.length)|0,t:Math.random(),dir:1,s:.25+Math.random()*.45}));
  const MODES={app:{x:.76,y:.58,s:.19,a:.72},login:{x:.5,y:.27,s:.15,a:1}};
  const NARROW={app:{x:.66,y:.84,s:.26,a:.45},login:{x:.5,y:.17,s:.2,a:1}};
  let mode='app',now={x:.76,y:.58,s:.19,a:.72},px=0,py=0,tx=0,ty=0;
  const rgba=(h,a)=>{const n=parseInt(h.replace('#','').slice(0,6),16);return`rgba(${n>>16&255},${n>>8&255},${n&255},${a})`};
  function colors(){const cs=getComputedStyle(document.documentElement),g=(k,d)=>{const v=cs.getPropertyValue(k).trim();return/^#[0-9a-f]{6}$/i.test(v)?v:d};C={void:g('--void','#05080F'),signal:g('--signal','#40C4FF'),ember:g('--ember','#FF8A5C'),mint:g('--mint','#4BE3B0'),light:!isDarkNow()};if(reduced.matches)draw(9)}
  function resize(){const dpr=Math.min(1.75,devicePixelRatio||1);W=innerWidth;H=innerHeight;cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);if(reduced.matches)draw(9)}
  function rot(p,a,b,ang){const c=Math.cos(ang),s=Math.sin(ang),x=p[a],y=p[b];p[a]=c*x-s*y;p[b]=s*x+c*y}
  function project(t){return V.map(v=>{const p=v.slice();rot(p,0,4,t*.23);rot(p,1,3,t*.19);rot(p,2,4,t*.13);rot(p,0,3,t*.09);rot(p,3,4,t*.16);rot(p,1,2,.5+py*.6);rot(p,0,2,.35+px*.6);
    let f=1/(1-p[4]*.16),x=p[0]*f,y=p[1]*f,z=p[2]*f,w=p[3]*f;f=1/(1-w*.11);x*=f;y*=f;z*=f;f=1/(1-z*.075);return{x:x*f,y:y*f,z}})}
  function blob(x,y,r,c,a){const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,rgba(c,a));g.addColorStop(1,rgba(c,0));ctx.fillStyle=g;ctx.fillRect(0,0,W,H)}
  function draw(t){
    const M=(W<880?NARROW:MODES)[mode],k=reduced.matches?1:.05;
    now.x+=(M.x-now.x)*k;now.y+=(M.y-now.y)*k;now.s+=(M.s-now.s)*k;now.a+=(M.a-now.a)*k;px+=(tx-px)*.05;py+=(ty-py)*.05;
    ctx.globalAlpha=1;ctx.fillStyle=C.void;ctx.fillRect(0,0,W,H);
    const R=Math.max(W,H),L=C.light;
    blob(W*(.16+.07*Math.sin(t*.31)),H*(.18+.06*Math.cos(t*.27)),R*.62,C.signal,L?.2:.24);
    blob(W*(.9+.05*Math.cos(t*.23)),H*(.86+.06*Math.sin(t*.29)),R*.55,C.ember,L?.15:.17);
    blob(W*(.52+.12*Math.sin(t*.17)),H*(.55+.1*Math.cos(t*.21)),R*.42,C.mint,L?.1:.09);
    const P=project(t),ox=W*now.x,oy=H*now.y,sc=Math.min(W,H)*now.s;
    ctx.lineWidth=1.1;ctx.lineCap='round';
    for(let i=0;i<E.length;i++){const a=P[E[i][0]],b=P[E[i][1]],d=Math.max(0,Math.min(1,((a.z+b.z)/2+2.4)/4.8));ctx.globalAlpha=now.a*(.14+.5*d)*(kind[i]===2?.7:1);ctx.strokeStyle=kind[i]===2?C.mint:kind[i]?C.ember:C.signal;ctx.beginPath();ctx.moveTo(ox+a.x*sc,oy+a.y*sc);ctx.lineTo(ox+b.x*sc,oy+b.y*sc);ctx.stroke()}
    for(let i=0;i<32;i++){const p=P[i],d=Math.max(0,Math.min(1,(p.z+2.4)/4.8));ctx.globalAlpha=now.a*(.35+.65*d);ctx.fillStyle=(i>>4)&1?C.ember:C.signal;ctx.beginPath();ctx.arc(ox+p.x*sc,oy+p.y*sc,1.3+2.2*d,0,6.2832);ctx.fill()}
    ctx.globalAlpha=1;
    for(const q of packs){const a=P[q.dir>0?E[q.e][0]:E[q.e][1]],b=P[q.dir>0?E[q.e][1]:E[q.e][0]],x=ox+(a.x+(b.x-a.x)*q.t)*sc,y=oy+(a.y+(b.y-a.y)*q.t)*sc,g=ctx.createRadialGradient(x,y,0,x,y,9);g.addColorStop(0,rgba(C.signal,.9*now.a));g.addColorStop(1,rgba(C.signal,0));ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,9,0,6.2832);ctx.fill()}
  }
  function step(n){const dt=Math.min(.05,(n-last)/1000||0);last=n;
    for(const q of packs){q.t+=q.s*dt;if(q.t>=1){const end=q.dir>0?E[q.e][1]:E[q.e][0],opts=adj[end].filter(k=>k!==q.e);q.e=opts[(Math.random()*opts.length)|0];q.dir=E[q.e][0]===end?1:-1;q.t=0}}
    draw((n-t0)/1000*.6);raf=requestAnimationFrame(step)}
  function start(){cancelAnimationFrame(raf);if(reduced.matches){draw(9);return}last=performance.now();raf=requestAnimationFrame(step)}
  addEventListener('resize',resize);
  addEventListener('pointermove',e=>{tx=e.clientX/(W||1)-.5;ty=e.clientY/(H||1)-.5},{passive:true});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelAnimationFrame(raf);else start()});
  if(reduced.addEventListener)reduced.addEventListener('change',start);
  return{init(){resize();colors();start()},colors,mode(m){mode=m;if(reduced.matches)draw(9)}};
})();


