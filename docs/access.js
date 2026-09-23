/* Server-verified entitlements; no private data in masks or persistent chart caches. */
let accessState={tier:'free',trial_communities:[],trial_limit:2};
let accessEpoch=0,detailGeneration=0,currentSelection=null,privateVisible=false,communityReceipt=null,marketReceipt=null,marketGeneration=0;
let currentEmail='',authBusy=false,pendingTrial=null,accessReady=false,authGeneration=0,expiryTimer,accessChecking=false;
let activityUntil=Date.now()+60000;
['pointerdown','keydown'].forEach(event=>document.addEventListener(event,()=>{activityUntil=Date.now()+60000;},{passive:true}));
const viewRetries=new Map(); // Memory only; reuse the request id after uncertain network failure.
const unavailable=()=>Promise.reject(new Error('账号服务暂时不可用，历史数据仍可免费查看。'));
const cloud=window.HousingCloud||{rpc:unavailable,client:{auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>{},signInWithOtp:unavailable,verifyOtp:unavailable,signOut:unavailable}}},originalFetchJSON=fetchJSON;
let knownAuthIdentity=cloud.sessionStore?.identity(),accessCheckAgain=false;
const communityKey=c=>[c.district,c.business_area,c.community].join('\u0001');
const sameCommunity=(a,b)=>a&&b&&communityKey(a)===communityKey(b);
const paidActive=()=>accessState.tier==='paid'&&Date.parse(accessState.expires_at)>Date.now();
const canView=c=>accessState.is_admin===true||(paidActive()&&(accessState.unlimited_views!==false||Number(accessState.remaining_views)>0||(privateVisible&&sameCommunity(c,currentSelection))))||accessState.trial_communities.some(x=>sameCommunity(x,c));
const canViewMarket=()=>accessState.is_admin===true||(paidActive()&&(accessState.unlimited_views!==false||Number(accessState.remaining_views)>0));
const hasExistingEntitlement=()=>accessState.is_admin===true||paidActive();
const communityArgs=c=>({p_district:c.district,p_business_area:c.business_area,p_community:c.community});
const errorText=e=>/failed to fetch|fetch failed|network|timeout|aborted/i.test(e.message||'')?'暂时无法连接账号服务，请检查网络后重试。已保存的登录信息不会因网络故障被清除，请勿反复发送验证码。':({compute_busy:'其他报告正在计算，请稍后用本页重试。',compute_resource_limit:'本次报告计算未完成，请稍后重试或缩小筛选范围。',market_unavailable:'最新报告服务暂时不可用，请稍后重试。',public_snapshot_unavailable:'历史数据暂时无法读取，请稍后重试。',database_unavailable:'数据服务暂时不可用，请稍后重试。',community_locked:'这个小区的新数据尚未解锁，旧成交记录仍可免费查看。',view_quota_exhausted:'付费查看次数已用完，请兑换新码；旧历史和已领取试用的小区仍可查看。',view_retry_expired:'上次请求的重试时间已过，请重新打开小区。',view_scope_mismatch:'查看请求与小区不匹配，请重新打开。',verified_email_required:'请先验证邮箱。',rate_limited:'请求较频繁，请一分钟后再试。',invalid_token:'兑换码无效、已过期、已使用或已撤销。',trial_exhausted:'两个试用名额已用完，查看更多小区需要兑换码。',no_new_data:'该小区暂未收录新数据，不消耗名额。'}[e.message]||(/rate limit|too many/i.test(e.message)?'操作过于频繁，请稍后再试。':e.message));
function clearPrivateView(){accessEpoch++;detailGeneration++;privateVisible=false;communityReceipt=null;state.community=null;state.communityPriceRange=null;
  ['communityPriceChart','communityVolumeChart','transactionBody'].forEach(id=>$(id).replaceChildren());
  ['detailTotal','detailDates','detailChange','detailPrices','detailCurrentVolume','detailBaseVolume','detailArea','detailMedianPrice','transactionCountText'].forEach(id=>$(id).textContent='—');$('communityCoverage').textContent='正在重新核验数据权限…';}
