import "dotenv/config";
import express from "express";
import { chromium } from "playwright";
import { TypeSafeClient, choice, AuthenticationError, RateLimitError, APIError } from "@typesafe-ai/sdk";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 3000);
const MAX_STEPS = Number(process.env.MAX_STEPS || 40);
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 60);
const ACTION_TIMEOUT = Number(process.env.ACTION_TIMEOUT_MS || 12000);
const PAGE_TEXT_LIMIT = Number(process.env.PAGE_TEXT_LIMIT || 18000);

if (!process.env.TYPESAFE_API_KEY) throw new Error("Missing TYPESAFE_API_KEY. Copy .env.example to .env and add your TypeSafe API key.");
const client = new TypeSafeClient({ logLevel: process.env.TYPESAFE_LOG_LEVEL || "warn" });
const jobs = new Map();

function createJob(task) {
  const id = crypto.randomUUID();
  const job = { id, task, stopRequested: false, clients: new Set(), events: [], stats: { steps: 0, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, jevMs: 0, browserMs: 0, startedAt: Date.now(), finishedAt: null, status: "running" }, result: null };
  jobs.set(id, job); return job;
}
function emit(job, event, data = {}) {
  const payload = { event, time: new Date().toISOString(), ...data };
  job.events.push(payload); if (job.events.length > 800) job.events.shift();
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of job.clients) res.write(message);
  console.log(`[${job.id}] ${event}`, data);
}
function closeJob(job) { for (const res of job.clients) res.end(); job.clients.clear(); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function extractUrls(text) { return [...new Set((text.match(/https?:\/\/[^\s<>"']+/gi) || []).map(u => u.replace(/[),.!?]+$/, "")))]; }
function extractQuoted(text) { return [...text.matchAll(/["'“”‘’]([^"'“”‘’]{1,500})["'“”‘’]/g)].map(m => m[1].trim()).filter(Boolean); }
function extractLikelyValues(task) {
  const values = new Set(extractQuoted(task));
  for (const p of [
    /\b(?:type|enter|input|fill|write|paste)\s+(?:the\s+)?(?:text\s+)?["“']?([^"”']{1,250}?)(?:["”']|$|\s+into\s+)/i,
    /\b(?:search|look)\s+(?:for|up)\s+["“']?([^"”']{1,250}?)(?:["”']|$)/i,
    /\b(?:find)\s+["“']?([^"”']{1,250}?)(?:["”']|$)/i,
    /\b(?:message|say|reply)\s*[:=]?\s*["“']([^"”']{1,500})["”']/i
  ]) { const m = task.match(p); if (m?.[1]) values.add(m[1].trim()); }
  return [...values].filter(v => v && v.length <= 500).slice(0, 12);
}
const normalize = s => String(s || "").replace(/\s+/g, " ").trim();

async function inspectPage(page) {
  const title = await page.title().catch(() => ""), url = page.url();
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const candidates = [], add = c => { if (candidates.length < MAX_CANDIDATES) candidates.push(c); };
  const buttons = page.locator("button:visible"), bc = Math.min(await buttons.count().catch(() => 0), 25);
  for (let i=0;i<bc;i++) { const el=buttons.nth(i), label=normalize(await el.innerText().catch(()=>"")) || normalize(await el.getAttribute("aria-label").catch(()=>"")); if(label) add({id:`button_${i}`,type:"click",locatorType:"button",index:i,description:`Click button "${label.slice(0,120)}"`}); }
  const links = page.locator("a:visible"), lc = Math.min(await links.count().catch(() => 0), 30);
  for (let i=0;i<lc;i++) { const el=links.nth(i), label=normalize(await el.innerText().catch(()=>"")) || normalize(await el.getAttribute("aria-label").catch(()=>"")); if(label) add({id:`link_${i}`,type:"click",locatorType:"link",index:i,description:`Click link "${label.slice(0,120)}"`}); }
  const inputs = page.locator("input:visible, textarea:visible, [contenteditable='true']:visible"), ic = Math.min(await inputs.count().catch(() => 0), 25);
  for (let i=0;i<ic;i++) { const el=inputs.nth(i), type=(await el.getAttribute("type").catch(()=>"text"))||"text", placeholder=normalize(await el.getAttribute("placeholder").catch(()=>"")), name=normalize(await el.getAttribute("name").catch(()=>"")), aria=normalize(await el.getAttribute("aria-label").catch(()=>"")), label=aria||placeholder||name||`input ${i+1}`; add({id:`input_${i}`,type:"input",locatorType:"input",index:i,inputType:type,description:`Use visible ${type} field "${label.slice(0,100)}"`}); if(["checkbox","radio"].includes(type)) add({id:`toggle_${i}`,type:"toggle",locatorType:"input",index:i,description:`Toggle ${type} field "${label.slice(0,100)}"`}); }
  const selects = page.locator("select:visible"), sc = Math.min(await selects.count().catch(() => 0), 15);
  for (let i=0;i<sc;i++) { const el=selects.nth(i), name=normalize(await el.getAttribute("name").catch(()=>"")), aria=normalize(await el.getAttribute("aria-label").catch(()=>"")); add({id:`select_${i}`,type:"select",locatorType:"select",index:i,description:`Choose an option in visible select "${aria||name||`select ${i+1}`}"`}); }
  return { url, title, text:text.slice(0,PAGE_TEXT_LIMIT), candidates, can_go_back: await page.evaluate(()=>history.length>1).catch(()=>false) };
}
function buildCandidates(pageState, task) {
  const out=[...pageState.candidates], values=extractLikelyValues(task);
  for(const value of values) for(const c of pageState.candidates.filter(x=>x.type==="input").slice(0,10)) out.push({id:`fill_${c.index}_${Buffer.from(value).toString("base64url").slice(0,28)}`,type:"fill",index:c.index,value,description:`Fill field ${c.description.replace(/^Use visible /,"")} with the requested text`});
  for(const key of ["Enter","Tab","Escape","ArrowDown","ArrowUp","PageDown","PageUp"]) out.push({id:`press_${key}`,type:"press",key,description:`Press ${key} on the active element`});
  for(const direction of ["down","up","bottom","top"]) out.push({id:`scroll_${direction}`,type:"scroll",direction,description:`Scroll ${direction==="down"?"down":direction==="up"?"up":"to the "+direction} page`});
  out.push({id:"wait_1000",type:"wait",ms:1000,description:"Wait 1 second for the page to update"},{id:"wait_3000",type:"wait",ms:3000,description:"Wait 3 seconds for the page to update"},{id:"extract_page",type:"extract",description:"Read/extract the currently visible page content"},{id:"screenshot",type:"screenshot",description:"Take a screenshot of the current page for visual inspection"},{id:"back",type:"back",description:"Go back one page in browser history"},{id:"forward",type:"forward",description:"Go forward one page in browser history"},{id:"reload",type:"reload",description:"Reload the current page"});
  for(const url of extractUrls(task).slice(0,5)) out.push({id:`navigate_${Buffer.from(url).toString("base64url").slice(0,32)}`,type:"navigate",url,description:"Navigate to the URL specified by the user"});
  return out.slice(0,MAX_CANDIDATES);
}
async function askJev(job, task, pageState) {
  const candidates=buildCandidates(pageState,task), criteria=Object.fromEntries(candidates.map(c=>[c.id,c.description]));
  criteria.finish="Finish only if the requested outcome has actually been achieved or the user asked only to inspect/read the page.";
  const started=performance.now();
  try {
    const response=await client.systemOne({state:{user_task:task,current_url:pageState.url,page_title:pageState.title,visible_text:pageState.text,candidates:candidates.map(({id,type,description})=>({id,type,description}))},questions:{action:choice("Choose the single next browser action that most directly advances the user's task. Never finish merely because a page loaded. For data collection, extract after navigating to the relevant page. For forms, fill required fields before submitting.",criteria)}});
    const elapsed=Math.round(performance.now()-started), usage=response.usage||{}, inputTokens=Number(usage.input_tokens||0), outputTokens=Number(usage.output_tokens||0), totalTokens=inputTokens+outputTokens;
    job.stats.requests++; job.stats.inputTokens+=inputTokens; job.stats.outputTokens+=outputTokens; job.stats.totalTokens+=totalTokens; job.stats.jevMs+=elapsed;
    const answer=response.answers.action;
    emit(job,"jev_decision",{step:job.stats.steps,decision:answer.choice,confidence:answer.confidence,latencyMs:elapsed,inputTokens,outputTokens,totalTokens,model:response.model,cumulative:{...job.stats}});
    return {decision:answer.choice,candidates};
  } catch(error) {
    const elapsed=Math.round(performance.now()-started); job.stats.requests++; job.stats.jevMs+=elapsed;
    const message=error instanceof AuthenticationError?"TypeSafe authentication failed. Check TYPESAFE_API_KEY.":error instanceof RateLimitError?"TypeSafe rate limit reached.":error instanceof APIError?`TypeSafe API error ${error.status||""}: ${error.message}`:error.message;
    emit(job,"error",{source:"typesafe",message,latencyMs:elapsed}); throw error;
  }
}
function getAction(decision,candidates){ if(decision==="finish") return {type:"finish"}; const a=candidates.find(c=>c.id===decision); if(!a) throw new Error(`Jev selected an invalid action "${decision}".`); return a; }
async function executeAction(job,context,page,action) {
  const started=performance.now(); let active=page, result=null;
  switch(action.type) {
    case "click": { const locator=action.locatorType==="button"?active.locator("button:visible").nth(action.index):active.locator("a:visible").nth(action.index); const popup=context.waitForEvent("page",{timeout:1200}).catch(()=>null), download=active.waitForEvent("download",{timeout:1200}).catch(()=>null); await locator.click({timeout:ACTION_TIMEOUT}); const [p,d]=await Promise.all([popup,download]); if(p){await p.waitForLoadState("domcontentloaded",{timeout:10000}).catch(()=>{});active=p;emit(job,"tab_opened",{url:active.url(),title:await active.title().catch(()=>"")});} if(d) emit(job,"download",{filename:d.suggestedFilename(),path:await d.path().catch(()=>null)}); break; }
    case "fill": await active.locator("input:visible, textarea:visible, [contenteditable='true']:visible").nth(action.index).fill(action.value); break;
    case "toggle": { const el=active.locator("input:visible").nth(action.index), checked=await el.isChecked().catch(()=>false); if(checked) await el.uncheck({timeout:ACTION_TIMEOUT}); else await el.check({timeout:ACTION_TIMEOUT}); break; }
    case "select": { const select=active.locator("select:visible").nth(action.index), options=await select.locator("option").allTextContents(), requested=extractLikelyValues(job.task).find(v=>options.some(o=>o.toLowerCase().includes(v.toLowerCase()))); if(!requested) throw new Error("Could not infer which option to select. Mention the option in quotes."); const option=options.find(o=>o.toLowerCase().includes(requested.toLowerCase())); await select.selectOption({label:option}); break; }
    case "press": await active.keyboard.press(action.key); break;
    case "scroll": if(action.direction==="bottom") await active.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)); else if(action.direction==="top") await active.evaluate(()=>window.scrollTo(0,0)); else await active.mouse.wheel(0,action.direction==="down"?850:-850); break;
    case "wait": await sleep(action.ms); break;
    case "navigate": await active.goto(action.url,{waitUntil:"domcontentloaded",timeout:30000}); break;
    case "back": await active.goBack({waitUntil:"domcontentloaded",timeout:20000}); break;
    case "forward": await active.goForward({waitUntil:"domcontentloaded",timeout:20000}); break;
    case "reload": await active.reload({waitUntil:"domcontentloaded",timeout:30000}); break;
    case "extract": { result=await active.locator("body").innerText({timeout:5000}).catch(()=>""); result=result.slice(0,PAGE_TEXT_LIMIT); job.result=result; emit(job,"extracted",{url:active.url(),title:await active.title().catch(()=>"") ,text:result}); break; }
    case "screenshot": { const path=`./screenshots-${job.id}.png`; await active.screenshot({path}); emit(job,"screenshot",{path}); break; }
    default: throw new Error(`Unsupported action type: ${action.type}`);
  }
  return {page:active,result,latencyMs:Math.round(performance.now()-started)};
}

async function geminiVisualRecovery(job, page, task, failedAction, error) {
  if (!process.env.GEMINI_API_KEY) throw new Error("Gemini recovery is unavailable: GEMINI_API_KEY is not configured.");
  if (job.stopRequested) throw new Error("Job stopped by user.");
  const image = await page.screenshot({type:"jpeg",quality:55});
  const visible = await page.locator("body").innerText({timeout:5000}).catch(()=>"");
  const prompt = `You are JEV's visual browser recovery layer.
The deterministic browser action failed because the DOM may have changed.
Return ONLY valid JSON matching one of these forms:
{"type":"click","target":"visible text"}
{"type":"press","key":"Enter"}
{"type":"fill","target":"visible field label","value":"text"}
{"type":"scroll","direction":"down"}
{"type":"wait","ms":1000}
{"type":"stop","reason":"why no safe recovery is possible"}

User task: ${task}
Failed action: ${JSON.stringify(failedAction)}
Failure: ${error.message}
Visible page text (truncate aggressively): ${normalize(visible).slice(0,5000)}
Use the screenshot to identify the intended target. Do not invent hidden elements. Prefer a visible text/label target. Never suggest JavaScript execution.`;
  emit(job,"gemini_recovery_started",{message:"JEV failed; taking a screenshot for one visual recovery attempt."});
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"}:generateContent`,{
    method:"POST",
    headers:{"Content-Type":"application/json","x-goog-api-key":process.env.GEMINI_API_KEY},
    body:JSON.stringify({contents:[{parts:[
      {inlineData:{mimeType:"image/jpeg",data:image.toString("base64")}},
      {text:prompt}
    ]}],generationConfig:{temperature:0,responseMimeType:"application/json",maxOutputTokens:180}})
  });
  if(!response.ok) throw new Error(`Gemini recovery API error: ${response.status} ${await response.text()}`);
  const data=await response.json();
  const raw=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("")?.trim();
  if(!raw) throw new Error("Gemini returned no recovery action.");
  let action;
  try { action=JSON.parse(raw); } catch { throw new Error("Gemini returned invalid recovery JSON."); }
  emit(job,"gemini_recovery",{model:process.env.GEMINI_MODEL||"gemini-2.5-flash-lite",action});
  return action;
}

