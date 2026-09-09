import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Opt-in research probe; run with Bun. Imports the real Piem session code, but is never shipped.
// The argument is an isolated directory with the pinned official packages installed.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencies = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || dependencies === repo) throw new Error('Pass an isolated dependency directory.');
const packageRoot = path.join(dependencies, 'node_modules/@earendil-works/pi-coding-agent');
for (const base of [repo, dependencies]) {
  for (const name of ['pi-agent-core', 'pi-ai']) {
    const metadata = JSON.parse(readFileSync(path.join(base, 'node_modules/@earendil-works', name, 'package.json'), 'utf8'));
    assert.equal(metadata.version, '0.84.3', 'This probe targets Pi 0.84.3; re-audit before changing it.');
  }
}
const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
assert.equal(metadata.version, '0.84.3');
const cleanups = [];
const originalFetch = globalThis.fetch;
cleanups.push(() => { globalThis.fetch = originalFetch; });
try {
	let outboundRequests = 0;
	globalThis.fetch = async () => { outboundRequests++; throw new Error('Network disabled for research'); };
	const { ObsidianSessionManager } = await import(pathToFileURL(path.join(repo, 'src/session/ObsidianSessionManager.ts')).href);
	const { MemoryAdapter } = await import(pathToFileURL(path.join(repo, 'src/testUtils/memoryAdapter.ts')).href);
	const { stubWindowTimers } = await import(pathToFileURL(path.join(repo, 'src/testUtils/windowStub.ts')).href);
	const { Agent } = await import(pathToFileURL(path.join(repo, 'node_modules/@earendil-works/pi-agent-core/dist/index.js')).href);
	const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(repo, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);
	const sdk = await import(pathToFileURL(path.join(packageRoot, metadata.exports['.'].import)).href);
	const officialFiles = [
	  'dist/core/extensions/loader.js', 'dist/core/extensions/runner.js', 'dist/core/extensions/wrapper.js',
	  'examples/extensions/bookmark.ts', 'examples/extensions/model-status.ts', 'examples/extensions/todo.ts',
	];
	const digest = (file) => createHash('sha256').update(readFileSync(path.join(packageRoot, file))).digest('hex');
	const before = Object.fromEntries(officialFiles.map(file => [file, digest(file)]));
	const { loadExtensionFromFactory } = await import(pathToFileURL(path.join(packageRoot, 'dist/core/extensions/loader.js')).href);
	const bookmarkFactory = (await import(pathToFileURL(path.join(packageRoot, 'examples/extensions/bookmark.ts')).href)).default;
	const modelStatusFactory = (await import(pathToFileURL(path.join(packageRoot, 'examples/extensions/model-status.ts')).href)).default;
	const todoFactory = (await import(pathToFileURL(path.join(packageRoot, 'examples/extensions/todo.ts')).href)).default;
	cleanups.push(stubWindowTimers());
	const results = {};
	const model = { id: 'probe', api: 'openai-completions', provider: 'probe', contextWindow: 32000, maxTokens: 1000 };
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const defaults = { provider: 'probe', modelId: 'probe', thinkingLevel: 'off' };
	const assistant = (text) => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text }], usage, timestamp: Date.now(), stopReason: 'stop' });
	const unsupported = (name) => () => { throw new Error('Not supplied by this probe: '+name); };
	const adapter = new MemoryAdapter();
	const manager = new ObsidianSessionManager(adapter, 'Piem/chats', 'piem');
	const sessionA = await manager.createSession(defaults);
	const answerA = await manager.appendMessageFor(sessionA.path, assistant('Answer A'));
	const sessionB = await manager.createSession(defaults);
	const answerB = await manager.appendMessageFor(sessionB.path, assistant('Answer B'));
	const ownerSession = manager.getSessionFor(sessionA.path);
	let entries = [];
	let branch = [];
	let labels = new Map();
	async function hydrate() {
	  entries = await ownerSession.findEntries({ order:'oldestFirst' });
	  branch = await ownerSession.findEntriesOnBranch({ order:'oldestFirst' });
	  labels = new Map(await Promise.all(entries.map(async (entry) => [entry.id, await ownerSession.getLabel(entry.id)])));
	}
	await hydrate();
	// This is a data projection over the existing official Session, not another session engine.
	const sessionReadView = {
	  getEntries: () => structuredClone(entries),
	  getBranch: () => structuredClone(branch),
	  getLabel: (id) => labels.get(id),
	};
	const seenModelMembers = [];
	const modelRegistry = new Proxy({}, { get(_target, name) { seenModelMembers.push(String(name)); throw new Error('Unexpected model registry member: '+String(name)); } });
	const eventBus = sdk.createEventBus();
	const runtime = sdk.createExtensionRuntime();
	const extensions = [];
	for (const [name, factory] of [['bookmark',bookmarkFactory],['model-status',modelStatusFactory],['todo',todoFactory]]) {
	  extensions.push(await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime, '<official:'+name+'>'));
	}
	const runner = new sdk.ExtensionRunner(extensions, runtime, process.cwd(), sessionReadView, modelRegistry);
	let pendingWrites = [];
	let pendingNotices = [];
	const visibleNotices = [];
	const statuses = [];
	const errors = [];
	let callScope = false;
	let agent;
	runner.bindCore({
	  sendMessage: unsupported('sendMessage'), sendUserMessage: unsupported('sendUserMessage'), appendEntry: unsupported('appendEntry'),
	  setSessionName: unsupported('setSessionName'), getSessionName: () => undefined,
	  setLabel: (id, label) => {
	    assert(callScope, 'Mutations require a host invocation scope');
	    pendingWrites.push(() => ownerSession.setLabel(id,label));
	    labels.set(id,label);
	  },
	  getActiveTools: () => ['todo'], getAllTools: unsupported('getAllTools'), setActiveTools: unsupported('setActiveTools'), refreshTools: unsupported('refreshTools'),
	  getCommands: () => runner.getRegisteredCommands(), setModel: unsupported('setModel'), getThinkingLevel: () => 'off', setThinkingLevel: unsupported('setThinkingLevel'),
	}, {
	  getModel: () => model, getScopedModels: () => [], isIdle: () => !agent?.state.isStreaming, isProjectTrusted: () => true,
	  getSignal: () => agent?.signal, abort: () => agent?.abort(), hasPendingMessages: () => false,
	  shutdown: unsupported('shutdown'), getContextUsage: () => undefined, compact: unsupported('compact'), getSystemPrompt: () => '',
	}, { registerProvider: unsupported('registerProvider'), registerNativeProvider: unsupported('registerNativeProvider'), unregisterProvider: unsupported('unregisterProvider') });
	runner.setUIContext({
	  notify: (text) => { if(callScope) pendingNotices.push(text); else visibleNotices.push(text); },
	  setStatus: (_key, value) => { statuses.push(value); },
	}, 'print');
	cleanups.push(() => runner.invalidate('Probe disposed'));
	cleanups.push(runner.onError((error) => errors.push(error)));
	async function command(name, args = '') {
	  await hydrate();
	  callScope = true;
	  pendingWrites = []; pendingNotices = [];
	  try {
	    await runner.getCommand(name).handler(args,runner.createCommandContext());
	    for (const write of pendingWrites) await write();
	    visibleNotices.push(...pendingNotices);
	  } finally {
	    pendingWrites = []; pendingNotices = []; callScope = false;
	    await hydrate();
	  }
	}
	await command('bookmark', 'A saved');
	assert.equal(await ownerSession.getLabel(answerA), 'A saved');
	assert.equal(await manager.getSessionFor(sessionB.path).getLabel(answerB), undefined);
	assert.equal(manager.getActiveSessionPath(),sessionB.path);
	const reloaded = new ObsidianSessionManager(adapter, 'Piem/chats', 'piem');
	await reloaded.loadSession(sessionA.path);
	assert.equal(await reloaded.getSessionFor(sessionA.path).getLabel(answerA), 'A saved');
	results.bookmarkPersistsViaExistingPiemSession = true;
	results.backgroundSessionOwnerIsCorrect = true;
	results.reopenPreservesLabel = true;
	await command('unbookmark');
	assert.equal(await ownerSession.getLabel(answerA),undefined);
	results.unbookmarkPersists = true;
	// The original bookmark notifies before async storage settles; the host defers display.
	const appendOriginal=adapter.append.bind(adapter);
	const beforeNoticeCount=visibleNotices.length;
	cleanups.push(() => { adapter.append = appendOriginal; });
	adapter.append=async (target,data) => { if(target===sessionA.path) throw new Error('Injected adapter append failure'); await appendOriginal(target,data); };
	await assert.rejects(()=>command('bookmark','must not claim saved'));
	adapter.append=appendOriginal;
	assert.equal(visibleNotices.length,beforeNoticeCount);
	assert.equal(await ownerSession.getLabel(answerA),undefined);
	results.persistenceFailureDoesNotPublishSuccess = true;
	await runner.emit({type:'model_select',model,previousModel:undefined,source:'restore'});
	assert.equal(statuses.at(-1),'🤖 probe');
	assert.deepEqual(seenModelMembers,[]);
	results.originalModelStatusAndNoModelRegistryReads = true;
	const tools=sdk.wrapRegisteredTools(runner.getAllRegisteredTools(),runner);
	const script=[{action:'add',text:'Original tool through Piem'},{action:'toggle',id:1},{action:'list'}];
	let requests=0;
	agent=new Agent({initialState:{model,tools,messages:[]},streamFn:()=>{
	  const step=requests++;
	  const stream=createAssistantMessageEventStream();
	  const reason=step<script.length?'toolUse':'stop';
	  const message={...assistant('Done'),stopReason:reason,content:step<script.length?[{type:'toolCall',id:'call-'+step,name:'todo',arguments:script[step]}]:[{type:'text',text:'Done'}]};
	  stream.push({type:'done',reason,message});stream.end();return stream;
	}});
	cleanups.push(() => agent.abort());
	cleanups.push(agent.subscribe(async(event)=>{if(event.type==='message_end')await manager.appendMessageFor(sessionA.path,event.message);}));
	await agent.prompt('Exercise original todo');
	assert.equal(requests,4);
	assert.equal(agent.state.messages.filter(m=>m.role==='toolResult').length,3);
	assert.equal(agent.state.isStreaming,false);
	results.originalTodoToolThroughRealAgent = 3;
	const nextManager = new ObsidianSessionManager(adapter, 'Piem/chats', 'piem');
	await nextManager.loadSession(sessionA.path);
	const storedEntries=await nextManager.getSessionFor(sessionA.path).findEntriesOnBranch({order:'oldestFirst'});
	const todoResults=storedEntries.filter(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='todo');
	assert.equal(todoResults[0].message.details.todos[0].done,false);
	assert.equal(todoResults.at(-1).message.details.todos[0].done,true);
	const firstLiveResult=agent.state.messages.find(message=>message.role==='toolResult');
	assert.equal(firstLiveResult.details.todos[0].done,true);
	results.originalTodoMutatesEarlierLiveResult = true;
	results.persistedResultSnapshotsRemainUnchanged = true;
	await hydrate();
	await runner.emit({type:'session_start'});
	const restoredTodo=await tools[0].execute('restore',{action:'list'});
	assert.equal(restoredTodo.details.todos[0].done,true);
	results.originalTodoRestoresFromPiemLog = true;
	await command('todos');
	assert.equal(visibleNotices.at(-1),'/todos requires interactive mode');
	results.originalTodoUiRejectsPrintMode = true;
	const heldContext=runner.createContext();
	runner.invalidate('Probe disposed');
	assert.throws(()=>heldContext.sessionManager,/Probe disposed/);
	runner.invalidate('Again');
	results.staleContextRejected = true;
	assert.deepEqual(errors,[]);
	assert.equal(outboundRequests,0);
	assert.deepEqual(Object.fromEntries(officialFiles.map(file=>[file,digest(file)])),before);
	results.officialFilesUnmodified = before;
	results.networkRequests = outboundRequests;
	results.limit = 'Bun/Node research host, real Piem session code with MemoryAdapter. Partial structural session/UI seam; no production typecheck, full agent-service integration, Obsidian layout, disk sync, or phone device.';
	writeFileSync(path.join(dependencies, 'host-integration-results.json'),JSON.stringify(results,null,2)+'\n');
	console.log(JSON.stringify(results,null,2));

} finally {
  for (const cleanup of cleanups.reverse()) cleanup();
}
