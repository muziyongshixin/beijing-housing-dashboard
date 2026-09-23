// Manual local integration benchmark. Reads only local SQLite/public shards and
// keeps all transient report data in memory (or PGlite); it never contacts Supabase.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {computeMarket,createMarketAccumulator,assembleReport} from '../supabase/functions/market-report/compute.mjs';
import {normalizeParams,historicalMonths} from '../supabase/functions/market-report/contract.mjs';

const root=process.cwd(), sqlite=`${root}/data/transactions.sqlite3`, q=sql=>JSON.parse(execFileSync('sqlite3',['-readonly','-json',sqlite,sql],{encoding:'utf8',maxBuffer:128*1024*1024})||'[]');
const manifest=JSON.parse(readFileSync(`${root}/docs/data/history/manifest.json`));
const db=new PGlite(), started=performance.now();
await db.exec('create role anon;create role authenticated;create role service_role;create schema housing_private;create table housing_private.communities(id bigint primary key,district text,business_area text,community text);create table housing_private.transactions(id bigint primary key,community_id bigint,sale_date date,area float8,unit_price float8,sale_price float8,listing_price float8,layout text,rooms text,orientation text,floor text,cycle_days int,discount_rate float8);');
await db.exec(readFileSync(`${root}/supabase/migrations/202609220008_market_compute.sql`,'utf8'));
const dims=q("select district,business_area,community from transactions where sale_date>='2025-09-01' group by 1,2,3 order by 1,2,3").map((x,i)=>({id:i+1,...x})), id=new Map(dims.map(x=>[`${x.district}\u0000${x.business_area}\u0000${x.community}`,x.id]));
await db.query('insert into housing_private.communities select * from jsonb_to_recordset($1) x(id bigint,district text,business_area text,community text)',[JSON.stringify(dims)]);
let after=0, imported=0;
for(;;){const rows=q(`select id,district,business_area,community,sale_date,area,unit_price,sale_price,listing_price,layout,rooms,orientation,floor,cycle_days,discount_rate from transactions where sale_date>='2025-09-01' and id>${after} order by id limit 5000`);if(!rows.length)break;after=rows.at(-1).id;for(const r of rows)r.community_id=id.get(`${r.district}\u0000${r.business_area}\u0000${r.community}`);await db.query('insert into housing_private.transactions select id,community_id,sale_date,area,unit_price,sale_price,listing_price,layout,rooms,orientation,floor,cycle_days,discount_rate from jsonb_to_recordset($1) x(id bigint,community_id bigint,sale_date date,area float8,unit_price float8,sale_price float8,listing_price float8,layout text,rooms text,orientation text,floor text,cycle_days int,discount_rate float8)',[JSON.stringify(rows)]);imported+=rows.length;}
const catalog=JSON.parse(gunzipSync(readFileSync(`${root}/docs/${manifest.catalog.path}`)));
async function report(input){const p=normalizeParams(input,'2026-08'), rows=[];for(const m of historicalMonths(p,manifest)){const part=JSON.parse(gunzipSync(readFileSync(`${root}/docs/${manifest.months[m].path}`)));for(const r of part)if(r[2]>=p.area_min&&r[2]<=p.area_max&&(p.rooms==='全部'||r[6]===p.rooms))rows.push(r)}const t=performance.now(), out=(await db.query('select housing_private.compute_market($1,$2) result',[JSON.stringify(p),JSON.stringify({communities:catalog,rows})])).rows[0].result;const sqlMs=Math.round(performance.now()-t);
const privateRows=q("select sale_month,district,business_area,community,area,unit_price,cycle_days,discount_rate,rooms from transactions where sale_date>='2025-09-01'").map(Object.values);
const edgeStart=performance.now(),edge=computeMarket(p,{communities:catalog,rows},privateRows),edgeMs=Math.round(performance.now()-edgeStart);
function compare(a,b,path='report'){
 if(typeof a==='number'&&typeof b==='number'){assert.ok(Math.abs(a-b)<1.1e-6,`${path}: ${a} != ${b}`);return;}
 if(Array.isArray(a)&&Array.isArray(b)){
  const order=x=>x.district?JSON.stringify([x.district,x.business_area,x.community]):x.month;
  const aa=[...a].sort((x,y)=>String(order(x)).localeCompare(String(order(y)))),bb=[...b].sort((x,y)=>String(order(x)).localeCompare(String(order(y))));
  assert.equal(aa.length,bb.length,path+' length');aa.forEach((x,i)=>compare(x,bb[i],`${path}[${i}]`));return;
 }
 if(a&&b&&typeof a==='object'&&typeof b==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),path+' keys');for(const key of Object.keys(a))compare(a[key],b[key],path+'.'+key);return;}
 assert.equal(a,b,path);
}
const parts=['summary_global','summary_communities','city_trend','district_trends'].map(part=>{const acc=createMarketAccumulator(p,catalog,part);acc.addPublic(rows);acc.addPrivate(privateRows);return acc.finish();});
compare(assembleReport(parts),out);compare(edge,out);return {p,out,ms:sqlMs,edgeMs,historyRows:rows.length};}
// Read raw values from SQLite, then compute percentiles independently with the
// same linear interpolation definition used by PostgreSQL percentile_cont.
const pick=(values,metric)=>{values=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);if(!values.length)return null;if(metric==='mean')return values.reduce((a,b)=>a+b,0)/values.length;if(metric==='min')return values[0];if(metric==='max')return values.at(-1);const p=metric==='p30'?.3:metric==='p60'?.6:.5,i=(values.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return values[lo]+(values[hi]-values[lo])*(i-lo)};
function ref(p){const area=`area between ${p.area_min} and ${p.area_max}`,rooms=p.rooms==='全部'?'':` and rooms=${JSON.stringify(p.rooms)}`,rows=q(`select sale_date,unit_price,area from transactions where ${area}${rooms} and (sale_date between '${p.current_start}-01' and '${p.current_end}-31' or sale_date between '${p.base_start}-01' and '${p.base_end}-31')`),current=rows.filter(r=>r.sale_date.slice(0,7)>=p.current_start&&r.sale_date.slice(0,7)<=p.current_end),base=rows.filter(r=>r.sale_date.slice(0,7)>=p.base_start&&r.sale_date.slice(0,7)<=p.base_end);return{current_price:pick(current.map(r=>r.unit_price),p.metric),base_price:pick(base.map(r=>r.unit_price),p.metric),current_volume:current.length,base_volume:base.length,current_area:pick(current.map(r=>r.area),'median'),base_area:pick(base.map(r=>r.area),'median')}}
const cases=[{},{window:24,compare:'yoy'},{compare:'custom',base_start:'2018-04',base_end:'2018-09'},{metric:'p30',district:'海淀',business_area:'中关村',rooms:'2室',area_min:50,area_max:100}];
for(const input of cases){const x=await report(input), y=ref(x.p);for(const k of ['current_price','base_price','current_volume','base_volume','current_area','base_area'])assert.ok(Math.abs(Number(x.out.benchmark[k]??0)-Number(y[k]??0))<1e-5,`${JSON.stringify(input)} benchmark ${k}`);assert.equal(x.out.trends['全部'].points.length,48);assert.ok(x.out.districts.every(r=>'eligible'in r)&&x.out.communities.every(r=>'eligible'in r));console.log(JSON.stringify({case:input,sql_compute_ms:x.ms,edge_compute_ms:x.edgeMs,history_rows:x.historyRows,district_candidates:x.out.districts.length,community_candidates:x.out.communities.length}));}
console.log(JSON.stringify({ok:true,premium_imported:imported,total_ms:Math.round(performance.now()-started),note:'no private report persisted'}));await db.close();
