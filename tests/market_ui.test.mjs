import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const html=await readFile(new URL('../static/index.html',import.meta.url),'utf8');
const script=await readFile(new URL('../static/app.js',import.meta.url),'utf8');
const row=(community,district,change,eligible=true)=>({community,district,business_area:'测试商圈',eligible,price_change:change,current_volume:20,base_volume:20,base_price:50000,current_price:50000*(1+change)});
const report={
 config:{level:'district',current_start:'2026-03',current_end:'2026-08',base_start:'2025-09',base_end:'2026-02',min_current:1,min_base:1,min_total:2,min_active_months:1},
 benchmark:{price_change:-.04,base_price:50000,current_price:48000,current_volume:100,base_volume:110,volume_change:-.09},
 districts:[{district:'海淀区',eligible:true,price_change:-.03,current_volume:40,base_volume:40,base_price:60000,current_price:58000},{district:'朝阳区',eligible:false,price_change:-.2,current_volume:1,base_volume:1}],
 communities:[row('甲小区','海淀区',-.08),row('乙小区','海淀区',-.02),row('丙小区','朝阳区',.01,false)],
 map:[{district:'海淀区',eligible:true,price_change:-.03}],
 trends:{'全部':{points:[{month:'2026-03',price:50000,volume:10},{month:'2026-08',price:48000,volume:9}]},'海淀区':{points:[{month:'2026-03',price:60000,volume:4},{month:'2026-08',price:58000,volume:5}]}},
 data_through:'2026-08-29'
};
function fixture(){const d=new JSDOM(html,{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true}),w=d.window;
 w.HousingLocationCache={create:()=>({})};w.eval(script+'\nwindow.qaState=state;');
 w.qaState.meta={default_end_month:'2025-08',districts:['海淀区','朝阳区'],business_areas:{}};
 w.qaState.geo={features:[]};w.qaState.amapConfig={configured:false};
 return {d,w,q:id=>w.document.getElementById(id)};
}
test('latest report uses full candidate rows for local display changes without treating them as a new calculation',()=>{
 const f=fixture(),{w,q}=f;try{
  q('endMonth').max='2026-08';q('endMonth').value='2026-08';['minCurrent','minBase'].forEach(id=>q(id).value='1');q('minTotal').value='2';q('minActiveMonths').value='1';
  w.HousingMarketUI.renderLatestMarket(report,w.getParams().toString());
  assert.equal(w.qaState.marketMode,'latest');assert.equal(q('endMonth').max,'2026-08');assert.match(q('marketRangeBadge').textContent,/2026-08-29/);
  q('level').innerHTML='<option value="district">区域</option><option value="community">小区</option>';q('district').innerHTML='<option value="全部">全部</option><option value="海淀区">海淀区</option>';q('level').value='community';q('district').value='海淀区';q('sort').value='price_change';q('direction').value='asc';w.analyze();
  assert.equal(w.qaState.result.rows.length,2);assert.equal(w.qaState.result.summary.candidate_count,2);assert.equal(w.qaState.trend.points[0].price,60000);
  assert.match(q('analysisFeedback').textContent,/不会重新查询/);
  q('window').value='12';w.analyze();assert.match(q('analysisFeedback').textContent,/计算筛选已改变/);
 }finally{f.d.window.close();}
});
test('clearing latest state is synchronous and prevents a late free analysis response from painting over the reset',async()=>{
 const f=fixture(),{w,q}=f;try{
  w.HousingMarketUI.renderLatestMarket(report);w.qaState.heatmapData={rows:report.communities};
  let releaseAnalyze,releaseTrend;w.fetchJSON=url=>new Promise(resolve=>{if(url.includes('/api/analyze'))releaseAnalyze=resolve;else releaseTrend=resolve;});w.qaState.marketMode='free';const late=w.analyze();await new Promise(resolve=>setTimeout(resolve,25));
  w.qaState.marketMode='latest';w.HousingMarketUI.clearLatestMarket();
  releaseAnalyze({config:report.config,benchmark:report.benchmark,summary:{eligible_count:1,candidate_count:1},rows:[row('迟到小区','海淀区',-.4)],map:[]});releaseTrend({points:[]});await late;
  assert.equal(w.qaState.marketMode,'free');assert.equal(w.qaState.premiumReport,null);assert.equal(w.qaState.heatmapData,null);assert.equal(q('endMonth').value,'2025-08');assert.match(q('marketRangeBadge').textContent,/公开市场/);
 }finally{f.d.window.close();}
});
