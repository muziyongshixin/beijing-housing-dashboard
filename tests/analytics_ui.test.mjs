import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const source=await readFile(new URL('../static/analytics.js',import.meta.url),'utf8');
const html=await readFile(new URL('../static/index.html',import.meta.url),'utf8');
const appSource=await readFile(new URL('../static/app.js',import.meta.url),'utf8');
const production='https://liyongzhi.xyz/beijing-housing-dashboard/';
test('heatmap marker collections are initialized before AMap move events can fire',()=>{
  assert.match(appSource,/heatmapMarkers:\[\],\s*heatmapLabels:\[\]/);
});
function fixture(url=production,build=true,privacy={}) {
  // No resources option: external scripts are NEVER fetched by these tests.
  const dom=new JSDOM(html,{url,runScripts:'outside-only'}),w=dom.window;
  w.DASHBOARD_STATIC_BUILD=build;
  for(const [key,value] of Object.entries(privacy))Object.defineProperty(w.navigator,key,{value});
  return {dom,w,run:()=>w.eval(source),beacons:()=>w.document.querySelectorAll('script[src^="https://static.cloudflareinsights.com/beacon.min.js"]')};
}
test('analytics loads once on exact production site with public token and no business payload',()=>{
  const f=fixture();try{
    f.w.document.getElementById('loginEmail').value='synthetic@example.test';
    f.w.document.getElementById('accessToken').value='synthetic-paid-secret';
    f.w.document.getElementById('communitySearch').value='模拟小区搜索';
    f.w.document.getElementById('transactionBody').textContent='模拟受限成交明细';
    f.run();f.run();assert.equal(f.beacons().length,1);
    const beacon=f.beacons()[0];assert.equal(beacon.type,'module');assert.equal(beacon.referrerPolicy,'strict-origin');
    assert.deepEqual(JSON.parse(beacon.dataset.cfBeacon),{token:'cf346192757847d19471adb6584b743c',spa:false});
    assert.doesNotMatch(beacon.outerHTML,/synthetic|模拟/);
    assert.doesNotThrow(()=>beacon.dispatchEvent(new f.w.Event('error')));
    assert.equal(f.w.document.getElementById('accessToken').value,'synthetic-paid-secret');
  }finally{f.dom.window.close();}
});
test('localhost, previews, unrelated paths, HTTP, ports and non-Pages builds never load analytics',()=>{
  for(const [url,build] of [
    ['http://127.0.0.1:18876/',true],['http://localhost:18876/',true],['http://[::1]:18876/',true],
    ['https://preview.example.test/beijing-housing-dashboard/',true],['https://liyongzhi.xyz.evil.test/beijing-housing-dashboard/',true],
    ['http://liyongzhi.xyz/beijing-housing-dashboard/',true],['https://liyongzhi.xyz:18876/beijing-housing-dashboard/',true],
    ['https://liyongzhi.xyz/qqq-dashboard/',true],['https://liyongzhi.xyz/beijing-housing-dashboard/private',true],
    [production,false],[production,undefined],
  ]){const f=fixture(url,build);try{if(build===undefined)delete f.w.DASHBOARD_STATIC_BUILD;f.run();assert.equal(f.beacons().length,0,url);}finally{f.dom.window.close();}}
});
test('browser privacy signals opt out, duplicate vendor injection is not added twice',()=>{
  for(const privacy of [{doNotTrack:'1'},{globalPrivacyControl:true}]){const f=fixture(production,true,privacy);try{f.run();assert.equal(f.beacons().length,0);}finally{f.dom.window.close();}}
  const f=fixture();try{const script=f.w.document.createElement('script');script.src='https://static.cloudflareinsights.com/beacon.min.js?existing';f.w.document.head.appendChild(script);f.run();assert.equal(f.beacons().length,1);}finally{f.dom.window.close();}
});
test('entrypoint and disclosure exist; optional loader failures do not throw',()=>{
  const f=fixture();try{
    assert.equal(f.w.document.querySelectorAll('script[src="./analytics.js"][defer]').length,1);
    assert.match(f.w.document.querySelector('.analytics-notice').textContent,/访问次数不等于去重人数/);
    f.w.document.head.appendChild=()=>{throw Error('blocked')};assert.doesNotThrow(f.run);
  }finally{f.dom.window.close();}
});
