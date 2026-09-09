import { createRequire, builtinModules } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
// Opt-in bundle diagnosis. The isolated install is input; results stay there.
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencies=path.resolve(process.argv[2] ?? '');
if(!process.argv[2] || dependencies===repo) throw new Error('Pass an isolated dependency directory.');
const esbuild=await import(pathToFileURL(path.join(repo,'node_modules/esbuild/lib/main.js')).href);
const packageRoot=path.join(dependencies,'node_modules/@earendil-works/pi-coding-agent');
assert.equal(JSON.parse(readFileSync(path.join(packageRoot,'package.json'),'utf8')).version,'0.84.3');
const rootSource=`import { ExtensionRunner, createExtensionRuntime, createEventBus, wrapRegisteredTools } from '@earendil-works/pi-coding-agent';
import { loadExtensionFromFactory } from ${JSON.stringify(path.join(packageRoot,'dist/core/extensions/loader.js'))};
import bookmark from ${JSON.stringify(path.join(packageRoot,'examples/extensions/bookmark.ts'))};
globalThis.PiemOfficialHostProbe = { ExtensionRunner, createExtensionRuntime, createEventBus, wrapRegisteredTools, loadExtensionFromFactory, bookmark };`;
const directSource=`import { ExtensionRunner } from ${JSON.stringify(path.join(packageRoot,'dist/core/extensions/runner.js'))};
import { createExtensionRuntime, loadExtensionFromFactory } from ${JSON.stringify(path.join(packageRoot,'dist/core/extensions/loader.js'))};
import { createEventBus } from ${JSON.stringify(path.join(packageRoot,'dist/core/event-bus.js'))};
import { wrapRegisteredTools } from ${JSON.stringify(path.join(packageRoot,'dist/core/extensions/wrapper.js'))};
import bookmark from ${JSON.stringify(path.join(packageRoot,'examples/extensions/bookmark.ts'))};
globalThis.PiemOfficialHostProbe = { ExtensionRunner, createExtensionRuntime, createEventBus, wrapRegisteredTools, loadExtensionFromFactory, bookmark };`;
const external=[...new Set(builtinModules.flatMap(name=>[name,name.startsWith('node:')?name:'node:'+name]))];
const results=[];
for(const [name,source] of [['public',rootSource],['internal',directSource]]) {
  try {
    const result=await esbuild.build({stdin:{contents:source,resolveDir:dependencies,sourcefile:name+'.ts',loader:'ts'},bundle:true,write:false,metafile:true,external,format:'cjs',platform:'browser',target:'es2018',treeShaking:true,minify:true,logLevel:'silent'});
    const code=result.outputFiles[0].text;
    writeFileSync(path.join(dependencies,name+'.cjs'),code);
    writeFileSync(path.join(dependencies,name+'.meta.json'),JSON.stringify(result.metafile));
    const imports=Object.values(result.metafile.outputs)[0].imports;
    const contribution=Object.values(result.metafile.outputs)[0].inputs;
    const facts={name,build:'ok',bytes:result.outputFiles[0].contents.byteLength,warnings:result.warnings.map(w=>({text:w.text,file:w.location?.file,line:w.location?.line})),imports,contributionCount:Object.entries(contribution).filter(([,n])=>n.bytesInOutput>0).length,includes:{jiti:Object.entries(contribution).some(([n,v])=>n.includes('/jiti/')&&v.bytesInOutput>0),tui:Object.entries(contribution).some(([n,v])=>n.includes('/pi-tui/')&&v.bytesInOutput>0),providers:Object.entries(contribution).some(([n,v])=>n.includes('/pi-ai/dist/providers/')&&v.bytesInOutput>0)}};
    for(const platform of ['desktop','mobile']) {
      const requested=[];
      const hostRequire=createRequire(path.join(dependencies,'package.json'));
      const timers=new Set();
      const intervals=new Set();
      const trackedTimeout=(fn,delay,...args)=>{const id=setTimeout(()=>{timers.delete(id);fn(...args);},delay);timers.add(id);return id;};
      const trackedInterval=(fn,delay,...args)=>{const id=setInterval(fn,delay,...args);intervals.add(id);return id;};
      const sandbox={module:{exports:{}},exports:{},console:{log(){},warn(){},error(){}},Buffer,TextEncoder,TextDecoder,URL,AbortController,process:platform==='desktop'?process:undefined,setTimeout:trackedTimeout,clearTimeout:id=>{timers.delete(id);clearTimeout(id);},setInterval:trackedInterval,clearInterval:id=>{intervals.delete(id);clearInterval(id);},queueMicrotask,fetch:async()=>{throw new Error('Network disabled')},require:id=>{requested.push(id);if(platform==='mobile')throw new Error('No Node builtin: '+id);return hostRequire(id)}};
      if(platform==='desktop') sandbox.global=sandbox;
      try { vm.runInNewContext(code,sandbox,{timeout:2500});facts[platform]={loaded:!!sandbox.PiemOfficialHostProbe,requested}; }
      catch(error){facts[platform]={loaded:false,error:error.name+': '+error.message,requested};}
      finally {for(const id of timers)clearTimeout(id);for(const id of intervals)clearInterval(id);}
    }
    results.push(facts);
  } catch(error) {
    results.push({name,build:'failed',errors:error.errors?.map(e=>({text:e.text,file:e.location?.file,line:e.location?.line})),warnings:error.warnings?.map(w=>({text:w.text,file:w.location?.file,line:w.location?.line}))});
  }
}
writeFileSync(path.join(dependencies,'bundle-integration-results.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