const marketRetries=new Map();let marketLoading=false,adminMarketLoadedFor='';
function clearPremiumMarket(){marketGeneration++;marketReceipt=null;marketRetries.clear();marketLoading=false;adminMarketLoadedFor='';const wasLatest=state.marketMode==='latest';window.HousingMarketUI?.clearLatestMarket();if(wasLatest&&state.meta)void analyze();}
async function requestLatestMarket(auto=false){
 if(marketLoading||!state.meta)return;if(!hasExistingEntitlement()){if(!auto)openAccessDialog();return;}
 const generation=authGeneration,marketEpoch=marketGeneration;marketLoading=true;
 try{
  await refreshAccess();if(generation!==authGeneration||marketEpoch!==marketGeneration)return;
  if(state.marketMode!=='latest'){$('endMonth').max=cloud.latestMonth;$('endMonth').value=cloud.latestMonth;}
  ['baseStart','baseEnd'].forEach(id=>$(id).max=cloud.latestMonth);
  const raw=getParams(),params=window.HousingMarketUI?.calculationParams?.(raw)||raw.toString(),now=Date.now();
  let request=marketRetries.get(params);if(request&&now-request.created>=600000){marketRetries.delete(params);request=null;}
  if(!canViewMarket()&&!request){if(!auto){$('marketAccessHint').textContent='最新市场报告需要有效付费权益和至少 1 次剩余额度；小区与市场报告共用查看次数。';openAccessDialog();}return;}
  if(!request){request={id:crypto.randomUUID(),created:now};marketRetries.set(params,request);}
  $('latestMarketButton').disabled=true;$('latestMarketButton').textContent='正在查询最新报告…';$('marketAccessHint').textContent='正在读取完整最新市场报告；成功生成后扣 1 次（管理员不扣），网络超时请用本页重试。';
  const r=await cloud.marketReport(Object.fromEntries(raw),request.id);
  if(generation!==authGeneration||marketEpoch!==marketGeneration)return;if(r?.error)throw Error(r.error);if(!r?.report)throw Error('market_unavailable');
  marketRetries.delete(params);marketReceipt=request.id;if(r.access)accessState={...r.access,email:accessState.email};window.HousingMarketUI?.renderLatestMarket(r.report,raw);
 }catch(e){if(generation===authGeneration&&marketEpoch===marketGeneration)$('marketAccessHint').textContent=`最新报告加载失败：${errorText(e)}。可在本页重试；若服务器已完成扣次，10 分钟内沿用同一请求不重复扣。`;}
 finally{if(generation===authGeneration&&marketEpoch===marketGeneration){marketLoading=false;renderAccess();}}
}
window.HousingMarketAccess={isAdmin:()=>accessState.is_admin===true,cancel:()=>{marketGeneration++;marketLoading=false;marketReceipt=null;}};
async function refreshAccess(){const generation=authGeneration;const{data:{session},error}=await cloud.client.auth.getSession();if(error)throw error;const current=session&&(!cloud.sessionStore||cloud.sessionStore.isCurrent(session));const next=current?await cloud.rpc('housing_access'):{tier:'free',trial_communities:[],trial_limit:2};if(generation!==authGeneration||(current&&cloud.sessionStore&&!cloud.sessionStore.isCurrent(session)))throw new Error('权限已切换，请重新操作');if(current&&!document.hidden&&Date.now()<activityUntil)cloud.sessionStore?.touch();knownAuthIdentity=cloud.sessionStore?.identity();accessState=next;accessState.email=current?session.user.email||'':'';if(current)$('loginStatus').textContent='';renderAccess();return accessState;}
function expirePaidView(){if(accessState.tier!=='paid'||paidActive())return;accessState={...accessState,tier:'registered'};clearPremiumMarket();const item=currentSelection;if(privateVisible&&item&&!canView(item)){clearPrivateView();openCommunity(item);}renderAccess();}
function renderAccess(){if(accessState.tier==='paid'&&!paidActive())accessState={...accessState,tier:'registered'};clearTimeout(expiryTimer);if(paidActive())expiryTimer=setTimeout(()=>{expirePaidView();if(paidActive())renderAccess();},Math.min(2147483647,Math.max(1,Date.parse(accessState.expires_at)-Date.now())));const logged=accessState.tier!=='free',paid=paidActive(),used=accessState.trial_communities.length;
  $('accessTier').textContent=paid?'完整小区数据权益':logged?`已注册 · 试用 ${used} / 2`:'免费历史数据';
  $('accessDescription').textContent=paid?`小区最新记录已解锁 · 有效至 ${new Date(accessState.expires_at).toLocaleDateString('zh-CN')}`:logged?'两个名额按邮箱账号保留，重复查看不扣次数。':'截至 2025-08-31，所有小区历史成交、趋势与区域分析，无需登录。';
  $('accessHeadline').textContent=paid?'最新小区成交已解锁':logged?`还可免费解锁 ${Math.max(0,2-used)} 个小区`:'免费试用 2 个小区的最新成交';
  $('accessActionHint').textContent=logged?'试用按账号保留 · 重复查看不扣名额':'邮箱验证即可 · 无需设置密码';
  $('openAccess').textContent=logged?'我的账号 / 兑换码':'免费注册 · 领取试用 →';$('logoutAccess').hidden=!logged;
  $('emailLoginPanel').hidden=logged;$('accountPanel').hidden=!logged;$('accountEmail').textContent=accessState.email||'';
  $('accountQuota').textContent=paid?'已兑换最新小区数据权益':`剩余 ${2-used} 个小区试用名额`;
  const saved=cloud.sessionStore?.status();
  $('sessionRememberStatus').textContent=saved?.remembered
    ?`已记住此设备 · 本地登录保留至 ${new Date(saved.expiresAt).toLocaleString('zh-CN')}；成功使用后自动延长 7 天。`
    :saved?.expiresAt?'仅在当前标签页保留登录；关闭后可能需要重新验证。':'';
  const admin=accessState.is_admin===true;
  $('adminLink').hidden=!admin;
  if(admin){$('accessTier').textContent='超级管理员';$('accessHeadline').textContent='所有小区新旧成交 · 免码查看';$('accessDescription').textContent='管理员查询不消耗试用或付费查看次数。';$('accessActionHint').textContent='管理权限由服务器核验';$('accountQuota').textContent='超级管理员 · 小区成交明细无限次查看';}
  else if(paid){const quota=accessState.unlimited_views===false?`剩余 ${accessState.remaining_views||0} 次`:'不限次数';$('accessHeadline').textContent=`最新小区成交已解锁 · ${quota}`;$('accountQuota').textContent=`最新小区数据权益 · ${quota}。查询一个新小区或完整最新市场报告各扣 1 次；已加载报告内筛选、排行和图表不扣。`;}
  $('accountCommunities').replaceChildren(...accessState.trial_communities.map(c=>{const b=document.createElement('button');b.type='button';b.className='community-chip';b.textContent=c.community;b.onclick=()=>{$('accessDialog').close();openCommunity(c);};return b;}));
  $('unlockSubmit').disabled=!logged;document.querySelectorAll('#communityDetail .paid-placeholder').forEach(e=>e.hidden=privateVisible);
  $('latestMarketButton').hidden=false;$('freeMarketButton').hidden=false;
  $('latestMarketButton').textContent=marketLoading?'正在查询最新报告…':admin?'查询最新报告 · 不扣次数':'查询最新报告 · 1 次';$('latestMarketButton').disabled=marketLoading;
  if(admin&&state.meta&&adminMarketLoadedFor!==accessState.email&&!marketLoading){adminMarketLoadedFor=accessState.email;void requestLatestMarket(true);}
  document.querySelectorAll('[data-open-access]').forEach(b=>b.onclick=()=>requestLatest(currentSelection));}
