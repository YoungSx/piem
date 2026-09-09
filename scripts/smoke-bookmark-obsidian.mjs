/**
 * Opt-in smoke against a real, isolated Obsidian instance. No model/key needed.
 * Usage: node scripts/smoke-bookmark-obsidian.mjs <CDP-port> <output-directory>
 * The vault must be <output-directory>/vault, with the built plugin installed.
 * Leaves its fixture chats and results.json in that directory for inspection.
 */
import { resolve } from "node:path";

async function runSmoke(root) {
 if (app.vault.adapter.getBasePath() !== root + '/vault') throw new Error('Use an isolated smoke vault at <output-dir>/vault.');
 const fs=require('node:fs/promises');
 const crypto=require('node:crypto');
 const cp=require('node:child_process');
 const report={checks:[],errors:[],cycles:[],versions:{obsidian:document.title.match(/Obsidian ([0-9.]+)/)?.[1],electron:process.versions.electron,node:process.versions.node,chrome:process.versions.chrome}};
 const record=(name,value)=>{if(!value)throw new Error(name);report.checks.push(name);};
 const wait=async test=>{for(let i=0;i<200;i++){if(await test())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Condition timed out');};
 const error=e=>report.errors.push(String(e.error??e.reason??e.message));
 window.addEventListener('error',error);window.addEventListener('unhandledrejection',error);
 const spawn=cp.spawn;let spawnCalls=0;cp.spawn=(...args)=>{spawnCalls++;throw new Error('Unexpected process spawn');};
 const handles=()=>process._getActiveHandles().map(x=>x.constructor?.name).filter(x=>['ChildProcess','FSWatcher','FSEvent'].includes(x)).sort();
 const startHandles=handles();
 const oldFetch=window.fetch;let fetchCalls=0;window.fetch=(...args)=>{fetchCalls++;return oldFetch(...args);};
 await wait(()=>app.plugins.plugins.piem?.bookmarkDialogs);
 let plugin=app.plugins.plugins.piem;
 const message=text=>({role:'assistant',content:[{type:'text',text}],api:'openai-completions',provider:'test',model:'test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
 const defaults={provider:'test',modelId:'test',thinkingLevel:'off'};
 const reload=async()=>{await app.plugins.unloadPlugin('piem');await app.plugins.loadPlugin('piem');await wait(()=>app.plugins.plugins.piem?.bookmarkDialogs && app.commands.commands['piem:bookmark-reply']);plugin=app.plugins.plugins.piem;await plugin.agentService.initialize();return plugin;};
 const command=id=>record('command '+id,app.commands.executeCommandById('piem:'+id));
 const input=()=>document.querySelector('.modal input[type=text]');
 const button=()=>[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='保存书签');
 const type=value=>{input().value=value;input().dispatchEvent(new Event('input',{bubbles:true}));};
 const dismiss=()=>document.querySelector('.modal-header-button,.modal-close-button')?.click();
 const labels=path=>plugin.agentService.listBookmarks(path);
 let originalAppend;
 try {
  record('plugin ready',!!plugin?.agentService); for(const modal of [...plugin.bookmarkDialogs.openModals])modal.close();
  plugin.settings.language='zh-cn';await plugin.saveSettings({reconfigure:false});await reload();
  await plugin.activateChatView();
  const manager=plugin.sessionManager, service=plugin.agentService;
  const a=await manager.createSession(defaults);await manager.appendMessageFor(a.path,{role:'user',content:[{type:'text',text:'请记下这个决定'}],timestamp:Date.now()});
  const aId=await manager.appendMessageFor(a.path,message('决定：周五整理笔记，保留原始资料。\n这条回复用于验证官方 Pi 书签。'));
  const b=await manager.createSession(defaults);const bId=await manager.appendMessageFor(b.path,message('第二段对话，书签不能误写到这里。'));
  await service.openSession(a.path);
  record('Chinese command registered',app.commands.commands['piem:bookmark-reply'].name.includes('书签'));
  command('bookmark-reply');await wait(()=>input());
  record('native modal focuses label',document.activeElement===input());
  type('周五整理');await service.openSession(b.path);button().click();
  await wait(()=>!input());
  record('captured dialog owner saved', (await labels(a.path)).some(x=>x.entryId===aId&&x.label==='周五整理'));
  record('other conversation untouched',(await labels(b.path)).length===0);
  await service.openSession(a.path);command('view-bookmarks');await wait(()=>document.querySelector('.suggestion-item'));
  const search=document.querySelector('.prompt-input');record('search modal opened',!!search);
  search.value='周五';search.dispatchEvent(new Event('input',{bubbles:true}));await wait(()=>document.querySelector('.suggestion-item')?.textContent.includes('周五整理'));
  document.querySelector('.suggestion-item').click();await wait(()=>document.querySelector('.piem-bookmark-text'));
  record('picker opens persisted reply',document.querySelector('.piem-bookmark-text').textContent.includes('周五整理笔记'));
  dismiss();
  originalAppend=app.vault.adapter.append;
  app.vault.adapter.append=async function(path,data,...rest){if(path===a.path&&data.includes('"fact":"label"'))throw new Error('Smoke disk full');return originalAppend.call(this,path,data,...rest);};
  command('bookmark-reply');await wait(()=>input());type('失败后重试');button().click();await wait(()=>document.querySelector('.modal [role=alert]')?.textContent.includes('Smoke disk full'));
  record('write failure stays editable',input().value==='失败后重试'&&!button().disabled);
  app.vault.adapter.append=originalAppend;originalAppend=undefined;button().click();await wait(()=>!input());
  record('retry persists',(await labels(a.path))[0]?.label==='失败后重试');
  const fork=await manager.forkSession(a.path,aId);
  record('fork keeps label',await manager.getSessionFor(fork.path).getLabel(aId)==='失败后重试');
  const another=new manager.constructor(app.vault.adapter,'Piem/chats','piem');await another.loadSession(a.path);await another.getSessionFor(a.path).setLabel(aId,'另一设备的标签');
  record('label-only sync visible',(await labels(a.path))[0]?.label==='另一设备的标签');
  command('unbookmark-reply');await wait(async()=>(await labels(a.path)).length===0);
  record('original remove command persists',(await labels(a.path)).length===0);
  await service.runBookmark(a.path,'bookmark','重载后仍在');
  const initialEvents=plugin._events.length;
  for(let i=0;i<3;i++){
   const old=plugin,oldService=plugin.agentService,dialogs=plugin.bookmarkDialogs;
   command('bookmark-reply');await wait(()=>input());const oldInput=input();
   await reload();
   record('unload disposes host '+i,oldService.runtimes.size===0&&old.agentService===null);
   record('unload closes dialogs '+i,!oldInput.isConnected&&dialogs.openModals.size===0);
   await plugin.agentService.openSession(a.path);
   record('reload preserves label '+i,(await labels(a.path))[0]?.label==='重载后仍在');
   record('plugin listeners stable '+i,plugin._events.length===initialEvents);
   report.cycles.push({cycle:i+1,eventRegistrations:plugin._events.length,handles:handles()});
  }
  const s=plugin.agentService;
  await s.openSession(b.path);
  let release,entered;
  const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);
  originalAppend=app.vault.adapter.append;
  app.vault.adapter.append=async function(path,data,...rest){if(path===b.path&&data.includes('"fact":"label"')){entered();await gate;}return originalAppend.call(this,path,data,...rest);};
  const saving=s.runBookmark(b.path,'bookmark','即将删除');const rejected=saving.catch(()=>undefined);await start;
  const deleting=s.deleteSession(b.path);release();await rejected;await deleting;
  app.vault.adapter.append=originalAppend;originalAppend=undefined;
  record('save then delete cannot resurrect file',!await app.vault.adapter.exists(b.path));
  await s.openSession(a.path);
  const content=await fs.readFile(root+'/vault/.obsidian/plugins/piem/main.js');report.artifactSha256=crypto.createHash('sha256').update(content).digest('hex');report.bytes=content.length;
  report.startHandles=startHandles;report.finalHandles=handles();report.spawnCalls=spawnCalls;report.browserFetchCalls=fetchCalls;
  record('no subprocess created',spawnCalls===0);
  record('no new child or watcher handles',JSON.stringify(startHandles)===JSON.stringify(handles()));
  record('no renderer errors or unhandled rejections',report.errors.length===0);
  report.paths={a:a.path,b:b.path,fork:fork.path};report.passed=true;
  window.__bookmarkSmoke=report;
  return report;
 } catch(cause){report.failure=String(cause.stack??cause);window.__bookmarkSmoke=report;throw cause;}
 finally {if(originalAppend)app.vault.adapter.append=originalAppend;cp.spawn=spawn;window.fetch=oldFetch;window.removeEventListener('error',error);window.removeEventListener('unhandledrejection',error);await fs.writeFile(root+'/results.json',JSON.stringify(report,null,2));}
}

const [port, outputDirectory] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !outputDirectory) throw new Error("Usage: node scripts/smoke-bookmark-obsidian.mjs <CDP-port> <output-directory>");
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const target = targets.find(item => item.type === "page" && item.url.startsWith("app://"));
if (!target) throw new Error("No Obsidian page on this debugging port.");
const socket = new WebSocket(target.webSocketDebuggerUrl);
const waiters = new Map();
let nextId = 0;
socket.addEventListener("message", event => {
 const message = JSON.parse(event.data);
 const waiter = waiters.get(message.id);
 if (!waiter) return;
 waiters.delete(message.id);
 message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
});
const timeout = setTimeout(() => {
 for (const waiter of waiters.values()) waiter.reject(new Error("Obsidian smoke timed out."));
 socket.close();
}, 45000);
try {
 await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
 });
 const result = await new Promise((resolveResult, reject) => {
  const id = ++nextId;
  waiters.set(id, { resolve: resolveResult, reject });
  socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {
   expression: `(${runSmoke.toString()})(${JSON.stringify(resolve(outputDirectory))})`, awaitPromise: true, returnByValue: true,
  } }));
 });
 if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
 const report = result.result.value;
 if (!report.passed) throw new Error("Smoke did not pass.");
 console.log(JSON.stringify({ passed: true, checks: report.checks.length, artifactSha256: report.artifactSha256, results: resolve(outputDirectory, "results.json") }));
} finally {
 clearTimeout(timeout);
 socket.close();
}