async function executeVisualRecovery(job, page, recovery) {
  if(job.stopRequested) throw new Error("Job stopped by user.");
  switch(recovery.type){
    case "click": {
      const target=String(recovery.target||"").trim();
      if(!target) throw new Error("Gemini did not provide a click target.");
      const candidates=[
        page.getByRole("button",{name:target,exact:false}).first(),
        page.getByRole("link",{name:target,exact:false}).first(),
        page.getByText(target,{exact:false}).first()
      ];
      for(const locator of candidates){
        if(await locator.isVisible().catch(()=>false)){
          await locator.click({timeout:ACTION_TIMEOUT});
          return;
        }
      }
      throw new Error(`Gemini target "${target}" was not found visibly.`);
    }
    case "fill": {
      const target=String(recovery.target||"").trim(), value=String(recovery.value??"");
      const locators=[
        page.getByLabel(target,{exact:false}).first(),
        page.getByPlaceholder(target,{exact:false}).first(),
        page.locator("input:visible,textarea:visible,[contenteditable='true']:visible").first()
      ];
      for(const locator of locators){
        if(await locator.isVisible().catch(()=>false)){ await locator.fill(value); return; }
      }
      throw new Error(`Gemini field "${target}" was not found visibly.`);
    }
    case "press": await page.keyboard.press(recovery.key); return;
    case "scroll": await page.mouse.wheel(0,recovery.direction==="up"?-850:850); return;
    case "wait": await sleep(Math.min(Number(recovery.ms)||1000,3000)); return;
    case "stop": throw new Error(recovery.reason||"Gemini could not safely recover the task.");
    default: throw new Error(`Unsupported Gemini recovery action: ${recovery.type}`);
  }
}