function openAccessDialog(){$('accessError').textContent='';$('loginStatus').textContent='';$('accessDialog').showModal();(accessState.tier==='free'?$('loginEmail'):$('accessToken')).focus();}
async function requestLatest(item){if(!item||accessState.tier==='free')return openAccessDialog();try{await refreshAccess();}catch(e){return failAuth(e);}
  if(canView(item))return openCommunity(item);if(accessState.trial_communities.length>=2){openAccessDialog();$('accessError').textContent='两个试用名额已用完。此小区旧历史依然免费；更多新数据需要购买后兑换。';return;}
  pendingTrial={...item};$('trialCommunityName').textContent=item.community;$('trialRemaining').textContent=`当前剩余 ${2-accessState.trial_communities.length} 个名额。确认后绑定此小区，不可更换；重复查看不再扣减。`;$('trialError').textContent='';$('trialConfirm').disabled=false;$('trialDialog').showModal();}
$('trialConfirm').onclick=async()=>{if(!pendingTrial)return;const item=pendingTrial,generation=authGeneration;$('trialConfirm').disabled=true;
  try{const r=await cloud.rpc('housing_claim_trial',communityArgs(item));if(generation!==authGeneration)return;if(!r.ok)throw new Error(r.code);await refreshAccess();if(generation!==authGeneration)return;$('trialDialog').close();await openCommunity(item);}catch(e){$('trialError').textContent=errorText(e);}finally{$('trialConfirm').disabled=false;}};
