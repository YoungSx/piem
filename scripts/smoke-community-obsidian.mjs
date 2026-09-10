/**
 * Real Obsidian smoke, disposable vault only. The model endpoint is local and deterministic.
 * Usage: node scripts/smoke-community-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]
 * Start Obsidian with <output-dir>/vault and official mobile emulation for the mobile pass.
 * The script closes its HTTP server/CDP socket and restores all observers on every exit.
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { observePluginNodeAccess } from "./obsidian-plugin-node-audit.mjs";

async function runSmoke(root, endpoint, expectMobile, observeNodeAccess) {
 const report = { passed: false, checks: [], errors: [], cycles: [] };
 const record = (name, value) => { if (!value) throw new Error(name); report.checks.push(name); };
 const wait = async test => { for (let i=0; i<250; i++) { if(await test()) return; await new Promise(r=>setTimeout(r,20)); } throw new Error('Condition timed out'); };
 await wait(()=>window.app?.plugins?.plugins?.piem?.agentService);
 if (app.vault.adapter.getBasePath() !== root+'/vault') throw new Error('Use a disposable vault at <output-dir>/vault.');
 report.environment = { mobile: app.isMobile, phone: document.body.classList.contains('is-phone'), width: innerWidth, obsidian: document.title.match(/Obsidian ([0-9.]+)/)?.[1] };
 record('correct official device mode', app.isMobile===expectMobile);
 if (expectMobile) record('official phone emulation', document.body.classList.contains('emulate-mobile') && report.environment.phone);
 const error = event => report.errors.push(String(event.error ?? event.reason ?? event.message));
 window.addEventListener('error',error); window.addEventListener('unhandledrejection',error);
 const audit = expectMobile ? observeNodeAccess('piem') : undefined;
 let plugin = app.plugins.plugins.piem;
 const reload = async () => { await app.plugins.unloadPlugin('piem'); await app.plugins.loadPlugin('piem'); await wait(()=>app.plugins.plugins.piem?.agentService); plugin=app.plugins.plugins.piem; await plugin.agentService.initialize(); };
 try {
  await reload();
  Object.assign(plugin.settings, {
   language:'zh-cn', networkTransport:'requestUrl',
   providers:[{id:'bridge-smoke',name:'Local smoke',baseUrl:endpoint+'/v1',protocol:'openai-completions',apiKey:'local-fixture-only',secretRef:'',source:'user',oauthFlow:''}],
   models:[{id:'smoke-alpha',providerId:'bridge-smoke',modelApiId:'alpha',displayName:'Alpha',reasoning:false,supportsImages:false},{id:'smoke-beta',providerId:'bridge-smoke',modelApiId:'beta',displayName:'Beta',reasoning:false,supportsImages:false}],
   activeModelId:'smoke-alpha',showAgentDetails:true
  });
  await plugin.saveSettings();
  await plugin.activateChatView();
  const service=plugin.agentService;
  await service.newSession();
  const a=service.getActiveSessionPath();
  const started=performance.now();
  record('real send completes',await service.sendPrompt('请切换到 Beta，继续整理周五笔记。'));
  record('active default saved',plugin.settings.activeModelId==='smoke-beta');
  record('runtime switched before next request',service.getSnapshot().runningModelId==='beta');
  record('original model tool reported success',JSON.stringify(service.getSnapshot().messages).includes('Switched to bridge-smoke/beta'));
  record('no chat error after switch',!service.getSnapshot().errorMessage);
  const context=await plugin.sessionManager.buildSessionContextFor(a);
  record('model choice persisted to same session',context.model.modelId==='beta');
  plugin.settings.activeModelId='smoke-alpha'; await plugin.saveSettings();
  record('handoff request completes',await service.sendPrompt('接着做，保留前面的决定。'));
  record('native continue command registered',!!app.commands.commands['piem:continue-task']);
  record('native continue command runs',app.commands.executeCommandById('piem:continue-task'));
  await wait(()=>service.getSnapshot().isStreaming);
  await wait(()=>{const rt=service.runtimes.get(a);return !service.getSnapshot().isStreaming && !rt.promptPreparations && !rt.sessionRefreshing && !rt.sessionOperations && service.getSnapshot().messages.filter(m=>m.role==='assistant').length>=4;});
  record('hidden continue marker persisted',(await plugin.sessionManager.buildSessionContextFor(a)).messages.some(m=>m.role==='custom'&&m.customType==='pi-invisible-continue:resume'&&m.display===false));
  record('hidden marker absent from rendered transcript',!document.querySelector('.piem-chat')?.textContent?.includes('pi-invisible-continue:resume'));
  const before=service.getSnapshot().messages.filter(m=>m.role==='assistant').length;
  record('slash continue completes',await service.sendPrompt('/continue'));
  record('continued without adding visible user text',service.getSnapshot().messages.filter(m=>m.role==='user').length===2);
  record('new assistant reply from continue',service.getSnapshot().messages.filter(m=>m.role==='assistant').length===before+1);
  // Preserve existing bookmark integration on the same shared host implementation.
  await service.runBookmark(a,'bookmark','桥接验证通过');
  record('bookmark still persists',(await service.listBookmarks(a))[0]?.label==='桥接验证通过');
  const registrations=plugin._events.length;
  for(let i=0;i<3;i++) {
   const oldService=plugin.agentService, oldRuntime=oldService.runtimes.get(a), oldHost=oldRuntime.communityHost;
   await reload();
   record('old service released runtimes '+i,oldService.runtimes.size===0);
   let stale=false;try{await oldHost.run('continue');}catch{stale=true;}
   record('old extension host rejects work '+i,stale);
   await plugin.agentService.openSession(a);
   record('bookmark restored '+i,(await plugin.agentService.listBookmarks(a))[0]?.label==='桥接验证通过');
   record('continue works after reload '+i,await plugin.agentService.runExtensionCommand('continue'));
   record('plugin listener count stable '+i,plugin._events.length===registrations);
   report.cycles.push({cycle:i+1,registrations:plugin._events.length});
  }
  const current=plugin.agentService;
  await current.newSession(); const b=current.getActiveSessionPath();
  record('empty conversation refuses continue',await current.runExtensionCommand('continue')===false);
  record('other conversation unchanged',current.getSnapshot().messages.length===0);
  await current.openSession(a);
  report.session={a,b};report.durationMs=Math.round(performance.now()-started);
  if(audit){
   record('negative Node controls refused',audit.report.controls.length===6&&audit.report.controls.every(item=>!item.provided));
   record('plugin only requests Obsidian',audit.report.requests.length>0&&audit.report.requests.every(item=>item.id==='obsidian'&&item.provided));
   record('all reload evaluations audited',audit.report.evaluations===4);
   record('no unexpected console errors',audit.report.consoleErrors.every(item=>item.control));
   report.nodeAccess=audit.report;
  }
  record('no renderer errors or unhandled rejections',report.errors.length===0);
  report.passed=true;
 } catch(cause) { report.failure=String(cause.stack??cause); }
 finally { audit?.restore();window.removeEventListener('error',error);window.removeEventListener('unhandledrejection',error); }
 return report;
}

const [port, directory, mode, ...extra] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !directory || (mode && mode!=='--expect-mobile') || extra.length) throw new Error('Usage: node scripts/smoke-community-obsidian.mjs <CDP-port> <output-dir> [--expect-mobile]');
const root=resolve(directory), mobile=mode==='--expect-mobile', requests=[];
await mkdir(root,{recursive:true});
let requestCount=0;
const server=createServer(async (req,res)=>{
 try {
  if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
  let text='';for await(const chunk of req){text+=chunk;if(text.length>2*1024*1024)throw new Error('Request too large');}
  const body=JSON.parse(text);
  const chat=body.tools?.some(tool=>tool.function.name==='switch_model');
  if(chat){requests.push(body);requestCount++;}
  const call=chat&&requestCount===1;
  const chunk={id:'chatcmpl-local-smoke',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:call?{tool_calls:[{index:0,id:'smoke-switch',type:'function',function:{name:'switch_model',arguments:JSON.stringify({action:'switch',search:'beta'})}}]}:{content:chat?`${body.model}：周五整理笔记，保留原始资料。`:'[]'},finish_reason:null}]};
  const done={...chunk,choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:15,completion_tokens:10,total_tokens:25}};
  // Let the real UI enter streaming so native-command lifecycle can be observed.
  await new Promise(resolve=>setTimeout(resolve,80));
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
 } catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let socket,timer;
const waiters=new Map();let nextId=0;
try {
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(5000)})).json();
 const target=targets.find(item=>item.type==='page'&&item.url.startsWith('app://'));
 if(!target)throw new Error('No Obsidian page.');
 socket=new WebSocket(target.webSocketDebuggerUrl);
 socket.addEventListener('message',event=>{const msg=JSON.parse(event.data);const w=waiters.get(msg.id);if(!w)return;waiters.delete(msg.id);msg.error?w.reject(new Error(JSON.stringify(msg.error))):w.resolve(msg.result);});
 timer=setTimeout(()=>{for(const w of waiters.values())w.reject(new Error('Smoke timed out'));socket.close();},50000);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId;waiters.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const endpoint=`http://127.0.0.1:${server.address().port}`;
 const result=await send('Runtime.evaluate',{expression:`(${runSmoke.toString()})(${JSON.stringify(root)},${JSON.stringify(endpoint)},${mobile},${observePluginNodeAccess.toString()})`,awaitPromise:true,returnByValue:true});
 if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
 const report=result.result.value;
 const artifact=await readFile(resolve(root,'vault/.obsidian/plugins/piem/main.js'));
 report.artifactSha256=createHash('sha256').update(artifact).digest('hex');report.bytes=artifact.length;
 report.requests=requests.map(body=>({model:body.model,messages:body.messages,tools:body.tools?.map(tool=>tool.function.name)}));
 const wireChecks=[
  ['next protocol request switches model',requests[0]?.model==='alpha'&&requests[1]?.model==='beta'],
  ['provenance appears only in later request',JSON.stringify(requests[2]?.messages??[]).includes('bridge-smoke/beta')],
  ['hidden continuation never reaches provider',requests.every(body=>!JSON.stringify(body.messages).includes('pi-invisible-continue'))],
  ['original tool is registered',requests.every(body=>body.tools?.some(tool=>tool.function.name==='switch_model'))],
  ['no repeated visible user prompt',requests.slice(2).every(body=>body.messages.filter(message=>message.role==='user').length===requests[2].messages.filter(message=>message.role==='user').length)],
 ];
 for(const[name,passed]of wireChecks){if(passed)report.checks.push(name);else{report.passed=false;report.failure??=name;}}
 const filename=mobile?'community-mobile.json':'community-desktop.json';
 await writeFile(resolve(root,filename),JSON.stringify(report,null,2));
 const shot=await send('Page.captureScreenshot',{format:'png'});
 await writeFile(resolve(root,mobile?'community-mobile.png':'community-desktop.png'),Buffer.from(shot.data,'base64'));
 console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,requests:requests.length,environment:report.environment,artifactSha256:report.artifactSha256,result:resolve(root,filename),failure:report.failure}));
 if(!report.passed)process.exitCode=1;
} finally {
 clearTimeout(timer);socket?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
