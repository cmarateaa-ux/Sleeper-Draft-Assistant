import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT??3000);
const sleeperBase="https://api.sleeper.app/v1";
const ffcCache=new Map();

async function sleeper(pathname){
  const r=await fetch(`${sleeperBase}${pathname}`);
  if(!r.ok) throw new Error(`Sleeper returned ${r.status} · ${await r.text()}`);
  return r.json();
}
function keyName(name){return String(name??"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");}
function nextFor(pickNo,teams,userSlot,type){
  if(!userSlot)return null;
  for(let p=pickNo;p<=teams*100;p++){
    const round=Math.ceil(p/teams),within=((p-1)%teams)+1;
    const slot=type==="linear"?within:(round%2===1?within:teams-within+1);
    if(slot===userSlot)return p;
  }
  return null;
}
function slot(pickNo,teams,type){
  const within=((pickNo-1)%teams)+1,round=Math.ceil(pickNo/teams);
  return type==="linear"?within:(round%2===1?within:teams-within+1);
}
async function ffcAdp(scoring,teams,year){
  const format=scoring.includes("ppr")?"ppr":"standard";
  const cacheKey=`${format}-${teams}-${year}`;
  const cached=ffcCache.get(cacheKey);
  if(cached&&Date.now()-cached.at<6*60*60*1000)return cached.data;
  try{
    const r=await fetch(`https://fantasyfootballcalculator.com/api/v1/adp/${format}?teams=${teams}&year=${year}&position=all`,{headers:{"user-agent":"Sleeper-Draft-Assistant/0.1"}});
    if(!r.ok)throw new Error(`FFC returned ${r.status}`);
    const json=await r.json();
    const map=new Map();
    for(const p of json.players??[]){
      const adp=Number(p.adp);
      if(p.name&&Number.isFinite(adp)&&adp>0&&adp<300)map.set(keyName(p.name),adp);
    }
    ffcCache.set(cacheKey,{at:Date.now(),data:map});
    return map;
  }catch{
    return new Map();
  }
}
async function recommend(draftId){
  const draft=await sleeper(`/draft/${draftId}`);
  const [picks,players]=await Promise.all([sleeper(`/draft/${draftId}/picks`),sleeper(`/players/nfl`)]);
  const scoring=String(draft.metadata?.scoring_type??"ppr").toLowerCase();
  const teams=Number(draft.settings?.teams??12);
  const type=draft.type??"snake";
  const current=Math.max(1,...picks.map(p=>Number(p.pick_no)||0),0)+1;
  const drafted=new Set(picks.map(p=>p.player_id));
  const userId=process.env.SLEEPER_USER_ID??draft.creators?.[0]??null;
  const userSlot=userId&&draft.draft_order?Number(draft.draft_order[userId]):null;
  const userPick=nextFor(current,teams,userSlot,type);
  const nextUserPick=userPick?nextFor(userPick+1,teams,userSlot,type):null;
  const roster={QB:0,RB:0,WR:0,TE:0};
  for(const p of picks.filter(x=>userSlot&&Number(x.draft_slot)===userSlot)){
    const pos=p.metadata?.position;
    if(pos&&Object.hasOwn(roster,pos))roster[pos]++;
  }
  const needs={QB:Number(draft.settings?.slots_qb??1),RB:Number(draft.settings?.slots_rb??2),WR:Number(draft.settings?.slots_wr??2),TE:Number(draft.settings?.slots_te??1)};
  const adpMap=await ffcAdp(scoring,teams,draft.season??new Date().getFullYear());
  const raw=Object.entries(players).map(([id,pl])=>{
    // A draft recommendation should only contain active players who are currently
    // attached to an NFL team. This removes retired/unsigned free agents such as
    // Julian Edelman and Antonio Brown from both recommendations and alternatives.
    if(!pl||drafted.has(id)||pl.status!=="Active"||!pl.team)return null;
    const pos=pl.position||(Array.isArray(pl.fantasy_positions)?pl.fantasy_positions[0]:"");
    if(!["QB","RB","WR","TE"].includes(pos))return null;
    const name=[pl.first_name,pl.last_name].filter(Boolean).join(" ");
    if(!name)return null;
    const adp=adpMap.get(keyName(name));
    if(adp==null)return null;
    return {id,name,position:pos,team:String(pl.team),adp,points:null};
  }).filter(Boolean);
  const round=userPick?Math.ceil(userPick/teams):1;
  const tier=raw.filter(x=>!userPick||x.adp<=userPick+30);
  const candidates=tier.map(x=>{
    const need=Math.max(0,(needs[x.position]??0)-(roster[x.position]??0));
    const startingNeed=round<=3?Math.min(10,need*3):Math.min(14,need*4);
    const flexNeed=(x.position==="RB"||x.position==="WR")&&round<=8&&((roster.RB+roster.WR)<(needs.RB+needs.WR+2))?4:0;
    const qbDepthPenalty=x.position==="QB"&&roster.QB>=needs.QB?-18:0;
    const teDepthPenalty=x.position==="TE"&&roster.TE>=needs.TE?-8:0;
    const valueVsPick=userPick?Math.max(0,Math.min(100,50+(userPick-x.adp)*1.8)):Math.max(0,100-x.adp*1.2);
    const reachPenalty=userPick?Math.max(0,(userPick-x.adp-8)*2.5):0;
    const score=valueVsPick*.68+startingNeed+flexNeed+qbDepthPenalty+teDepthPenalty-reachPenalty;
    return {...x,score};
  }).sort((a,b)=>b.score-a.score).slice(0,8);
  const best=candidates[0]??null;
  const runner=candidates[1]?.score??(best?best.score-8:0);
  const confidence=best?Math.round(Math.min(82,Math.max(55,57+Math.max(0,best.score-runner)*1.5))):null;
  const nextTurnTargets=nextUserPick?[...candidates].filter(x=>x.id!==best?.id).sort((a,b)=>Math.abs((a.adp??999)-nextUserPick)-Math.abs((b.adp??999)-nextUserPick)).slice(0,4).map(x=>({name:x.name,position:x.position,team:x.team,adp:x.adp,survivalPct:x.adp<=nextUserPick?100:Math.max(0,Math.min(100,Math.round(100-(x.adp-nextUserPick)*9)))})):[];
  let plan="Take the best market value that improves the roster; reassess the board after the next turn.";
  if(best&&nextUserPick){
    const back=nextTurnTargets.filter(x=>(x.survivalPct??0)>=60).slice(0,2).map(x=>x.name).join(" or ");
    plan=back?`Take ${best.name} now. At pick ${nextUserPick}, ${back} has a reasonable market chance to remain.`:`Take ${best.name} now. At pick ${nextUserPick}, take the best remaining player rather than forcing a position.`;
  }
  const available=Object.keys(players).filter(id=>!drafted.has(id)&&players[id]?.status==="Active"&&players[id]?.team&&["QB","RB","WR","TE"].includes(players[id]?.position||"")).length;
  const recentPicks=picks.slice(-8).reverse().map(p=>({pickNo:p.pick_no,name:[p.metadata?.first_name,p.metadata?.last_name].filter(Boolean).join(" "),position:p.metadata?.position??"",playerId:p.player_id}));
  return {scoringType:scoring,teams,draftStatus:draft.status,currentPickNo:current,currentSlot:slot(current,teams,type),userSlot,userPickNo:userPick,nextUserPick,picksUntilUser:userPick?userPick-current:null,availableCount:available,roster,recentPicks,marketSource:adpMap.size?"Fantasy Football Calculator ADP":"unavailable",recommendation:best?{name:best.name,position:best.position,team:best.team,adp:best.adp,points:null,confidence,nextPick:nextUserPick,survivalPct:best.adp<=nextUserPick?100:Math.max(0,Math.min(100,Math.round(100-(best.adp-nextUserPick)*9))),reason:`ADP ${best.adp.toFixed(1)} · roster priority and pick value considered. Projection data is not being faked when unavailable.`,plan}:null,alternatives:candidates.slice(1,5).map(x=>({name:x.name,position:x.position,team:x.team,adp:x.adp,points:null,survivalPct:x.adp<=nextUserPick?100:Math.max(0,Math.min(100,Math.round(100-(x.adp-nextUserPick)*9)))})),nextTurnTargets,nextPickDistance:userPick&&nextUserPick?nextUserPick-userPick:null};
}
async function proxy(pathname,res){try{const data=await sleeper(pathname);res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(data));}catch(e){res.writeHead(502,{"content-type":"application/json"});res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}));}}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url??"/",`http://${req.headers.host??"localhost"}`);if(u.pathname==="/"||u.pathname==="/index.html"){const html=await readFile(path.join(root,"../public/index.html"));res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});res.end(html);return;}if(u.pathname==="/api/health"){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify({ok:true,build:"sleeper-eligibility-2026-08-31-16"}));return;}const m=u.pathname.match(/^\/api\/recommendations\/(\d+)$/);if(m){const data=await recommend(m[1]);res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(data));return;}if(u.pathname.startsWith("/api/sleeper/")){await proxy(u.pathname.slice("/api/sleeper".length),res);return;}res.writeHead(404);res.end("Not found");}catch(e){res.writeHead(502,{"content-type":"application/json"});res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}));}});
server.listen(port,"0.0.0.0",()=>console.log(`Sleeper Draft Assistant: http://localhost:${port}`));