$('trialCancel').onclick=()=>$('trialDialog').close();
fetchJSON=async function(url){const p=new URL(url,location.href);if(p.pathname.endsWith('/api/communities')){const old=await originalFetchJSON(url);if(old.results.length)return old;try{const catalog=await cloud.rpc('housing_search_catalog',{p_query:p.searchParams.get('q')||''}),seen=new Set(old.results.map(communityKey));for(const c of catalog)if(!seen.has(communityKey(c)))old.results.push({...c,transaction_count:null,first_date:null,last_date:null});}catch{}return old;}return originalFetchJSON(url);};
openCommunity=async function(item){const{district,business_area,community}=item;currentSelection={district,business_area,community};clearPrivateView();const generation=detailGeneration,epoch=accessEpoch;
  $('communitySuggestions').hidden=true;$('communityDetail').hidden=false;$('marketSection').hidden=true;$('communityTitle').textContent=community;$('communityBreadcrumb').textContent=`${district} · ${business_area}`;$('communityCoverage').textContent='正在读取当前权限内的成交记录…';$('communityDetail').scrollIntoView({behavior:'smooth',block:'start'});
  const p=getParams();p.set('end_month',state.meta?.default_end_month||state.meta?.max_month||'2025-08');for(const key of ['base_start','base_end'])if(p.get(key)>'2025-08')p.delete(key);if(p.get('compare')==='custom'&&(!p.has('base_start')||!p.has('base_end')))p.set('compare','adjacent');Object.entries(currentSelection).forEach(([k,v])=>p.set(k,v));let old;
  try{old=await originalFetchJSON(`/api/community?${p}`);}catch(e){if(!/未找到.*成交记录/.test(e.message)){if(generation===detailGeneration)$('communityCoverage').textContent=errorText(e);return;}}
  if(generation!==detailGeneration||epoch!==accessEpoch)return;let result=old,warning='';
  if(canView(item)||(hasExistingEntitlement()&&viewRetries.has(communityKey(item)))){try{await refreshAccess();if(generation!==detailGeneration||epoch!==accessEpoch||(!canView(item)&&!viewRetries.has(communityKey(item))))throw Error('community_locked');const key=communityKey(item);let request=viewRetries.get(key);if(!request||Date.now()-request.created>600000){request={id:crypto.randomUUID(),created:Date.now()};viewRetries.set(key,request);}
    const r=await cloud.rpc('housing_view_community',{...communityArgs(item),p_request_id:request.id});if(generation!==detailGeneration||epoch!==accessEpoch)return;if(r.error)throw Error(r.error);const added=r.transactions;viewRetries.delete(key);if(r.access)accessState={...r.access,email:accessState.email};
    // A successful final paid request may legitimately reduce remaining_views to
    // zero. Keep this response visible; only the next request is blocked.
    const cfg=old?.config||{window:Number($('window').value),metric:$('metric').value,compare:$('compare').value,base_start:$('baseStart').value,base_end:$('baseEnd').value};result=cloud.communityHistory(currentSelection,old?.transactions||[],added,cfg,cloud.latestMonth);privateVisible=true;communityReceipt=request.id;
  }catch(e){if(/community_locked|view_quota_exhausted|view_retry_expired|view_scope_mismatch|no_new_data/.test(e.message))viewRetries.delete(communityKey(item));privateVisible=false;warning=` · 新数据加载失败：${errorText(e)}`;}}
  if(generation!==detailGeneration||epoch!==accessEpoch)return;if(result){state.community=result;renderCommunity();$('communityCoverage').textContent+=(privateVisible?' · 含已授权新成交数据':' · 免费历史范围，查看不扣名额')+warning;}else{$('communityCoverage').textContent='此小区在免费历史范围内暂无记录，可尝试解锁新数据。';}renderAccess();};
