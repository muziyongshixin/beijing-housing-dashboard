import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {communityHistory,quantile} from '../static/detail-math.mjs';
const html=await readFile(new URL('../static/index.html',import.meta.url),'utf8');
const script=await readFile(new URL('../static/product.js',import.meta.url),'utf8');
function page(seen=false){const d=new JSDOM(html,{url:'http://127.0.0.1:18876',runScripts:'outside-only'}),w=d.window;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.HTMLElement.prototype.scrollIntoView=function(){};w.searchCommunities=()=>{};
  if(seen)w.localStorage.setItem('housing-guide-v1','seen');w.eval(script);return d;
}
test('first visit guide, dismiss, returning visit, manual reopen, Escape',()=>{
  const d=page(),w=d.window,q=id=>w.document.getElementById(id);assert.equal(q('welcomeDialog').open,true);
  q('startExploring').click();assert.equal(q('welcomeDialog').open,false);assert.equal(w.localStorage.getItem('housing-guide-v1'),'seen');
  assert.equal(w.document.activeElement.id,'communitySearch');q('openGuide').click();assert.equal(q('welcomeDialog').open,true);
  q('welcomeDialog').dispatchEvent(new w.Event('cancel'));assert.equal(w.localStorage.getItem('housing-guide-v1'),'seen');d.window.close();
  const again=page(true);assert.equal(again.window.document.getElementById('welcomeDialog').open,false);again.window.close();
});
test('all DOM ids are unique and every access control target exists',async()=>{
  const d=page(),ids=[...d.window.document.querySelectorAll('[id]')].map(e=>e.id);assert.equal(new Set(ids).size,ids.length);
  const access=await readFile(new URL('../static/access.js',import.meta.url),'utf8');
  for(const m of access.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.includes(m[1]),`missing ${m[1]}`);d.window.close();
});
test('history merges the exact free boundary; metrics and listing denominators stay separate',()=>{
  const item={district:'测试',business_area:'测试',community:'测试'},cfg={window:3,metric:'median',compare:'adjacent'};
  const rows=[['2025-08-31',100,100,1],['2025-09-01',90,null,1],['2025-10-01',80,100,1],['2025-11-01',70,110,1]].map(([sale_date,unit_price,listing_price,area])=>({sale_date,unit_price,listing_price,area}));
  const r=communityHistory(item,rows,rows,cfg,'2025-11');assert.equal(r.transactions.length,4);assert.equal(r.summary.current_volume,3);assert.equal(r.summary.base_volume,1);assert.equal(r.summary.current_price,80);assert.ok(Math.abs(r.summary.price_change+.2)<1e-10);
  assert.equal(r.rolling.at(-1).listing_sample_count,2);assert.equal(r.rolling.at(-1).sample_count,3);assert.equal(r.rolling.at(-1).listing_price,1050000);
  assert.equal(quantile([10,20,30,40],'p30'),19);assert.equal(quantile([null,undefined,NaN]),null);
});
test('purchase contact is visible to guests and logged-in accounts, copies exact phone and remark',async()=>{
  const d=page(true),w=d.window,q=id=>w.document.getElementById(id),copied=[];
  try{
    Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>copied.push(text)}});
    assert.equal(q('purchaseContact').closest('#accountPanel'),null);
    assert.equal(q('purchaseContact').closest('#emailLoginPanel'),null);
    assert.equal(q('purchaseContact').closest('dialog').id,'accessDialog');
    await q('copyPurchasePhone').onclick();await q('copyPurchaseRemark').onclick();
    assert.deepEqual(copied,['15611710247','房价分析工具']);
    assert.match(q('purchaseCopyStatus').textContent,/已复制/);
    assert.doesNotMatch(q('accessDialog').textContent,/购买联系方式、价格与套餐尚未开放/);
    assert.doesNotMatch(q('welcomeDialog').textContent,/购买渠道尚未开放/);
  }finally{d.window.close();}
});
test('clipboard failure leaves a selectable phone and clear fallback',async()=>{
  const d=page(true),w=d.window,q=id=>w.document.getElementById(id);
  try{Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async()=>{throw Error('denied')}}});
    await q('copyPurchasePhone').onclick();assert.equal(w.document.activeElement.id,'purchasePhone');
    assert.equal(q('purchasePhone').selectionEnd,11);assert.match(q('purchaseCopyStatus').textContent,/手动复制/);
  }finally{d.window.close();}
});
