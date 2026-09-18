import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const code=await readFile(new URL('../static/location-cache.js',import.meta.url),'utf8');
const ctx={};vm.runInNewContext(code,ctx);const {create,key}=ctx.HousingLocationCache;
const c={district:'海淀',business_area:'清河',community:'测试小区'},point={lng:116.34,lat:40.03,name:'测试小区'};
function fixture(){const data=new Map(),shared={};let clock=100000,calls=0,loads=0;
 const options={storage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},now:()=>clock,load:async()=>{loads++;return{locations:shared}},save:async(c,v)=>{shared[key(c)]=v;return{saved:true}}};
 return{options,shared,store:create(options),advance:n=>clock+=n,search:async()=>{calls++;return{location:point}},calls:()=>calls,loads:()=>loads};}
test('repeated recalculation, detail, reload and new browser reuse a shared coordinate',async()=>{
 const f=fixture();await f.store.resolve(c,f.search);for(let i=0;i<10;i++)await f.store.resolve(c,f.search);
 await create(f.options).resolve(c,f.search);await create({...f.options,storage:null}).resolve(c,f.search);
 assert.equal(f.calls(),1);assert.equal(f.loads(),3);
});
test('simultaneous detail and heatmap queries coalesce into one POI call',async()=>{
 const f=fixture();const results=await Promise.all(Array.from({length:20},()=>f.store.resolve(c,f.search)));assert.equal(f.calls(),1);assert.equal(results.length,20);
});
test('no match is remembered across reloads for seven days; forced retry remains available',async()=>{
 const f=fixture();let n=0;const none=async()=>{n++;return{status:'not_found'}};
 await f.store.resolve(c,none);await create(f.options).resolve(c,none);assert.equal(n,1);
 f.advance(7*86400000+1);await f.store.resolve(c,none);assert.equal(n,2);
 await f.store.resolve(c,f.search,{force:true});assert.equal(f.calls(),1);assert.ok(f.store.valid(f.store.read(c)));
});
test('service errors stop the whole batch, not one retry for every remaining community',async()=>{
 const f=fixture();let n=0;const error=async()=>{n++;throw Error('quota')};
 await f.store.resolve(c,error);for(let i=0;i<20;i++)await f.store.resolve({...c,community:`其他${i}`},error);assert.equal(n,1);
 await create(f.options).resolve({...c,community:'刷新后其他'},error);assert.equal(n,1);
 await create({...f.options,storage:null}).resolve({...c,community:'另一浏览器'},error);assert.equal(n,1);
 f.advance(900001);await f.store.resolve({...c,community:'其他'},f.search);assert.equal(f.calls(),1);
});
test('failed manual retry preserves a known valid coordinate; bad storage does not break memory caching',async()=>{
 const f=fixture();const store=create({...f.options,storage:{getItem(){throw Error()},setItem(){throw Error()}}});await store.resolve(c,f.search);
 await store.resolve(c,async()=>({status:'not_found'}),{force:true});assert.ok(store.valid(store.read(c)));await store.resolve(c,f.search);assert.equal(f.calls(),1);
});
test('shared cache load failure never triggers an expensive fallback batch',async()=>{
 const f=fixture();const store=create({...f.options,load:async()=>{throw Error('offline')}});await assert.rejects(store.resolve(c,f.search));assert.equal(f.calls(),0);
});