function getStats(job){const finished=job.stats.finishedAt||Date.now();return {...job.stats,wallMs:Math.max(1,finished-job.stats.startedAt),tokensPerSecond:job.stats.totalTokens>0?Number((job.stats.totalTokens/Math.max(.001,job.stats.jevMs/1000)).toFixed(2)):0,averageJevLatencyMs:job.stats.requests?Math.round(job.stats.jevMs/job.stats.requests):0};}
async function runJob(job,task) {
  let browser;
  try {
    emit(job,"status",{status:"starting",message:"Launching Chromium..."});
    browser=await chromium.launch({headless:process.env.HEADLESS==="true",slowMo:Number(process.env.SLOW_MO_MS||0)});
    const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:900}});
    let page=await context.newPage();
    const initialUrl=extractUrls(task)[0]||process.env.START_URL||"https://www.google.com";
    emit(job,"status",{status:"navigating",message:`Opening ${initialUrl}`});
    await page.goto(initialUrl,{waitUntil:"domcontentloaded",timeout:30000});
    for(let step=1;step<=MAX_STEPS;step++){
      if(job.stopRequested) throw new Error("Job stopped by user.");
      job.stats.steps=step; emit(job,"step_started",{step,message:`Inspecting browser state (step ${step})`});
      const pageState=await inspectPage(page); emit(job,"page_state",{step,url:pageState.url,title:pageState.title,candidateCount:pageState.candidates.length,pages:context.pages().filter(p=>!p.isClosed()).length});
      const plan=await askJev(job,task,pageState), action=getAction(plan.decision,plan.candidates);
      if(action.type==="finish"){job.stats.status="completed";job.stats.finishedAt=Date.now();emit(job,"complete",{message:"Task completed.",step,url:page.url(),result:job.result,stats:getStats(job)});return;}
      emit(job,"action",{step,action:action.id,type:action.type,description:action.description});
      try{
        const executed=await executeAction(job,context,page,action);
        page=executed.page;
        emit(job,"action_complete",{step,action:action.id,latencyMs:executed.latencyMs});
      } catch(error) {
        emit(job,"error",{source:"playwright",step,action:action.id,fatal:false,message:error.message});
        try {
          const recovery=await geminiVisualRecovery(job,page,task,action,error);
          await executeVisualRecovery(job,page,recovery);
          emit(job,"gemini_recovery_complete",{step,message:"Gemini recovery succeeded. Continuing without another planner loop."});
        } catch(recoveryError) {
          const message=`Recovery failed after browser action failure: ${recoveryError.message}`;
          job.stats.status="failed";
          job.stats.finishedAt=Date.now();
          emit(job,"error",{source:"gemini-recovery",step,action:action.id,fatal:true,message});
          emit(job,"complete",{message:"Task stopped after the failed action and one visual recovery attempt.",step,url:page.url(),stats:getStats(job)});
          return;
        }
      }
      if(job.stopRequested) throw new Error("Job stopped by user.");
      await sleep(Number(process.env.STEP_DELAY_MS || 5000));
    }
    throw new Error(`Maximum step count (${MAX_STEPS}) reached before the task completed.`);
  } catch(error) {
    if(job.stats.status==="running"){
      job.stats.status="failed";
      job.stats.finishedAt=Date.now();
      emit(job,"error",{source:"agent",fatal:true,message:error.message});
      emit(job,"complete",{message:"Task failed and was stopped. No further planning or browser actions will be attempted.",stats:getStats(job)});
    }
  }
  finally { if(browser) await browser.close().catch(()=>{}); job.stats.finishedAt??=Date.now(); closeJob(job); }
}
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"JEV Browser Agent",version:"3.2.0",failurePolicy:"gemini-one-shot-recovery-then-stop",stepDelayMs:Number(process.env.STEP_DELAY_MS||5000),geminiRecovery:Boolean(process.env.GEMINI_API_KEY),maxSteps:MAX_STEPS,headless:process.env.HEADLESS==="true"}));
app.post("/api/run",(req,res)=>{const task=req.body?.task;if(typeof task!=="string"||!task.trim())return res.status(400).json({error:"task is required"});const job=createJob(task.trim());runJob(job,job.task).catch(error=>{if(job.stats.status==="running"){job.stats.status="failed";job.stats.finishedAt=Date.now();emit(job,"error",{source:"unhandled",fatal:true,message:error.message});emit(job,"complete",{message:"Task stopped.",stats:getStats(job)});}});res.json({jobId:job.id});});
app.post("/api/jobs/:id/stop",(req,res)=>{const job=jobs.get(req.params.id);if(!job)return res.status(404).json({error:"job not found"});job.stopRequested=true;emit(job,"stop_requested",{message:"Stop requested by user."});res.json({ok:true,jobId:job.id});});
app.get("/api/jobs/:id/events",(req,res)=>{const job=jobs.get(req.params.id);if(!job)return res.status(404).end();res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"});for(const event of job.events)res.write(`data: ${JSON.stringify(event)}\n\n`);job.clients.add(res);req.on("close",()=>job.clients.delete(res));});
app.get("/api/jobs/:id",(req,res)=>{const job=jobs.get(req.params.id);if(!job)return res.status(404).json({error:"job not found"});res.json({id:job.id,task:job.task,result:job.result,stats:getStats(job),events:job.events});});
app.listen(PORT,()=>console.log(`JEV Browser Agent v3: http://localhost:${PORT}`));
