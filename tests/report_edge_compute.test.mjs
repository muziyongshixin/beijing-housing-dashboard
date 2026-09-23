import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeMarket,metric,createMarketAccumulator} from '../supabase/functions/market-report/compute.mjs';
import {normalizeParams} from '../supabase/functions/market-report/contract.mjs';

const history={communities:[['甲区','甲商圈','甲小区'],['乙区','乙商圈','乙小区']],rows:[
  ['2025-08',0,80,100,null,null,'2室'],['2025-08',0,90,300,null,-.1,'2室'],['2025-08',1,70,200,20,-.2,'1室'],
]};
const privateRows=[
  ['2025-09','甲区','甲商圈','甲小区',85,400,10,-.05,'2室'],
  ['2025-09','乙区','乙商圈','乙小区',75,600,30,-.15,'1室'],
];

test('edge computation merges verified public rows and bounded private pages',()=>{
  const params=normalizeParams({end_month:'2025-09',window:1,min_current:0,min_base:0,min_total:0,min_active_months:0},'2026-08');
  const report=computeMarket(params,history,privateRows);
  assert.deepEqual(report.benchmark,{current_price:500,base_price:200,price_change:1.5,current_volume:2,base_volume:3,volume_change:-.333333,current_area:80,base_area:80});
  assert.equal(report.districts.length,2);assert.equal(report.communities.length,2);
  assert.equal(report.communities.find(row=>row.community==='甲小区').price_change,1);
  assert.equal(report.trends['全部'].points.at(-1).volume,2);
  assert.equal(report.trends['甲区'].points.at(-1).price,400);
});

test('filters scope rankings and trends but not Beijing benchmark or district map',()=>{
  const params=normalizeParams({end_month:'2025-09',window:1,district:'甲区',business_area:'甲商圈',rooms:'2室',min_current:0,min_base:0,min_total:0,min_active_months:0},'2026-08');
  const report=computeMarket(params,history,privateRows);
  assert.equal(report.benchmark.current_volume,1);assert.equal(report.benchmark.base_volume,2);
  assert.deepEqual(report.districts.map(row=>row.district),['甲区']);
  assert.equal(report.map.length,1);assert.equal(report.map[0].district,'甲区');
  assert.equal(report.trends['乙区'],undefined);
});

test('private page validation rejects malformed rows',()=>{
  const params=normalizeParams({end_month:'2025-09',window:1,min_current:0,min_base:0,min_total:0,min_active_months:0},'2026-08');
  assert.throws(()=>computeMarket(params,history,[['2025-09']]),/private_snapshot_mismatch/);
});


test('exact selection equals a fully sorted reference for duplicates, ordered and seeded distributions',()=>{
 let seed=81273;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 const cases=[[],[5],[9,1],[2,2,2],Array.from({length:20000},(_,i)=>i),Array.from({length:20000},(_,i)=>20000-i)];
 for(let n=1;n<=180;n++)cases.push(Array.from({length:n},()=>Math.floor(random()*40)-20));
 cases.push(Array.from({length:100003},()=>random()*50000));
 for(const values of cases){
  const sorted=[...values].sort((a,b)=>a-b);
  for(const name of ['median','p30','p60','min','max','mean']){
   const fraction=name==='p30'?.3:name==='p60'?.6:.5,index=(sorted.length-1)*fraction;
   const expected=!sorted.length?null:name==='mean'?values.reduce((a,b)=>a+b,0)/values.length:name==='min'?sorted[0]:name==='max'?sorted.at(-1):sorted[Math.floor(index)]+(sorted[Math.ceil(index)]-sorted[Math.floor(index)])*(index-Math.floor(index));
   assert.equal(metric(values,name),expected===null?null:Math.round(expected*1e6)/1e6,`${name} length ${values.length}`);
  }
 }
});
test('empty selection retains 48 empty months; custom old-only districts retain empty trends',()=>{
 const p=normalizeParams({rooms:'不存在'},'2026-08'),out=computeMarket(p,history,privateRows);
 assert.equal(out.benchmark.current_volume,0);assert.equal(out.trends['全部'].points.length,48);
 assert.ok(out.trends['全部'].points.every(x=>x.price===null&&x.volume===0&&x.window_volume===0));
 const custom=normalizeParams({compare:'custom',base_start:'2018-04',base_end:'2018-04'},'2026-08');
 const old=computeMarket(custom,{communities:history.communities,rows:[['2018-04',0,80,100,null,null,'2室']]});
 assert.equal(old.trends['甲区'].points.length,48);assert.ok(old.trends['甲区'].points.every(x=>x.price===null));
});

test('protected report parts reassemble exactly for long, scoped, empty and custom windows',()=>{
 for(const input of [{window:24,compare:'yoy'},{district:'甲区',business_area:'甲商圈'},{rooms:'不存在'},{compare:'custom',base_start:'2018-04',base_end:'2018-06'}]){
  const params=normalizeParams(input),all=computeMarket(params,history,privateRows);
  const parts=['summary','city_trend','district_trends'].map(part=>{const a=createMarketAccumulator(params,history.communities,part);a.addPublic(history.rows);a.addPrivate(privateRows);return a.finish();});
  assert.deepEqual({...parts[0],trends:{...parts[1].trends,...parts[2].trends}},all);
 }
});
