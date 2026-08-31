import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT??3000);
const sleeperBase="https://api.sleeper.app/v1";
const cache=new Map();
const recommendationCache=new Map();
const recommendationInflight=new Map();

async function sleeper(pathname){
  const r=await fetch(`${sleeperBase}${pathname}`);
  if(!r.ok) throw new Error(`Sleeper returned ${r.status} · ${await r.text()}`);
  return r.json();
}
function keyName(first,last){return `${first??""} ${last??""}`.trim().toLowerCase().replace(/[^a-z0-9]/g,"");}
function nextFor(pickNo,teams,userSlot,type){
  for(let p=pickNo;p<=teams*100;p++){
    const round=Math.ceil(p/teams), within=((p-1)%teams)+1;
    const slot=type==="linear"?within:(round%2===1?within:teams-within+1);
    if(slot===userSlot)return p;
  }
  return null;
}
function slot(pickNo,teams,type){
  const within=((pickNo-1)%teams)+1, round=Math.ceil(pickNo/teams);
  return type==="linear"?within:(round%2===1?within:teams-within+1);
}
function projection(signal,market,scoring){
  const sleeperAdp=Number(signal?.adp);
  const points=Number(signal?.pts);
  return {
    sleeperAdp:Number.isFinite(sleeperAdp)&&sleeperAdp>0?sleeperAdp:null,
    points:Number.isFinite(points)&&points>0?points:0,
    scoring
  };
}
function survival(adp,nextPick){
  if(adp==null||nextPick==null)return null;
  const gap=adp-nextPick;
  if(gap<=0)return 10;
  return Math.max(0,Math.min(100,Math.round(100-gap*9)));
}