function failAuth(e){authGeneration++;const item=currentSelection;clearPrivateView();clearPremiumMarket();accessState={tier:'free',trial_communities:[],trial_limit:2};renderAccess();if(item)openCommunity(item);$('loginStatus').textContent=`暂时无法验证账号：${errorText(e)}`;}
let sendAgainAt=0,sendingOtp=false;
$('loginForm').onsubmit=async e=>{e.preventDefault();if(sendingOtp||Date.now()<sendAgainAt)return;const email=$('loginEmail').value.trim();sendingOtp=true;$('sendOtp').disabled=true;$('loginStatus').textContent='正在发送验证码…';try{const{error}=await cloud.client.auth.signInWithOtp({email,options:{shouldCreateUser:true}});if(error)throw error;currentEmail=email;sendAgainAt=Date.now()+60000;$('otpPanel').hidden=false;$('loginCode').focus();$('loginStatus').textContent='验证码已请求发送，请查收邮件和垃圾箱，10 分钟内有效。';}catch(e){$('loginStatus').textContent=errorText(e);}finally{sendingOtp=false;$('sendOtp').disabled=Date.now()<sendAgainAt;}};
setInterval(()=>{const seconds=Math.ceil((sendAgainAt-Date.now())/1000);$('sendOtp').disabled=sendingOtp||seconds>0;$('sendOtp').textContent=seconds>0?`${seconds} 秒后可重发`:'发送邮箱验证码';},1000);
$('verifyForm').onsubmit=async e=>{e.preventDefault();if(authBusy||!currentEmail)return;const generation=authGeneration;authBusy=true;$('verifyOtp').disabled=true;try{cloud.sessionStore?.beginLogin($('rememberLogin').checked);const{error}=await cloud.client.auth.verifyOtp({email:currentEmail,token:$('loginCode').value.trim(),type:'email'});if(generation!==authGeneration){if(!cloud.sessionStore)await cloud.client.auth.signOut({scope:'local'});return;}if(error)throw error;cloud.sessionStore?.finishLogin();$('loginCode').value='';await refreshAccess();if(generation!==authGeneration)return;$('loginStatus').textContent='邮箱验证成功。';if(currentSelection){$('accessDialog').close();await requestLatest(currentSelection);}}catch(e){$('loginStatus').textContent=errorText(e);}finally{cloud.sessionStore?.finishLogin();authBusy=false;$('verifyOtp').disabled=false;}};
$('accessForm').onsubmit=async e=>{e.preventDefault();const generation=authGeneration;$('unlockSubmit').disabled=true;try{const r=await cloud.rpc('housing_redeem',{p_token:$('accessToken').value.trim()});$('accessToken').value='';if(generation!==authGeneration)return;if(!r.ok)throw new Error(r.code||'invalid_token');await refreshAccess();if(generation!==authGeneration)return;$('accessError').textContent='兑换成功，权益已绑定当前账号。';if(currentSelection)await openCommunity(currentSelection);}catch(e){$('accessError').textContent=errorText(e);}finally{$('unlockSubmit').disabled=accessState.tier==='free';}};
$('openAccess').onclick=openAccessDialog;$('closeAccess').onclick=()=>$('accessDialog').close();$('accessDialog').addEventListener('close',()=>{$('accessToken').value='';$('loginCode').value='';});
const accessChannel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('housing-account'):null;
async function logout(notify=true){authGeneration++;viewRetries.clear();pendingTrial=null;$('trialDialog').close();clearPrivateView();clearPremiumMarket();accessState={tier:'free',trial_communities:[],trial_limit:2};renderAccess();notify&&accessChannel?.postMessage('logout');let error;try{error=(cloud.signOut?await cloud.signOut():await cloud.client.auth.signOut({scope:'local'})).error;}catch(e){error=e;}if(currentSelection)await openCommunity(currentSelection);if(error)$('accessDescription').textContent='本机登录状态已清除；网络异常，远端会话撤销未确认。请勿与他人共享曾保存的登录凭据。';}
$('logoutAccess').onclick=()=>logout();accessChannel?.addEventListener('message',()=>logout(false));
cloud.client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'&&accessReady){authGeneration++;clearPrivateView();clearPremiumMarket();accessState={tier:'free',trial_communities:[],trial_limit:2};renderAccess();}});
async function checkAccess(){if(accessChecking){accessCheckAgain=true;return;}if(!accessReady||(accessState.tier==='free'&&!cloud.sessionStore?.status().expiresAt))return;accessChecking=true;const generation=authGeneration;try{
 await refreshAccess();if(generation!==authGeneration)return;
 const mr=marketReceipt,cr=communityReceipt;
 const receipt=cloud.validateViews&&(mr||cr)?await cloud.validateViews(mr,cr):null;if(generation!==authGeneration)return;
 if(state.marketMode==='latest'&&(!hasExistingEntitlement()||(mr===marketReceipt&&receipt&&!receipt.market_valid)))clearPremiumMarket();
 const trial=currentSelection&&accessState.trial_communities.some(x=>sameCommunity(x,currentSelection));
 if(privateVisible&&currentSelection&&(!canView(currentSelection)||(!accessState.is_admin&&!trial&&cr===communityReceipt&&receipt&&!receipt.community_valid))){clearPrivateView();await openCommunity(currentSelection);}
 }catch(e){if(generation===authGeneration)failAuth(e);}finally{accessChecking=false;if(accessCheckAgain){accessCheckAgain=false;void checkAccess();}}}
