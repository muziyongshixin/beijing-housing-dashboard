import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeMarket} from '../supabase/functions/market-report/compute.mjs';
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
