// Execute the real public WASM analytics in a worker-like VM (not a browser test).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../docs/',import.meta.url));
test('published HTML and worker imports carry matching content versions',()=>{
  const version=name=>createHash('sha256').update(readFileSync(resolve(root,name))).digest('hex').slice(0,16);
  for(const name of ['index.html','admin.html']){
    const html=readFileSync(resolve(root,name),'utf8');
    const assets=[...html.matchAll(/(?:src|href)="\.\/([^"?]+\.(?:js|css))(?:\?v=([a-f0-9]+))?"/g)];
    assert.ok(assets.length>0);
    for(const [,asset,hash]of assets)assert.equal(hash,version(asset),asset);
  }
  for(const [file,child]of [['pages-client.js','pages-worker.js'],['pages-worker.js','pages-data.js']])
    assert.ok(readFileSync(resolve(root,file),'utf8').includes(`./${child}?v=${version(child)}`));
});
test('worker serves presets and community shards without loading SQLite, with custom fallback',async()=>{
  let serial=0;const pending=new Map(),progress=[],fetched=[],imports=[];
  const context=vm.createContext({console,URL,URLSearchParams,TextDecoder,TextEncoder,Response,Blob,Uint8Array,AbortController,DecompressionStream,
    setTimeout,clearTimeout,WorkerGlobalScope:class{},location:{href:'https://example.test/housing/pages-worker.js'},
    fetch:async (input,options)=>{
      const url=new URL(input,'https://example.test/housing/pages-worker.js');
      fetched.push(url.pathname);
      assert.equal(url.origin,'https://example.test');
      if(url.pathname.endsWith('/meta.json'))assert.equal(options.cache,'no-store');
      if(url.pathname.endsWith('.gz')){assert.equal(options.cache,'force-cache');assert.match(url.searchParams.get('v'),/^[a-f0-9]{64}$/);}
      const path=resolve(root,url.pathname.replace(/^\/housing\//,''));
      assert.ok(path.startsWith(root));
      const bytes=readFileSync(path);return new Response(bytes,{headers:{'content-type':path.endsWith('.wasm')?'application/wasm':'application/octet-stream','content-length':String(bytes.length)}});
    },
    postMessage:r=>{if(r.progress!==undefined){progress.push(r.progress);return;}const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(Error(r.error)):p.resolve(structuredClone(r.value));}
  });
  context.self=context;
  context.importScripts=(...paths)=>paths.forEach(path=>{imports.push(path);vm.runInContext(readFileSync(resolve(root,path.split('?')[0]),'utf8'),context,{filename:path});});
  vm.runInContext(readFileSync(resolve(root,'pages-worker.js'),'utf8'),context);
  const call=(method,params='')=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});context.onmessage({data:{id,method,params}});});
  const initializing=call('initialize');
  const analyzing=call('analyze','level=district&limit=500');
  const meta=await initializing,result=await analyzing;
  assert.equal(meta.date_max,'2025-08-31');assert.equal(meta.cleaning.kept_rows,445034);
  assert.ok(progress.some(p=>p.includes('无需下载整库')));
  assert.ok(result.rows.length>3);assert.ok(result.rows.length<=500);assert.equal(result.config.limit,500);
  assert.ok(result.rows.every(r=>r.current_volume>=10&&r.base_volume>=10));
  await assert.rejects(call('unknown'),/Unknown calculation/);
  const trend=await call('trend');assert.ok(trend.points.length>0);
  const communities=await call('searchCommunities','q=阳光南里');assert.ok(communities.results.length);
  const item=communities.results[0];
  const details=await call('communityDetail',new URLSearchParams({district:item.district,business_area:item.business_area,community:item.community}).toString());
  assert.ok(details.transactions.length);assert.ok(details.transactions.every(t=>t.sale_date<='2025-08-31'));
  assert.ok(!fetched.some(p=>p.includes('sqlite3')||p.includes('wasm')));
  assert.ok(!imports.some(p=>p.includes('wasm')));
  const before=fetched.length;
  await call('communityDetail',new URLSearchParams({district:item.district,business_area:item.business_area,community:item.community,metric:'p30'}).toString());
  assert.equal(fetched.length,before,'same community reuses its shard');
  const custom=await call('analyze','metric=mean&level=district');
  assert.equal(custom.config.metric,'mean');
  assert.equal(fetched.filter(p=>p.endsWith('transactions.sqlite3.gz')).length,1);
  await call('analyze','metric=p30&district=朝阳');assert.equal(fetched.filter(p=>p.endsWith('transactions.sqlite3.gz')).length,1);
});

test('worker client routes concurrent responses, progress, and loading errors',async()=>{
  let worker;class TestWorker{constructor(url){assert.equal(url,'./pages-worker.js');worker=this;}messages=[];postMessage(m){this.messages.push(m);}terminate(){}}
  const context=vm.createContext({Worker:TestWorker,window:{},setTimeout,clearTimeout});
  vm.runInContext(readFileSync(new URL('../static/pages-client.js',import.meta.url),'utf8'),context);
  const data=context.window.DashboardData,progress=[];
  const initialization=data.initialize(v=>progress.push(v)),analysis=data.analyze(new URLSearchParams('limit=500'));
  worker.onmessage({data:{id:1,progress:'50%'}});worker.onmessage({data:{id:2,value:{rows:[]}}});worker.onmessage({data:{id:1,value:{ready:true}}});
  assert.deepEqual(progress,['50%']);assert.equal((await initialization).ready,true);assert.deepEqual(await analysis,{rows:[]});
  assert.equal(worker.messages[1].params,'limit=500');
  const failure=data.trend(new URLSearchParams());worker.onerror();await assert.rejects(failure,/后台计算加载失败/);await assert.rejects(data.analyze(),/后台计算加载失败/);
});

test('unresponsive worker rejects concurrent requests and a retry creates a fresh worker',async()=>{
  const workers=[],timers=new Map();let timerId=0;
  class TestWorker{constructor(){workers.push(this);}messages=[];postMessage(m){this.messages.push(m);}terminate(){this.terminated=true;}}
  const context=vm.createContext({Worker:TestWorker,window:{},setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(readFileSync(new URL('../static/pages-client.js',import.meta.url),'utf8'),context);
  const data=context.window.DashboardData;
  const a=assert.rejects(data.analyze(),/后台计算超时/),b=assert.rejects(data.trend(),/后台计算超时/);
  assert.equal(workers.length,1);assert.equal(timers.get(1).ms,240000);
  timers.get(1).fn();await Promise.all([a,b]);assert.equal(timers.size,0);assert.equal(workers[0].terminated,true);
  const retry=data.analyze();assert.equal(workers.length,2);
  workers[0].onmessage({data:{id:1,value:'late'}});workers[0].onerror();
  workers[1].onmessage({data:{id:3,value:{rows:[]}}});assert.deepEqual(await retry,{rows:[]});assert.equal(timers.size,0);
});
