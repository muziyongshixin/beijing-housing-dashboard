// Compare the shipped fast path against the actual original SQL computation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const root=resolve('docs'),require=createRequire(import.meta.url);
const SQL=await require(resolve(root,'vendor/sql-wasm.js'))();
function runtime(fast=true){
  const fetched=[];
  const ctx=vm.createContext({console,URLSearchParams,TextDecoder,TextEncoder,Uint8Array,Blob,Response,AbortController,DecompressionStream,setTimeout,clearTimeout,
    initSqlJs:async()=>SQL,fetch:async input=>{
      const path=String(input).split('?')[0];fetched.push(path);
      if(path==='data/meta.json'&&!fast){const m=JSON.parse(readFileSync(resolve(root,path)));delete m.pages.fast;return Response.json(m);}
      return new Response(readFileSync(resolve(root,path)));
    }});
  ctx.self=ctx;ctx.window=ctx;
  vm.runInContext(readFileSync(resolve(root,'pages-data.js'),'utf8'),ctx);
  return {data:ctx.DashboardData,fetched};
}
const normalize=value=>JSON.parse(JSON.stringify(value));
test('fast district/community rankings, trend and full history equal raw SQL results',async()=>{
  const fast=runtime(),raw=runtime(false);await Promise.all([fast.data.initialize(),raw.data.initialize()]);
  for(const text of [
    'level=district&window=6&compare=adjacent&limit=500',
    'level=community&district=朝阳&window=3&compare=yoy&sort=relative_beijing&direction=desc&limit=100',
    'level=community&district=海淀&window=12&compare=adjacent&sort=volume_change&limit=20',
  ]){
    const p=new URLSearchParams(text);
    assert.deepEqual(normalize(await fast.data.analyze(p)),normalize(await raw.data.analyze(p)),text);
  }
  const trend=new URLSearchParams('window=6&compare=yoy&trend_level=district&trend_name=朝阳');
  assert.deepEqual(normalize(await fast.data.trend(trend)),normalize(await raw.data.trend(trend)));
  const p=new URLSearchParams('q=阳光南里');
  const a=await fast.data.searchCommunities(p),b=await raw.data.searchCommunities(p);
  assert.deepEqual(normalize(a),normalize(b));
  const item=a.results[0],detail=new URLSearchParams({...item,metric:'p60'});
  assert.deepEqual(normalize(await fast.data.communityDetail(detail)),normalize(await raw.data.communityDetail(detail)));
  assert.ok(!fast.fetched.some(p=>p.includes('sqlite3')));
});
test('failed preset downloads retry, release cached rejection and recover',async()=>{
  let attempts=0;
  const ctx=vm.createContext({console,URLSearchParams,TextDecoder,TextEncoder,Uint8Array,Blob,Response,AbortController,DecompressionStream,setTimeout,clearTimeout,
    fetch:async input=>{
      const path=String(input).split('?')[0];
      if(path.includes('market-')&&++attempts<=2)throw Error('network offline');
      return new Response(readFileSync(resolve(root,path)));
    }});
  ctx.self=ctx;ctx.window=ctx;vm.runInContext(readFileSync(resolve(root,'pages-data.js'),'utf8'),ctx);
  await ctx.DashboardData.initialize();
  await assert.rejects(ctx.DashboardData.analyze(new URLSearchParams()),/network offline/);
  assert.ok((await ctx.DashboardData.analyze(new URLSearchParams())).rows.length);assert.equal(attempts,3);
});
