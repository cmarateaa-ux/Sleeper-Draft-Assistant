import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const API = "https://api.sleeper.app/v1";
const SEASON = "https://api.sleeper.com/projections/nfl/2026";
const WEEK1 = "https://api.sleeper.com/projections/nfl/2026/1";
const FFC = "https://fantasyfootballcalculator.com/api/v1/adp";
let playersCache, playersAt = 0, seasonCache, seasonAt = 0, marketCache, marketAt = 0;
const ffcCache = new Map();

async function json(base, path = "") {
  const r = await fetch(base + path, { headers: { accept: "application/json", "user-agent": "Sleeper-Draft-Assistant" }, cache: "no-store" });
  const text = await r.text();
  if (!r.ok) throw new Error(`Upstream returned ${r.status} · ${text || "empty response"}`);
  try { return JSON.parse(text); } catch { throw new Error("Upstream returned invalid JSON"); }
}
const sleeper = path => json(API, path);
async function players() { if (!playersCache || Date.now()-playersAt > 86400000) { playersCache = await sleeper("/players/nfl"); playersAt = Date.now(); } return playersCache; }
async function season() { if (!seasonCache || Date.now()-seasonAt > 3600000) { seasonCache = await json(SEASON, "?season_type=regular"); seasonAt = Date.now(); } return seasonCache; }
async function market() { if (!marketCache || Date.now()-marketAt > 600000) { marketCache = await json(WEEK1, "?season_type=regular"); marketAt = Date.now(); } return marketCache; }
async function ffc(scoring, teams) {
  const key = `${scoring}:${teams}`; const cached = ffcCache.get(key);
  if (cached && Date.now()-cached.at < 1800000) return cached.data;
  const format = scoring === "half_ppr" ? "half-ppr" : scoring === "standard" ? "standard" : "ppr";
  try { const data = await json(FFC, `/${format}?teams=${teams}&year=2026`); ffcCache.set(key,{data,at:Date.now()}); return data; } catch { return null; }
}
function rows(v) { if (Array.isArray(v)) return v.map(x => [String(x.player_id ?? x.playerId ?? x.id ?? ""),x]).filter(x=>x[0]); if (v && typeof v === "object") return Object.entries(v); return []; }
function stats(x) { return x?.stats && typeof x.stats === "object" ? x.stats : x ?? {}; }
function nameKey(x) { return String(x ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function slot(p, teams, type="snake") { if (!teams) return null; const i=p-1, r=Math.floor(i/teams)+1, n=i%teams; return type === "snake" && r%2===0 ? teams-n : n+1; }
function nextFor(p, teams, wanted, type="snake") { if (!wanted) return null; for(let x=p;x<p+teams*2;x++) if(slot(x,teams,type)===wanted) return x; return null; }
function survival(adp, pick) { if(!Number.isFinite(adp)||!pick) return null; return Math.round(100/(1+Math.exp(-(adp-pick)/4.5))); }
function projection(seasonRow, marketRow, scoring) {
  const a=stats(seasonRow), b=stats(marketRow);
  const pts=scoring==="ppr"?(a.pts_ppr??seasonRow?.pts_ppr):scoring==="half_ppr"?(a.pts_half_ppr??seasonRow?.pts_half_ppr):(a.pts_std??seasonRow?.pts_std);
  const adp=scoring==="ppr"?(b.adp_dd_ppr??b.adp_ppr??a.adp_dd_ppr??a.adp_ppr??marketRow?.adp_dd_ppr??seasonRow?.adp_dd_ppr):scoring==="half_ppr"?(b.adp_dd_half_ppr??b.adp_half_ppr??a.adp_dd_half_ppr??a.adp_half_ppr??marketRow?.adp_dd_half_ppr??seasonRow?.adp_dd_half_ppr):(b.adp_dd_std??b.adp_std??a.adp_dd_std??a.adp_std??marketRow?.adp_dd_std??seasonRow?.adp_std);
  const n=Number(adp); return { points:Number.isFinite(Number(pts))?Number(pts):0, sleeperAdp:Number.isFinite(n)&&n>0&&n<200?n:null };
}

async function recommend(draftId) {
  const draft=await sleeper(`/draft/${encodeURIComponent(draftId)}`), picks=await sleeper(`/draft/${encodeURIComponent(draftId)}/picks`);
  const scoring=draft.metadata?.scoring_type==="half_ppr"?"half_ppr":draft.metadata?.scoring_type==="std"?"standard":"ppr";
  const teams=Number(draft.settings?.teams??12), type=draft.type??"snake";
  const [sraw,mraw,pmap,fr]=await Promise.all([season(),market(),players(),ffc(scoring,teams)]);
  const smap=new Map(rows(sraw)), mmap=new Map(rows(mraw));
  const ffcRows=Array.isArray(fr?.players)?fr.players:[], ffcByName=new Map(ffcRows.map(x=>[nameKey(x.name),x]));
  const drafted=new Set(picks.map(p=>String(p.player_id)));
  const current=picks.length+1, userId=Array.isArray(draft.creators)&&draft.creators.length===1?String(draft.creators[0]):null;
  const userSlot=userId&&draft.draft_order?Number(draft.draft_order[userId]):null;
  const userPick=nextFor(current,teams,userSlot,type), nextUserPick=userPick?nextFor(userPick+1,teams,userSlot,type):null;
  const roster={QB:0,RB:0,WR:0,TE:0};
  for(const p of picks.filter(x=>userSlot&&Number(x.draft_slot)===userSlot)){const pos=p.metadata?.position;if(pos&&Object.hasOwn(roster,pos))roster[pos]++;}
  const needs={QB:Number(draft.settings?.slots_qb??1),RB:Number(draft.settings?.slots_rb??2),WR:Number(draft.settings?.slots_wr??2),TE:Number(draft.settings?.slots_te??1)};
  const raw=Array.from(smap.entries()).map(([id,s])=>{
    const pl=pmap[id]; if(!pl||drafted.has(id))return null;
    const pos=pl.position||(Array.isArray(pl.fantasy_positions)?pl.fantasy_positions[0]:""); if(!["QB","RB","WR","TE"].includes(pos))return null;
    const v=projection(s,mmap.get(id),scoring), full=[pl.first_name,pl.last_name].filter(Boolean).join(" "), f=ffcByName.get(nameKey(full)), fa=Number(f?.adp);
    const adp=Number.isFinite(fa)&&fa>0&&fa<200?fa:v.sleeperAdp; if(!adp&&!v.points)return null;
    return {id,name:full,position:pos,team:pl.team??"",adp,points:v.points};
  }).filter(Boolean);
  const round=userPick?Math.ceil(userPick/teams):1, window=userPick?userPick+Math.max(24,teams*2):teams*2;
  const tier=raw.filter(x=>x.adp==null?x.points>0:x.adp<=window), byPts=[...tier].sort((a,b)=>b.points-a.points), rank=new Map(byPts.map((x,i)=>[x.id,i+1]));
  const candidates=tier.map(x=>{
    const adp=x.adp??window, r=rank.get(x.id)??tier.length, marketScore=x.adp==null?0:Math.max(0,100-adp*1.55), projectionScore=Math.max(0,38-Math.min(38,(r-1)*1.15));
    const need=Math.max(0,(needs[x.position]??0)-(roster[x.position]??0)), needBonus=round<=3?Math.min(2,need):Math.min(9,need*3);
    const fall=userPick&&x.adp!=null?Math.max(0,Math.min(10,(adp-userPick)*0.35)):0, reach=userPick&&x.adp!=null?Math.max(0,userPick-adp-5)*2.5:0;
    return {...x,score:marketScore*.64+projectionScore*.28+needBonus+fall-reach,survivalPct:survival(x.adp,nextUserPick)};
  }).sort((a,b)=>b.score-a.score).slice(0,8);
  const best=candidates[0]??null, runner=candidates[1]?.score??(best?best.score-8:0), confidence=best?Math.round(Math.min(88,Math.max(55,58+Math.max(0,best.score-runner)*1.5))):null;
  const nextTurnTargets=nextUserPick?[...candidates].filter(x=>x.id!==best?.id).sort((a,b)=>(b.survivalPct??0)-(a.survivalPct??0)).slice(0,4).map(x=>({name:x.name,position:x.position,team:x.team,adp:x.adp,survivalPct:x.survivalPct})):[];
  let plan="Take the best player now; reassess the board after the next turn.";
  if(best&&nextUserPick){const back=nextTurnTargets.filter(x=>(x.survivalPct??0)>=60).slice(0,2).map(x=>x.name).join(" or ");plan=back?`Take ${best.name} now. At pick ${nextUserPick}, ${back} has a reasonable market chance to remain.`:`Take ${best.name} now. At pick ${nextUserPick}, take the best remaining player rather than forcing a position.`;}
  const available=Object.keys(pmap).filter(id=>!drafted.has(id)&&pmap[id]&&["QB","RB","WR","TE"].includes(pmap[id].position||"")).length;
  return {scoringType:scoring,teams,currentPickNo:current,currentSlot:slot(current,teams,type),userSlot,userPickNo:userPick,nextUserPick,picksUntilUser:userPick?userPick-current:null,availableCount:available,roster,recommendation:best?{name:best.name,position:best.position,team:best.team,adp:best.adp,points:best.points,confidence,nextPick:nextUserPick,survivalPct:best.survivalPct,reason:`ADP ${best.adp?.toFixed(1)??"—"} · projected ${best.points.toFixed(1)} pts · market tier, projection value and your next pick considered.`,plan}:null,alternatives:candidates.slice(1,5).map(x=>({name:x.name,position:x.position,team:x.team,adp:x.adp,points:x.points,survivalPct:x.survivalPct})),nextTurnTargets,nextPickDistance:userPick&&nextUserPick?nextUserPick-userPick:null};
}
async function proxy(pathname,res){try{const data=await sleeper(pathname);res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(data));}catch(e){res.writeHead(502,{"content-type":"application/json"});res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}));}}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url??"/",`http://${req.headers.host??"localhost"}`);if(u.pathname==="/"||u.pathname==="/index.html"){const html=await readFile(path.join(root,"../public/index.html"));res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});res.end(html);return;}if(u.pathname==="/api/health"){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify({ok:true,build:"draft-strategy-2026-08-31-10"}));return;}const m=u.pathname.match(/^\/api\/recommendations\/(\d+)$/);if(m){const data=await recommend(m[1]);res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(data));return;}if(u.pathname.startsWith("/api/sleeper/")){await proxy(u.pathname.slice("/api/sleeper".length),res);return;}res.writeHead(404);res.end("Not found");}catch(e){res.writeHead(502,{"content-type":"application/json"});res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}));}});
server.listen(port,"0.0.0.0",()=>console.log(`Sleeper Draft Assistant: http://localhost:${port}`));