window.addEventListener('storage',e=>{if(e.key===null||e.key?.startsWith('housing-auth-mehbviiakjcbfckonzqk-v2')){const identity=cloud.sessionStore?.identity();if(identity===knownAuthIdentity)return;knownAuthIdentity=identity;authGeneration++;clearPrivateView();clearPremiumMarket();accessState={tier:'free',trial_communities:[],trial_limit:2};renderAccess();void checkAccess();}});
setInterval(checkAccess,15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){expirePaidView();checkAccess();}});window.addEventListener('pageshow',e=>{if(e.persisted){clearPrivateView();clearPremiumMarket();checkAccess().then(()=>currentSelection&&openCommunity(currentSelection));}});
function closeCommunityView(){currentSelection=null;pendingTrial=null;clearPrivateView();$('communityDetail').hidden=true;$('marketSection').hidden=false;}
$('closeCommunity').onclick=()=>{closeCommunityView();$('marketSection').scrollIntoView({behavior:'smooth'});};
async function bootstrapAccess(){const auth=refreshAccess().catch(e=>{renderAccess();if(cloud.sessionStore?.status().expiresAt)$('loginStatus').textContent='登录信息已保留，暂时无法连接账号服务；网络恢复后会自动重试，无需重新发送验证码。';});await init();if(state.meta){['baseStart','baseEnd'].forEach(id=>{$(id).max=state.meta.max_month;$(id).min=state.meta.min_month;});$('cleaningSummary').textContent=`免费范围内 ${fmtNumber(state.meta.cleaning.kept_rows)} 笔有效成交。样本已进行价格、面积、重复记录和位置清洗，不代表市场全部成交。`;}await auth;accessReady=true;renderAccess();}
window.requestLatestMarket=requestLatestMarket;bootstrapAccess();