async function recommend(draftId){
  const draft=await sleeper(`/draft/${draftId}`);
  const [picks,players]=await Promise.all([
    sleeper(`/draft/${draftId}/picks`),
    sleeper(`/players/nfl`)
  ]);
  const userId=process.env.SLEEPER_USER_ID??draft.creators?.[0]??null;
  const teams=Number(draft.settings?.teams??12);
  const type=draft.type??"snake";
  const current=Math.max(1,...picks.map(p=>Number(p.pick_no)||0),0)+1;
  const drafted=new Set(picks.map(p=>p.player_id));
  const pmap=players;
  const userSlot=userId&&draft.draft_order?Number(draft.draft_order[userId]):null;
  const userPick=nextFor(current,teams,userSlot,type);
  const nextUserPick=userPick?nextFor(userPick+1,teams,userSlot,type):null;
  const roster={QB:0,RB:0,WR:0,TE:0};
  for(const p of picks.filter(x=>userSlot&&Number(x.draft_slot)===userSlot)){
    const pos=p.metadata?.position;
    if(pos&&Object.hasOwn(roster,pos))roster[pos]++;
  }
  const needs={
    QB:Number(draft.settings?.slots_qb??1),
    RB:Number(draft.settings?.slots_rb??2),
    WR:Number(draft.settings?.slots_wr??2),
    TE:Number(draft.settings?.slots_te??1)
  };
  const raw=Object.entries(pmap).map(([id,pl])=>{
    if(!pl||drafted.has(id))return null;
    const pos=pl.position||(Array.isArray(pl.fantasy_positions)?pl.fantasy_positions[0]:"");
    if(!["QB","RB","WR","TE"].includes(pos))return null;
    const full=[pl.first_name,pl.last_name].filter(Boolean).join(" ");
    const adp=Number(pl.search_rank??pl.adp);
    const points=Number(pl.fantasy_points??pl.stats?.pts_ppr??0);
    if(!full||(!Number.isFinite(adp)&&!Number.isFinite(points)))return null;
    return {id,name:full,position:pos,team:pl.team??"",adp:Number.isFinite(adp)&&adp>0&&adp<300?adp:null,points:Number.isFinite(points)?points:0};
  }).filter(Boolean);
  const round=userPick?Math.ceil(userPick/teams):1;
  const window=userPick?userPick+Math.max(24,teams*2):teams*2;
  const tier=raw.filter(x=>x.adp==null?x.points>0:x.adp<=window);
  const byPts=[...tier].sort((a,b)=>b.points-a.points);
  const rank=new Map(byPts.map((x,i)=>[x.id,i+1]));

  const candidates=tier.map(x=>{
    const adp=x.adp??window;
    const r=rank.get(x.id)??tier.length;
    const marketScore=x.adp==null?0:Math.max(0,100-adp*1.55);
    const projectionScore=Math.max(0,38-Math.min(38,(r-1)*1.15));
    const need=Math.max(0,(needs[x.position]??0)-(roster[x.position]??0));

    // Roster construction is a priority signal, not a tiny tie-breaker.
    // In a normal 1-QB league, QB1 is the meaningful requirement; QB2 is insurance.
    const filled=x.position==="QB"&&roster.QB>=needs.QB;
    const qbDepthPenalty=filled?-10:0;
    const needBonus=round<=3
      ? Math.min(2,need*1.5)
      : Math.min(12,need*4);
    const flexNeed=(x.position==="RB"||x.position==="WR")&&round<=8&&((roster.RB+roster.WR)<(needs.RB+needs.WR+2))?3:0;

    let fall=0;
    if(userPick&&x.adp!=null){
      fall=Math.max(0,Math.min(10,(adp-userPick)*0.35));
    }
    let reach=0;
    if(userPick&&x.adp!=null){
      reach=Math.max(0,userPick-adp-5)*2.5;
    }

    return {
      ...x,
      score:marketScore*.64+projectionScore*.28+needBonus+flexNeed+fall-reach+qbDepthPenalty,
      survivalPct:survival(x.adp,nextUserPick)
    };
  }).sort((a,b)=>b.score-a.score).slice(0,8);

  const best=candidates[0]??null;
  const runner=candidates[1]?.score??(best?best.score-8:0);
  const confidence=best?Math.round(Math.min(88,Math.max(55,58+Math.max(0,best.score-runner)*1.5))):null;
  const nextTurnTargets=nextUserPick?[...candidates]
    .filter(x=>x.id!==best?.id)
    .sort((a,b)=>(b.survivalPct??0)-(a.survivalPct??0))
    .slice(0,4)
    .map(x=>({name:x.name,position:x.position,team:x.team,adp:x.adp,survivalPct:x.survivalPct})):[ ];
  let plan="Take the best player now; reassess the board after the next turn.";
  if(best&&nextUserPick){
    const back=nextTurnTargets.filter(x=>(x.survivalPct??0)>=60).slice(0,2).map(x=>x.name).join(" or ");
    plan=back
      ?`Take ${best.name} now. At pick ${nextUserPick}, ${back} has a reasonable market chance to remain.`
      :`Take ${best.name} now. At pick ${nextUserPick}, take the best remaining player rather than forcing a position.`;
  }
  const available=Object.keys(pmap).filter(id=>!drafted.has(id)&&pmap[id]&&["QB","RB","WR","TE"].includes(pmap[id].position||"")).length;
  const recentPicks=picks.slice(-8).reverse().map(p=>({pickNo:p.pick_no,name:[p.metadata?.first_name,p.metadata?.last_name].filter(Boolean).join(" "),position:p.metadata?.position??"",playerId:p.player_id}));
  return {
    scoringType:draft.metadata?.scoring_type??"ppr",
    teams,
    draftStatus:draft.status,
    currentPickNo:current,
    currentSlot:slot(current,teams,type),
    userSlot,
    userPickNo:userPick,
    nextUserPick,
    picksUntilUser:userPick?userPick-current:null,
    availableCount:available,
    roster,
    recentPicks,
    recommendation:best?{
      name:best.name,
      position:best.position,
      team:best.team,
      adp:best.adp,
      points:best.points,
      confidence,
      nextPick:nextUserPick,
      survivalPct:best.survivalPct,
      reason:`ADP ${best.adp?.toFixed(1)??"—"} · projected ${best.points.toFixed(1)} pts · roster need, market value, projection value and your next pick considered.`,
      plan
    }:null,
    alternatives:candidates.slice(1,5).map(x=>({name:x.name,position:x.position,team:x.team,adp:x.adp,points:x.points,survivalPct:x.survivalPct})),
    nextTurnTargets,
    nextPickDistance:userPick&&nextUserPick?nextUserPick-userPick:null
  };
}
async function proxy(pathname,res){
  try{
    const data=await sleeper(pathname);
    res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
    res.end(JSON.stringify(data));
  }catch(e){
    res.writeHead(502,{"content-type":"application/json"});
    res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}));
  }
}
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url??"/",`http://${req.headers.host??"localhost"}`);
    if(u.pathname==="/"||u.pathname==="/index.html"){
      const html=await readFile(path.join(root,"../public/index.html"));
      res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
      res.end(html);return;
    }
    if(u.pathname==="/api/health"){
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify({ok:true,build:"sleeper-roster-priority-2026-08-31-14"}));return;
    }
    const m=u.pathname.match(/^\/api\/recommendations\/(\d+)$/);
    if(m){
      const data=await recommend(m[1]);
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify(data));return;
    }
    if(u.pathname.startsWith("/api/sleeper/")){await proxy(u.pathname.slice("/api/sleeper".length),res);return;}
    res.writeHead(404);res.end("Not found");
  }catch(e){
    res.writeHead(502,{"content-type":"application/json"});
    res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}));
  }
});
server.listen(port,"0.0.0.0",()=>console.log(`Sleeper Draft Assistant: http://localhost:${port}`));
