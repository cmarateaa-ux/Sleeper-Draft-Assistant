import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "url";
import { readFile } from "node:fs/promises";

const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT??3000);
const sleeperBase="https://api.sleeper.app/v1";
const sleeperProjectionBase="https://api.sleeper.com/projections/nfl";
const sleeperAdpCache=new Map();
const BUILD="sleeper-adp-reconciliation-2026-08-31-26";

async function sleeper(pathname){const r=await fetch(`${sleeperBase}${pathname}`,{headers:{"user-agent":"Mozilla/5.0 Sleeper-Draft-Assistant/0.1"}});if(!r.ok)throw new Error(`Sleeper returned ${r.status} · ${await r.text()}`);return r.json()}
function nextFor(pickNo,teams,userSlot,type){if(!userSlot)return null;for(let p=pickNo;p<=teams*100;p++){const round=Math.ceil(p/teams),within=((p-1)%teams)+1,sl=type==="linear"?within:(round%2===1?within:teams-within+1);if(sl===userSlot)return p}return null}
function slot(pickNo,teams,type){const within=((pickNo-1)%teams)+1,round=Math.ceil(pickNo/teams);return type==="linear"?within:(round%2===1?within:teams-within+1)}
function fieldName(scoring){return scoring.includes("half")?"adp_half_ppr":scoring.includes("standard")||scoring.includes("std")?"adp_std":"adp_ppr"}
async function sleeperAdp(scoring,year){
  // Sleeper's scoring-specific ADP lives on the season projection feed.
  // The prior code incorrectly queried week 1 and used adp_dd_ppr, which is a
  // different field. The normal PPR draft board uses adp_ppr.
  const field=fieldName(scoring);
  const cacheKey=`sleeper-feed-${field}-${year}`;
  const cached=sleeperAdpCache.get(cacheKey);
  if(cached&&Date.now()-cached.at<30*60*1000)return cached.data;
  try{
    const r=await fetch(`${sleeperProjectionBase}/${year}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&order_by=${field}`,{headers:{"user-agent":"Mozilla/5.0 Sleeper-Draft-Assistant/0.1","accept":"application/json"}});
    if(!r.ok)throw new Error(`Sleeper projections returned ${r.status}`);
    const rows=await r.json(),map=new Map();
    for(const p of Array.isArray(rows)?rows:[]){const id=String(p.player_id??p.stats?.player_id??""),rawAdp=Number(p[field]??p.stats?.[field]);if(id&&Number.isFinite(rawAdp)&&rawAdp>0&&rawAdp<999)map.set(id,rawAdp)}
    sleeperAdpCache.set(cacheKey,{at:Date.now(),data:map});return map;
  }catch{return new Map()}
}
async function recommend(draftId){const draft=await sleeper(`/draft/${draftId}`),[picks,players]=await Promise.all([sleeper(`/draft/${draftId}/picks`),sleeper(`/players/nfl`)]),scoring=String(draft.metadata?.scoring_type??"ppr").toLowerCase(),teams=Number(draft.settings?.teams??12),type=draft.type??"snake",current=Math.max(1,...picks.map(p=>Number(p.pick_no)||0),0)+1,drafted=new Set(picks.map(p=>p.player_id)),userId=process.env.SLEEPER_USER_ID??draft.creators?.[0]??null,userSlot=userId&&draft.draft_order?Number(draft.draft_order[userId]):null,userPick=nextFor(current,teams,userSlot,type),nextUserPick=userPick?nextFor(userPick+1,teams,userSlot,type):null;
const roster={QB:0,RB:0,WR:0,TE:0};for(const p of picks.filter(x=>userSlot&&Number(x.draft_slot)===userSlot)){const pos=p.metadata?.position;if(pos&&Object.hasOwn(roster,pos))roster[pos]++}
const needs={QB:Number(draft.settings?.slots_qb??1),RB:Number(draft.settings?.slots_rb??2),WR:Number(draft.settings?.slots_wr??2),TE:Number(draft.settings?.slots_te??1)},adpMap=await sleeperAdp(scoring,draft.season??new Date().getFullYear());
const raw=Object.entries(players).map(([id,pl])=>{if(!pl||drafted.has(id)||pl.status!=="Active"||!pl.team)return null;const pos=pl.position||(Array.isArray(pl.fantasy_positions)?pl.fantasy_positions[0]:"");if(!["QB","RB","WR","TE"].includes(pos))return null;const name=[pl.first_name,pl.last_name].filter(Boolean).join(" "),adp=adpMap.get(String(id));if(!name||adp==null)return null;return{id,name,position:pos,team:String(pl.team),adp,points:null}}).filter(Boolean);
const round=userPick?Math.ceil(userPick/teams):1;
const candidates=raw.map(x=>{
  const rosterCount=roster[x.position]??0,starterNeed=Math.max(0,(needs[x.position]??0)-rosterCount),startingNeed=starterNeed>0?(round<=3?Math.min(12,starterNeed*4):Math.min(18,starterNeed*6)):0;
  const flexNeed=(x.position==="RB"||x.position==="WR")&&round<=8&&roster.RB+roster.WR<needs.RB+needs.WR+2?4:0;
  const qbDepthPenalty=x.position==="QB"&&roster.QB>=needs.QB?-22:0,teDepthPenalty=x.position==="TE"&&roster.TE>=needs.TE?-10:0;
  const adpVsPick=userPick?userPick-x.adp:0;
  const marketValue=userPick?Math.max(0,Math.min(82,50+adpVsPick*1.35)):Math.max(0,100-x.adp*0.65);
  const reachPenalty=userPick?Math.max(0,-adpVsPick-8)*2.25:0;
  const score=marketValue+startingNeed+flexNeed+qbDepthPenalty+teDepthPenalty-reachPenalty;
  return{...x,score,starterNeed,adpVsPick};
}).sort((a,b)=>b.score-a.score||a.adp-b.adp||a.name.localeCompare(b.name));
const best=candidates[0]??null,runner=candidates[1]?.score??(best?best.score-8:0),confidence=best?Math.round(Math.min(82,Math.max(55,57+Math.max(0,best.score-runner)*1.5))):null;
const nextTurnTargets=nextUserPick?[...candidates].filter(x=>x.id!==best?.id).sort((a,b)=>Math.abs(a.adp-nextUserPick)-Math.abs(b.adp-nextUserPick)).slice(0,4).map(x=>({name:x.name,position:x.position,team:x.team,adp:x.adp,survivalPct:x.adp<=nextUserPick?100:Math.max(0,Math.min(100,Math.round(100-(x.adp-nextUserPick)*9)))})):[];
let plan="Take the best market value that improves the roster; reassess the board after the next turn.";if(best&&nextUserPick){const back=nextTurnTargets.filter(x=>x.survivalPct>=60).slice(0,2).map(x=>x.name).join(" or ");plan=back?`Take ${best.name} now. At pick ${nextUserPick}, ${back} has a reasonable market chance to remain.`:`Take ${best.name} now. At pick ${nextUserPick}, take the best remaining player rather than forcing a position.`}
const available=raw.length,recentPicks=picks.slice(-8).reverse().map(p=>({pickNo:p.pick_no,name:[p.metadata?.first_name,p.metadata?.last_name].filter(Boolean).join(" "),position:p.metadata?.position??"",playerId:p.player_id}));
const adpLabel=adpMap.size?`Sleeper ${scoring.toUpperCase()} ADP`:"unavailable";
return{build:BUILD,scoringType:scoring,teams,draftStatus:draft.status,currentPickNo:current,currentSlot:slot(current,teams,type),userSlot,userPickNo:userPick,nextUserPick,picksUntilUser:userPick?userPick-current:null,availableCount:available,roster,recentPicks,marketSource:adpLabel,adpSource:fieldName(scoring),recommendation:best?{name:best.name,position:best.position,team:best.team,adp:best.adp,points:null,confidence,nextPick:nextUserPick,survivalPct:nextUserPick?(best.adp<=nextUserPick?100:Math.max(0,Math.min(100,Math.round(100-(best.adp-nextUserPick)*9)))):null,reason:`Sleeper ${scoring.toUpperCase()} ADP ${best.adp.toFixed(1)} · pick ${userPick??"—"} · ${best.adpVsPick>=0?`about ${Math.round(best.adpVsPick)} spots later than this pick`:`about ${Math.round(Math.abs(best.adpVsPick))} spots earlier than this pick`}. ${best.starterNeed>0?`Fills an immediate ${best.position} starting need.`:"Roster priority and pick value both considered."}`,plan}:null,alternatives:candidates.slice(1,5).map(x=>({name:x.name,position:x.position,team:x.team,adp:x.adp,points:null,survivalPct:nextUserPick?(x.adp<=nextUserPick?100:Math.max(0,Math.min(100,Math.round(100-(x.adp-nextUserPick)*9)))):null,adpVsPick:userPick?userPick-x.adp:null})),nextTurnTargets,nextPickDistance:userPick&&nextUserPick?nextUserPick-userPick:null}}
async function proxy(pathname,res){try{const data=await sleeper(pathname);res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(data))}catch(e){res.writeHead(502,{"content-type":"application/json"});res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}))}}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url??"/",`http://${req.headers.host??"localhost"}`);if(u.pathname==="/"||u.pathname==="/index.html"){const html=await readFile(path.join(root,"../public/index.html"));res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});res.end(html);return}if(u.pathname==="/api/health"){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify({ok:true,build:BUILD}));return}const m=u.pathname.match(/^\/api\/recommendations\/(\d+)$/);if(m){const data=await recommend(m[1]);res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(data));return}if(u.pathname.startsWith("/api/sleeper/")){await proxy(u.pathname.slice("/api/sleeper".length),res);return}res.writeHead(404);res.end("Not found")}catch(e){res.writeHead(502,{"content-type":"application/json"});res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}))}});server.listen(port,"0.0.0.0",()=>console.log(`Sleeper Draft Assistant: http://localhost:${port}`));