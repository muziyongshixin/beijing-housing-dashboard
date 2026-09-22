import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {JSDOM} from 'jsdom';
import {communityHistory} from '../static/detail-math.mjs';
import {createAuthStorage} from '../static/auth-storage.mjs';
const html=await readFile(new URL('../static/index.html',import.meta.url),'utf8'),script=await readFile(new URL('../static/access.js',import.meta.url),'utf8');
const item={district:'测试',business_area:'测试',community:'甲'},second={...item,community:'乙'},third={...item,community:'丙'};
const row={sale_date:'2025-08-31',area:80,unit_price:40000,sale_price:320,listing_price:350};
function fixture(options={}){const d=new JSDOM(html,{url:'http://localhost',runScripts:'outside-only'}),w=d.window;let session=null,selected=[],claims=0,paidUntil=null;
  let clock=Date.now(),touches=0;const sessionKey='housing-auth-mehbviiakjcbfckonzqk-v2';
  const store=options.remembered?createAuthStorage({local:w.localStorage,session:w.sessionStorage,key:sessionKey,now:()=>clock}):null;
  const login=()=>{session={access_token:'synthetic',refresh_token:'synthetic-refresh',user:{id:'test-user',email:'test@example.test'}};if(store){store.beginLogin(true);store.storage.setItem(sessionKey,JSON.stringify(session));store.finishLogin();}};
  if(options.remembered)login();
  const getAccess=()=>({tier:session?(paidUntil?'paid':'registered'):'free',expires_at:paidUntil,trial_communities:[...selected],trial_limit:2});
  const q=id=>w.document.getElementById(id);w.$=q;w.state={community:null,meta:{max_month:'2025-08',min_month:'2018-04',cleaning:{kept_rows:1}}};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.HTMLElement.prototype.scrollIntoView=function(){};
  const marketCalls=[],publicRequests=[];w.getParams=()=>new URLSearchParams(`window=6&metric=median&end_month=${q('endMonth').value||'2025-08'}`);w.fmtNumber=String;w.init=async()=>{};w.renderCommunity=()=>{q('transactionBody').textContent=w.state.community.transactions.map(r=>r.sale_date).join(',');};
  w.HousingMarketUI={calculationParams:p=>{const x=new URLSearchParams(p);for(const key of ['level','district','sort','direction','limit'])x.delete(key);return x.toString();},renderLatestMarket:(report,params)=>{w.state.marketMode='latest';w.state.report={report,params};},clearLatestMarket:()=>{w.state.marketMode='free';w.state.report=null;},showFree:()=>{w.HousingMarketAccess?.cancel();w.state.marketMode='free';}};
  w.fetchJSON=async url=>{publicRequests.push(String(url));return String(url).includes('/api/communities')?{results:options.emptySearch?[]:[item]}:({config:{window:6,metric:'median',compare:'adjacent'},transactions:[row],summary:{last_date:'2025-08-31'}});};
  w.HousingCloud={latestMonth:'2026-08',communityHistory,marketReport:async(params,requestId)=>{marketCalls.push({params,requestId});return{report:{config:{end_month:params.end_month||'2026-08'}},access:getAccess()};},client:{auth:{getSession:async()=>({data:{session}}),onAuthStateChange:()=>{},signOut:async()=>{session=null;return{};},signInWithOtp:async()=>({}),verifyOtp:async()=>{session={user:{email:'test@example.test'}};return{};}}},rpc:async(name,args)=>{
    if(name==='housing_access')return getAccess();if(name==='housing_claim_trial'){claims++;selected.push({...item,community:args.p_community});return{ok:true};}
    if(name==='housing_view_community')return{transactions:[{...row,id:1,sale_date:'2026-08-29'}]};return[];}};
  if(store){w.HousingCloud.sessionStore=store;const touch=store.touch;store.touch=()=>{touches++;return touch();};}
  if(options.missingCloud)delete w.HousingCloud;if(options.slowAuth)w.HousingCloud.client.auth.getSession=()=>new Promise(()=>{});
  w.eval(script+'\nwindow.testAccess={setExpiry:value=>{accessState.expires_at=value;},selection:()=>currentSelection,setActivity:value=>{activityUntil=value;}};');return{d,w,q,login,paid:value=>{paidUntil=value;},claims:()=>claims,store,sessionKey,touches:()=>touches,advance:ms=>{clock+=ms;},marketCalls,publicRequests};
}

test('remembered account renders retention, recovers from network failure without another OTP, and expires locally',async()=>{
  const f=fixture({remembered:true}),{w,q,store}=f;try{
    await new Promise(r=>setImmediate(r));assert.equal(q('rememberLogin').checked,true);assert.match(q('sessionRememberStatus').textContent,/已记住此设备/);
    let sends=0;w.HousingCloud.client.auth.signInWithOtp=async()=>{sends++;return{};};
    const rpc=w.HousingCloud.rpc;w.HousingCloud.rpc=async()=>{throw Error('Failed to fetch');};
    await w.checkAccess();assert.equal(q('emailLoginPanel').hidden,false);assert.ok(store.status().expiresAt);assert.match(q('loginStatus').textContent,/请勿反复发送验证码/);
    w.HousingCloud.rpc=rpc;await w.checkAccess();assert.equal(q('emailLoginPanel').hidden,true);assert.equal(sends,0);assert.equal(q('loginStatus').textContent,'');
    f.advance(7*864e5);await w.checkAccess();assert.equal(q('emailLoginPanel').hidden,false);assert.equal(store.status().expiresAt,null);
  }finally{f.d.window.close();}
});

