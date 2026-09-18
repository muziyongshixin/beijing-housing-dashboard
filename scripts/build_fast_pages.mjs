// Build trustworthy public caches using the exact browser statistics implementation.
import vm from 'node:vm';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=resolve(process.argv[2]);
const SQL=await require(resolve(root,'vendor/sql-wasm.js'))();
const db=new SQL.Database(readFileSync(resolve(root,'data/transactions.sqlite3')));
const query=sql=>{const r=db.exec(sql)[0];return r?r.values.map(row=>Object.fromEntries(r.columns.map((key,i)=>[key,row[i]]))):[];};
const meta=JSON.parse(readFileSync(resolve(root,'data/meta.json')));
function save(name,payload){const path='data/fast/'+name+'.json.gz',bytes=gzipSync(JSON.stringify(payload),{level:9,mtime:0});mkdirSync(dirname(resolve(root,path)),{recursive:true});writeFileSync(resolve(root,path),bytes);return{path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};}
const date=v=>`${String(v).slice(0,4)}-${String(v).slice(4,6)}-${String(v).slice(6,8)}`;
const catalog=query('SELECT c.id,d.name district,b.name business_area,c.name community,c.transaction_count,c.first_date,c.last_date FROM communities c JOIN business_areas b ON b.id=c.business_area_id JOIN districts d ON d.id=b.district_id').map(r=>({...r,first_date:date(r.first_date),last_date:date(r.last_date),shard:String(Math.floor((r.id-1)/32))}));
const shardData=new Map();const columns=['sale_date','sale_month','layout','orientation','floor','area','listing_price','sale_price','unit_price','cycle_days','source_code'];
const data=db.exec(`SELECT t.community_id,t.sale_date,t.sale_month,l.name,o.name,f.name,t.area/100.0,t.listing_price/100.0,t.sale_price/100.0,t.unit_price,t.cycle_days,t.source_code FROM transactions t JOIN layouts l ON l.id=t.layout_id JOIN orientations o ON o.id=t.orientation_id JOIN floors f ON f.id=t.floor_id ORDER BY t.community_id,t.sale_date`)[0].values;
for(const [id,...row]of data){const shard=String(Math.floor((id-1)/32));if(!shardData.has(shard))shardData.set(shard,{columns,communities:{}});(shardData.get(shard).communities[id]??=[]).push(row);}
const fast={schema:1,source_sha256:meta.pages.database_sha256,through:meta.date_max,catalog:save('catalog',catalog),shards:{},presets:{}};
for(const [shard,value]of shardData)fast.shards[shard]=save('communities-'+shard,value);
const ctx=vm.createContext({console,URLSearchParams,TextDecoder,TextEncoder,Uint8Array,Blob,Response,AbortController,DecompressionStream,setTimeout,clearTimeout,HOUSING_BUILD_CACHE:true,
  initSqlJs:async()=>SQL,fetch:async path=>new Response(readFileSync(resolve(root,String(path).split('?')[0])))});ctx.self=ctx;ctx.window=ctx;
vm.runInContext(readFileSync(resolve(root,'pages-data.js'),'utf8'),ctx);
await ctx.DashboardData.initialize();
const trendCache=new Map();
for(const window of [6,3,12])for(const compare of ['adjacent','yoy']){
  const p=new URLSearchParams({window:String(window),compare,limit:'500'});
  const district=await ctx.DashboardData.buildAnalysis(p);p.set('level','community');const community=await ctx.DashboardData.buildAnalysis(p);
  const trends=trendCache.get(window)||{};if(!trendCache.has(window)){for(const d of ['全部',...meta.districts]){const t=new URLSearchParams(p);t.set('district',d);t.set('trend_level',d==='全部'?'city':'district');t.set('trend_name',d==='全部'?'北京':d);trends[d]=await ctx.DashboardData.trend(t);}trendCache.set(window,trends);}
  fast.presets[`${window}-${compare}`]=save('market-'+window+'-'+compare,{source_sha256:fast.source_sha256,through:fast.through,district,community,trends});
  console.log('Prepared public preset',window,compare);
}
meta.pages.fast=fast;writeFileSync(resolve(root,'data/meta.json'),JSON.stringify(meta));
db.close();console.log('Fast public caches:',catalog.length,'communities;',fast.catalog.bytes,'catalog bytes;',Object.keys(fast.shards).length,'shards');
