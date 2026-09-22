import {test} from 'node:test';import assert from 'node:assert/strict';import {gzipSync} from 'node:zlib';
import {createMarketHandler} from '../supabase/functions/market-report/handler.mjs';
import {normalizeParams,historicalMonths,digest,cacheKey} from '../supabase/functions/market-report/contract.mjs';
const id='00000000-0000-4000-8000-000000000001',origin='https://liyongzhi.xyz';
async function fixture(options={}){
 const contents={},manifest={months:{}};
 async function ref(name,data){const raw=JSON.stringify(data),bytes=gzipSync(raw),path='data/history/'+name+'.json.gz';contents[path]=bytes;return {path,sha256:await digest(bytes),bytes:bytes.length,raw_bytes:Buffer.byteLength(raw)};}
 manifest.catalog=await ref('catalog',[['测试','测试','甲']]);manifest.months['2025-08']=await ref('2025-08',[['2025-08',0,80,40000,null,null,'2']]);
 const calls=[],urls=[];const handler=createMarketHandler({manifest,publicBase:'https://raw.githubusercontent.com/muziyongshixin/beijing-housing-dashboard/'+ 'a'.repeat(40)+'/docs/',
 authenticate:async()=>options.unauthorized?null:id,delay:async()=>{},
 fetchPublic:async url=>{urls.push(url);return new Response(options.corrupt?new Uint8Array([1]):contents[url.split('/docs/')[1]]);},
 rpc:async(name,args)=>{calls.push({name,args});if(options.fail===name)throw Error('synthetic_failure');if(name==='housing_market_meta')return {revision:1,latest_date:'2026-08-29'};if(name==='housing_market_begin')return options.hit?{ready:true}:options.pending?{pending:true}:{lease:id};if(name==='housing_compute_market')return {config:args.p_params};if(name==='housing_market_deliver')return {report:{},charged:true};return{ok:true};}});
 const run=(body={params:{},request_id:id},options={})=>handler(new Request('https://example.test/market-report',{method:'POST',headers:{origin,Authorization:'Bearer synthetic'},body:JSON.stringify(body),...options}));return {run,calls,urls};
}
test('normalized keys ignore presentation, include data filters/version, preserve zero, pre-roll and custom ranges',async()=>{
 const a=normalizeParams({window:24,min_total:0}),b=normalizeParams({window:'24',min_total:'0',level:'community',district:'海淀',sort:'area_change',limit:100});assert.deepEqual(a,b);assert.equal(a.trend_start,'2022-09');assert.equal(a.history_start,'2020-10');assert.equal(a.min_total,0);
 const local=normalizeParams({district:'海淀',business_area:'中关村'});assert.equal(local.district,'海淀');assert.equal(local.business_area,'中关村');
 assert.notEqual(await cacheKey(a,'x',1),await cacheKey(a,'x',2));assert.notEqual(await cacheKey(a,'x',1),await cacheKey(normalizeParams({metric:'p60'}),'x',1));
 for(const input of [{url:'evil'},{window:25},{metric:'invalid'},{area_min:NaN},{end_month:'2026-09'},[]])assert.throws(()=>normalizeParams(input));
 const params=normalizeParams({compare:'custom',base_start:'2018-04',base_end:'2018-12'});assert.deepEqual(historicalMonths(params,{months:{'2018-04':{},'2019-01':{},'2022-04':{},'2025-08':{}}}),['2018-04','2022-04','2025-08']);
});
test('unauthorized, oversized and unexpected params cannot fetch public source or calculate',async()=>{
 const a=await fixture({unauthorized:true});assert.equal((await a.run()).status,401);assert.equal(a.calls.length,0);
 const b=await fixture();assert.equal((await b.run({params:{},request_id:id,history:[]})).status,400);assert.equal(b.calls.length,0);assert.equal((await b.run({value:'x'.repeat(9000)})).status,413);
 assert.equal((await b.run(undefined,{headers:{origin:'https://evil.test'}})).status,403);
});
test('cold report uses only trusted verified snapshot and debits only after successful store',async()=>{
 const f=await fixture(),r=await f.run();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.headers.get('access-control-allow-origin'),origin);
 assert.deepEqual(f.calls.map(x=>x.name),['housing_market_meta','housing_market_begin','housing_compute_market','housing_market_store','housing_market_deliver']);
 assert.equal(f.calls[2].args.p_history.rows.length,1);assert.equal(f.calls[3].args.p_payload.data_through,'2026-08-29');assert.ok(f.urls.every(u=>u.startsWith('https://raw.githubusercontent.com/')));
});
test('cache hits authorize/deliver without fetching history; integrity or SQL failure releases lease and never delivers',async()=>{
 const hit=await fixture({hit:true});await hit.run();assert.equal(hit.urls.length,0);assert.equal(hit.calls.at(-1).name,'housing_market_deliver');
 for(const options of [{corrupt:true},{fail:'housing_compute_market'},{fail:'housing_market_store'}]){const f=await fixture(options);assert.equal((await f.run()).status,400);assert.equal(f.calls.at(-1).name,'housing_market_release');assert.ok(!f.calls.some(c=>c.name==='housing_market_deliver'));}
 const busy=await fixture({pending:true});assert.equal((await (await busy.run()).json()).error,'compute_busy');assert.equal(busy.urls.length,0);
});