test('only foreground recent activity renews retention; cross-tab refresh does not clear a private chart but logout does',async()=>{
  const f=fixture({remembered:true}),{w,q,store}=f;try{
    await new Promise(r=>setImmediate(r));Object.defineProperty(w.document,'hidden',{value:false,configurable:true});
    w.testAccess.setActivity(Date.now()+60000);await w.refreshAccess();const count=f.touches();assert.ok(count>0);
    w.testAccess.setActivity(0);await w.refreshAccess();assert.equal(f.touches(),count);
    Object.defineProperty(w.document,'hidden',{value:true,configurable:true});w.testAccess.setActivity(Date.now()+60000);await w.refreshAccess();assert.equal(f.touches(),count);
    await w.requestLatest(item);await q('trialConfirm').onclick();assert.match(q('transactionBody').textContent,/2026/);
    store.touch();w.dispatchEvent(new w.StorageEvent('storage',{key:f.sessionKey}));assert.match(q('transactionBody').textContent,/2026/);
    store.clear();w.dispatchEvent(new w.StorageEvent('storage',{key:f.sessionKey+':epoch'}));assert.doesNotMatch(q('transactionBody').textContent,/2026/);assert.equal(q('emailLoginPanel').hidden,false);
  }finally{f.d.window.close();}
});
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
test('paid login does not auto-charge a market report, while admin auto-loads the newest month',async()=>{
 const f=fixture(),{w,q}=f;try{await new Promise(r=>setImmediate(r));f.login();f.paid(new Date(Date.now()+60000).toISOString());await w.refreshAccess();assert.equal(f.marketCalls.length,0);await w.requestLatestMarket();assert.equal(f.marketCalls.length,1);assert.equal(f.marketCalls[0].params.end_month,'2026-08');
  const g=fixture();await new Promise(r=>setImmediate(r));g.login();const rpc=g.w.HousingCloud.rpc;g.w.HousingCloud.rpc=async name=>name==='housing_access'?{tier:'admin',is_admin:true,trial_communities:[]}:rpc(name);await g.w.refreshAccess();await new Promise(r=>setImmediate(r));assert.equal(g.marketCalls.length,1);assert.equal(g.marketCalls[0].params.end_month,'2026-08');g.d.window.close();
 }finally{f.d.window.close();}
});
test('market double click coalesces before refresh, successful final zero quota remains visible, retry keeps receipt id',async()=>{
 const f=fixture(),{w}=f;try{await new Promise(r=>setImmediate(r));f.login();f.paid(new Date(Date.now()+60000).toISOString());let accessCalls=0,release;const rpc=w.HousingCloud.rpc;w.HousingCloud.rpc=async(name,args)=>{if(name==='housing_access'){accessCalls++;return{tier:'paid',expires_at:new Date(Date.now()+60000).toISOString(),unlimited_views:false,remaining_views:accessCalls<3?1:0,trial_communities:[]};}return rpc(name,args);};await w.refreshAccess();accessCalls=0;w.HousingCloud.marketReport=(params,id)=>new Promise(resolve=>release=()=>resolve({report:{config:{end_month:'2026-08'}},access:{tier:'paid',expires_at:new Date(Date.now()+60000).toISOString(),unlimited_views:false,remaining_views:0,trial_communities:[]}}));
  const one=w.requestLatestMarket(),two=w.requestLatestMarket();await new Promise(r=>setImmediate(r));assert.equal(accessCalls,1);release();await Promise.all([one,two]);assert.equal(w.state.marketMode,'latest');
  let first=true,ids=[];w.HousingCloud.marketReport=async(p,id)=>{ids.push(id);if(first){first=false;throw Error('network');}return{report:{config:{end_month:'2026-08'}},access:{tier:'paid',expires_at:new Date(Date.now()+60000).toISOString(),unlimited_views:false,remaining_views:0,trial_communities:[]}};};await w.requestLatestMarket();await w.requestLatestMarket();assert.equal(ids[0],ids[1]);
 }finally{f.d.window.close();}
});
test('free switch or logout discards a late market result, and validation revokes only its receipt',async()=>{
  const f=fixture(),{w}=f;try{await new Promise(r=>setImmediate(r));f.login();f.paid(new Date(Date.now()+60000).toISOString());await w.refreshAccess();let release;w.HousingCloud.marketReport=()=>new Promise(resolve=>release=resolve);const pending=w.requestLatestMarket();await new Promise(r=>setImmediate(r));w.HousingMarketUI.showFree();release({report:{config:{end_month:'2026-08'}},access:{tier:'paid',expires_at:new Date(Date.now()+60000).toISOString(),trial_communities:[]}});await pending;assert.notEqual(w.state.marketMode,'latest');
  w.HousingCloud.marketReport=async()=>({report:{config:{end_month:'2026-08'}},access:{tier:'paid',expires_at:new Date(Date.now()+60000).toISOString(),trial_communities:[]}});await w.requestLatestMarket();w.HousingCloud.validateViews=async()=>({market_valid:false,community_valid:true});await w.checkAccess();assert.notEqual(w.state.marketMode,'latest');
 }finally{f.d.window.close();}
});
test('community public lookup is clamped to free history even when trial quota is exhausted',async()=>{
 const f=fixture(),{w,q}=f;try{await new Promise(r=>setImmediate(r));f.login();await w.refreshAccess();await w.requestLatest(item);await q('trialConfirm').onclick();await w.requestLatest(second);await q('trialConfirm').onclick();await w.openCommunity(third);const url=f.publicRequests.filter(x=>x.includes('/api/community?')).at(-1);assert.match(url,/end_month=2025-08/);assert.doesNotMatch(url,/end_month=2026/);assert.match(q('transactionBody').textContent,/2025-08-31/);
 }finally{f.d.window.close();}
});
