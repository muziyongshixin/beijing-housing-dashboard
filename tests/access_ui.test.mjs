import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {JSDOM} from 'jsdom';
import {communityHistory} from '../static/detail-math.mjs';
const html=await readFile(new URL('../static/index.html',import.meta.url),'utf8'),script=await readFile(new URL('../static/access.js',import.meta.url),'utf8');
const item={district:'测试',business_area:'测试',community:'甲'},second={...item,community:'乙'},third={...item,community:'丙'};
const row={sale_date:'2025-08-31',area:80,unit_price:40000,sale_price:320,listing_price:350};
function fixture(options={}){const d=new JSDOM(html,{url:'http://localhost',runScripts:'outside-only'}),w=d.window;let session=null,selected=[],claims=0,paidUntil=null;
  const getAccess=()=>({tier:session?(paidUntil?'paid':'registered'):'free',expires_at:paidUntil,trial_communities:[...selected],trial_limit:2});
  const q=id=>w.document.getElementById(id);w.$=q;w.state={community:null,meta:{max_month:'2025-08',min_month:'2018-04',cleaning:{kept_rows:1}}};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.HTMLElement.prototype.scrollIntoView=function(){};
  w.getParams=()=>new URLSearchParams('window=6&metric=median');w.fmtNumber=String;w.init=async()=>{};w.renderCommunity=()=>{q('transactionBody').textContent=w.state.community.transactions.map(r=>r.sale_date).join(',');};
  w.fetchJSON=async url=>String(url).includes('/api/communities')?{results:options.emptySearch?[]:[item]}:({config:{window:6,metric:'median',compare:'adjacent'},transactions:[row],summary:{last_date:'2025-08-31'}});
  w.HousingCloud={latestMonth:'2026-08',communityHistory,client:{auth:{getSession:async()=>({data:{session}}),onAuthStateChange:()=>{},signOut:async()=>{session=null;return{};},signInWithOtp:async()=>({}),verifyOtp:async()=>{session={user:{email:'test@example.test'}};return{};}}},rpc:async(name,args)=>{
    if(name==='housing_access')return getAccess();if(name==='housing_claim_trial'){claims++;selected.push({...item,community:args.p_community});return{ok:true};}
    if(name==='housing_view_community')return{transactions:[{...row,id:1,sale_date:'2026-08-29'}]};return[];}};
  if(options.missingCloud)delete w.HousingCloud;if(options.slowAuth)w.HousingCloud.client.auth.getSession=()=>new Promise(()=>{});
  w.eval(script+'\nwindow.testAccess={setExpiry:value=>{accessState.expires_at=value;},selection:()=>currentSelection};');return{d,w,q,login:()=>{session={user:{email:'test@example.test'}};},paid:value=>{paidUntil=value;},claims:()=>claims};
}
test('anonymous history never consumes quota; verified unlock is explicit; third stays free; logout clears new rows',async()=>{
  const f=fixture(),{w,q}=f;await new Promise(r=>setImmediate(r));
  await w.openCommunity(item);assert.match(q('transactionBody').textContent,/2025-08-31/);assert.equal(f.claims(),0);
  await w.requestLatest(item);assert.equal(q('accessDialog').open,true);assert.equal(f.claims(),0);
  q('accessDialog').close();f.login();await w.refreshAccess();await w.requestLatest(item);assert.equal(q('trialDialog').open,true);assert.equal(f.claims(),0);
  await q('trialConfirm').onclick();assert.equal(f.claims(),1);assert.match(q('transactionBody').textContent,/2026-08-29/);
  await w.openCommunity(item);assert.equal(f.claims(),1);
  await w.requestLatest(second);await q('trialConfirm').onclick();assert.equal(f.claims(),2);
  await w.openCommunity(third);assert.doesNotMatch(q('transactionBody').textContent,/2026/);await w.requestLatest(third);assert.equal(f.claims(),2);assert.match(q('accessError').textContent,/已用完/);
  await w.openCommunity(item);await q('logoutAccess').onclick();assert.doesNotMatch(q('transactionBody').textContent,/2026/);assert.match(q('transactionBody').textContent,/2025/);f.d.window.close();
});
test('expired paid access clears private records without a server roundtrip',async()=>{
  const f=fixture(),{w,q}=f;await new Promise(r=>setImmediate(r));f.login();f.paid(new Date(Date.now()+30000).toISOString());await w.refreshAccess();await w.openCommunity(third);assert.match(q('transactionBody').textContent,/2026/);
  w.testAccess.setExpiry(new Date(Date.now()-1).toISOString());w.expirePaidView();await new Promise(r=>setImmediate(r));assert.doesNotMatch(q('transactionBody').textContent,/2026/);assert.match(q('transactionBody').textContent,/2025/);f.d.window.close();
});
test('a late private-data response after logout cannot repaint the chart',async()=>{
  const f=fixture(),{w,q}=f;await new Promise(r=>setImmediate(r));f.login();await w.refreshAccess();await w.requestLatest(item);await q('trialConfirm').onclick();
  const rpc=w.HousingCloud.rpc;let release,started;const pending=new Promise(r=>started=r);w.HousingCloud.rpc=(name,args)=>name==='housing_view_community'?new Promise(r=>{release=r;started();}):rpc(name,args);
  const loading=w.openCommunity(item);await pending;await w.logout();release({transactions:[{...row,id:1,sale_date:'2026-08-29'}]});await loading;assert.doesNotMatch(q('transactionBody').textContent,/2026/);assert.match(q('transactionBody').textContent,/2025/);f.d.window.close();
});
test('public queries work if the cloud bundle is missing or session lookup stalls',async()=>{
  for(const options of [{missingCloud:true},{slowAuth:true}]){const f=fixture(options);await new Promise(r=>setImmediate(r));assert.match(f.q('cleaningSummary').textContent,/免费范围/);await f.w.openCommunity(item);assert.match(f.q('transactionBody').textContent,/2025/);f.d.window.close();}
});
test('free search returns immediately without waiting for cloud; missing names query catalog',async()=>{
  for(const emptySearch of [false,true]){
    const f=fixture({emptySearch});let calls=0;
    try{f.w.HousingCloud.rpc=async name=>{if(name==='housing_search_catalog'){calls++;return[third];}return[];};
      const result=await f.w.fetchJSON('/api/communities?q=甲');
      assert.equal(calls,Number(emptySearch));assert.equal(result.results[0].community,emptySearch?'丙':'甲');
    }finally{f.d.window.close();}
  }
});
test('leaving a community clears the selection and old private chart state',async()=>{
  const f=fixture();await new Promise(r=>setImmediate(r));await f.w.openCommunity(item);f.w.closeCommunityView();assert.equal(f.w.testAccess.selection(),null);assert.equal(f.w.state.community,null);assert.equal(f.q('communityDetail').hidden,true);f.d.window.close();
});
test('prominent trial CTA opens registration without claiming a community and reflects account state',async()=>{
  const f=fixture(),{w,q}=f;try{
    await new Promise(r=>setImmediate(r));
    assert.match(q('accessHeadline').textContent,/免费试用 2 个小区/);
    assert.match(q('openAccess').textContent,/免费注册/);q('openAccess').click();
    assert.equal(q('accessDialog').open,true);assert.equal(f.claims(),0);
    assert.equal(w.document.activeElement.id,'loginEmail');q('accessDialog').close();
    f.login();await w.refreshAccess();assert.match(q('accessHeadline').textContent,/还可免费解锁 2/);
    f.paid(new Date(Date.now()+60000).toISOString());await w.refreshAccess();
    assert.match(q('accessHeadline').textContent,/最新小区成交已解锁/);
    assert.match(q('openAccess').textContent,/我的账号/);
  }finally{f.d.window.close();}
});
test('admin bypasses codes; limited quota response updates display; uncertain network retry reuses request id',async()=>{
  const f=fixture(),{w,q}=f;try{
    await new Promise(r=>setImmediate(r));f.login();
    const rpc=w.HousingCloud.rpc;let admin=true,attempt=0,requests=[];
    w.HousingCloud.rpc=async(name,args)=>{
      if(name==='housing_access')return admin?{tier:'admin',is_admin:true,trial_communities:[],unlimited_views:true}:{tier:'paid',expires_at:new Date(Date.now()+60000).toISOString(),trial_communities:[],unlimited_views:false,remaining_views:1};
      if(name==='housing_view_community'){requests.push(args.p_request_id);if(++attempt===2)throw Error('network');return{transactions:[{...row,id:1,sale_date:'2026-08-29'}],access:await w.HousingCloud.rpc('housing_access')};}
      return rpc(name,args);
    };
    await w.refreshAccess();assert.equal(q('adminLink').hidden,false);await w.openCommunity(third);assert.match(q('transactionBody').textContent,/2026/);assert.equal(f.claims(),0);
    admin=false;await w.refreshAccess();assert.equal(q('adminLink').hidden,true);assert.match(q('accountQuota').textContent,/剩余 1 次/);
    await w.openCommunity(third);assert.doesNotMatch(q('transactionBody').textContent,/2026/);await w.openCommunity(third);assert.equal(requests[1],requests[2]);assert.notEqual(requests[0],requests[1]);
    await w.openCommunity(third);assert.notEqual(requests[2],requests[3]);
  }finally{f.d.window.close();}
});
