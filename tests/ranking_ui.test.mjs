import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../static/index.html',import.meta.url),'utf8');
const script=await readFile(new URL('../static/app.js',import.meta.url),'utf8');
const config={level:'district',district:'全部',sort:'price_change',min_current:10,min_base:10,min_total:25,min_active_months:3};
const result=(n=40)=>({config:{...config},summary:{eligible_count:n},rows:Array.from({length:n},(_,i)=>({district:`区域${i+1}`,price_change:(i-20)/100,current_volume:100+i,base_volume:200+i,base_price:40000,current_price:36000}))});
function fixture(){const d=new JSDOM(html,{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true}),w=d.window;
 w.HousingLocationCache={create:()=>({})};w.eval(script+'\nwindow.qaState=state;');
 return{d,w,q:id=>w.document.getElementById(id)};}
test('Top K has no hard-coded 20-row cap; rows align metric and volumes from the same object',()=>{
 const f=fixture(),{w,q}=f;try{w.qaState.result=result();w.renderRanking();assert.equal(q('rankingBody').rows.length,20);
 q('rankingTopK').value='50';w.updateTopK();assert.equal(q('rankingBody').rows.length,40);assert.match(q('rankingCount').textContent,/40 \/ 40/);assert.match(q('rankingNote').textContent,/合格数少于/);
 q('rankingTopK').value='custom';q('customTopK').value='3';w.updateTopK();assert.equal(q('rankingBody').rows.length,3);
 const row=q('rankingBody').rows[2];assert.match(row.cells[1].textContent,/区域3/);assert.match(row.cells[2].textContent,/-18.0%/);assert.match(row.cells[3].textContent,/当前102基准202/);
 let chosen;w.selectRankingRow=r=>chosen=r;row.querySelector('button').click();assert.equal(chosen.district,'区域3');
 assert.equal(w.getParams().get('limit'),'500');
 }finally{f.d.window.close();}
});
test('empty ranking and three eligible objects explain limits without filling fake rows',()=>{
 const f=fixture();try{f.w.qaState.result=result(3);f.w.renderRanking();assert.equal(f.q('rankingBody').rows.length,3);assert.match(f.q('rankingNote').textContent,/合格数少于 Top K/);
 f.w.qaState.result=result(0);f.w.renderRanking();assert.match(f.q('rankingBody').textContent,/没有合格/);
 }finally{f.d.window.close();}
});
test('loading appears before work, superseded requests cannot replace newer results, errors restore interaction',async()=>{
 const f=fixture(),{w,q}=f;try{
 let resolveFirst,started;const start=new Promise(r=>started=r);let count=0;
 for(const name of ['renderSummary','renderMap','renderRanking','renderTrend','loadCommunityHeatmap'])w[name]=()=>{};
 w.fetchJSON=async url=>{if(url.includes('/api/analyze?')){if(++count===1)return new Promise(r=>{resolveFirst=r;started()});return result(12);}return{points:[]};};
 const first=w.analyze();assert.equal(q('analysisLoading').hidden,false);assert.equal(q('analyzeButton').disabled,true);assert.equal(q('marketResults').getAttribute('aria-busy'),'true');
 await start;await w.analyze();assert.equal(w.qaState.result.rows.length,12);resolveFirst(result(3));await first;assert.equal(w.qaState.result.rows.length,12);
 assert.equal(q('analysisLoading').hidden,true);assert.equal(q('analyzeButton').disabled,false);
 w.fetchJSON=async()=>{throw Error('测试失败')};await w.analyze();assert.equal(q('analysisLoading').hidden,true);assert.equal(q('marketResults').inert,false);assert.match(q('analysisFeedback').textContent,/保留上次/);assert.equal(q('errorBox').hidden,false);
 }finally{f.d.window.close();}
});
