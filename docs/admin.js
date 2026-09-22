/* No admin email allowlist, service-role credential, analytics, or persisted codes. */
(() => {
  const $=id=>document.getElementById(id),cloud=window.HousingCloud;
  let epoch=0,authorized=false,busy=false,pending=null,checking=false;
  let knownAuthIdentity=cloud?.sessionStore?.identity(),checkAgain=false,activityUntil=Date.now()+60000;
  ['pointerdown','keydown'].forEach(event=>document.addEventListener(event,()=>{activityUntil=Date.now()+60000;},{passive:true}));
  const errors={admin_required:'无权访问。此页面仅允许超级管理员使用。',verified_email_required:'请先回首页验证邮箱登录。',recipient_not_verified:'该用户尚未注册或未验证邮箱，请先让对方完成邮箱验证。',order_conflict:'订单编号已存在且参数不同，或已撤销。请核对原订单，不要重复发码。',invalid_issue_parameters:'请检查邮箱、有效天数、次数及订单编号。',rate_limited:'操作频繁，请稍后重试。'};
  const message=e=>errors[e.message]||'请求未完成。请检查网络后重试；相同订单重试不会重复发码。';
  let cacheLoading=false;
  const bytes=n=>{n=Number(n);if(!Number.isFinite(n))return'—';const u=['B','KiB','MiB','GiB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return`${n.toFixed(i?1:0)} ${u[i]}`;};
  const text=v=>String(v??'—').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&gt;','>':'&gt;','"':'&quot;'}[c]));
  function clearCache(){cacheLoading=false;$('cacheStatus').textContent='';$('cacheStats').hidden=true;$('cacheEntries').innerHTML='<tr><td colspan="6" class="muted">缓存数据已清除，等待重新核验权限。</td></tr>';$('cacheTtl').value='';$('cacheBudget').value='';['cacheRefresh','cacheCleanup','cacheSaveSettings'].forEach(id=>$(id).disabled=false);}
  function clear(){pending=null;$('issuedCode').value='';$('issuedSummary').textContent='';$('issuedResult').hidden=true;$('recipientEmail').value='';$('issueConfirm').checked=false;clearCache();}
  function deny(text){epoch++;authorized=false;busy=false;clear();$('issueFields').disabled=false;$('issueButton').disabled=false;$('issueButton').textContent='生成兑换码';$('orderRef').value='';$('issueStatus').textContent='';$('adminPanel').hidden=true;$('adminGate').hidden=false;$('gateMessage').textContent=text;}
  function freshOrder(){$('orderRef').value=`WEB-${crypto.randomUUID()}`;}
  function renderCache(data){if(!authorized)return;const settings=data.settings||{};$('cachePayloadBytes').textContent=bytes(data.payload_bytes);$('cachePhysicalBytes').textContent=bytes(data.physical_bytes);$('cacheDatabaseBytes').textContent=bytes(data.database_bytes);$('cacheRevision').textContent=data.revision??'—';$('cacheStats').hidden=false;$('cacheTtl').value=settings.ttl_seconds??'';$('cacheBudget').value=Number.isFinite(Number(settings.budget_bytes))?Math.max(1,Math.round(Number(settings.budget_bytes)/1048576)):'';const entries=Array.isArray(data.entries)?data.entries:[];$('cacheEntries').innerHTML=entries.length?entries.map(row=>`<tr><td><code title="${text(row.cache_key)}">${text(String(row.cache_key||'').slice(0,12))}…</code></td><td><small>公 ${text(row.public_version)} · 私 ${text(row.private_version)} · 算 ${text(row.algorithm_version)}</small><br><small>${text(JSON.stringify(row.params||{}))}</small></td><td>${bytes(row.payload_bytes)}</td><td>${text(row.hits??0)}</td><td><small>${text(row.last_access_at||'—')}</small><br><small>到期 ${text(row.expires_at||'—')}</small></td><td><button type="button" class="cache-delete quiet" data-key="${text(row.cache_key)}">删除</button></td></tr>`).join(''):'<tr><td colspan="6" class="muted">当前没有缓存条目。</td></tr>';$('cacheEntries').querySelectorAll('.cache-delete').forEach(button=>button.onclick=()=>deleteCache(button.dataset.key));}
  async function cacheRequest(action='list',extra={}){if(!authorized||cacheLoading)return;const e=epoch;cacheLoading=true;['cacheRefresh','cacheCleanup','cacheSaveSettings'].forEach(id=>$(id).disabled=true);$('cacheStatus').textContent=action==='list'?'正在读取缓存元数据…':'正在提交缓存管理操作…';try{const data=await cloud.rpc('housing_admin_cache',{p_action:action,...extra});if(e!==epoch||!authorized)return;if(data?.error)throw Error(data.error);renderCache(data);$('cacheStatus').textContent=action==='expired'?`已请求清理过期条目${data.deleted!=null?`：删除 ${data.deleted} 条`:'。'}`:action==='delete'?`已请求删除缓存条目${data.deleted!=null?`：删除 ${data.deleted} 条`:'。'}`:action==='settings'?'缓存设置已保存。':'缓存元数据已刷新。';}catch(err){if(e!==epoch||!authorized)return;if(/admin_required|verified_email_required/.test(err.message)){deny(message(err));return;}$('cacheStatus').textContent='缓存操作未完成；请检查网络后刷新确认。无法仅凭网络失败判断服务端是否已执行。';}finally{if(e===epoch&&authorized){cacheLoading=false;['cacheRefresh','cacheCleanup','cacheSaveSettings'].forEach(id=>$(id).disabled=false);}}}
  async function deleteCache(key){if(!authorized||!key)return;if(!window.confirm('删除此缓存条目？正在处理的短暂重试可能会保留。'))return;await cacheRequest('delete',{p_key:key});}
  async function check(){if(checking){checkAgain=true;return;}checking=true;const e=epoch;
    try{if(!cloud)throw Error('service_unavailable');const {data:{session},error}=await cloud.client.auth.getSession();if(error)throw error;if(e!==epoch)return;
      if(!session){deny('请先在首页完成邮箱登录，再打开此页。');return;}
      const access=await cloud.rpc('housing_admin_access');if(e!==epoch)return;
      if(cloud.sessionStore&&!cloud.sessionStore.isCurrent(session)){deny('登录已过期，请回首页重新验证。');return;}
      if(!access.is_admin){deny(errors.admin_required);return;}
      if(!document.hidden&&Date.now()<activityUntil)cloud.sessionStore?.touch();knownAuthIdentity=cloud.sessionStore?.identity();
      authorized=true;$('adminGate').hidden=true;$('adminPanel').hidden=false;
      if(!$('orderRef').value)freshOrder();
    }catch(err){if(e===epoch)deny(message(err));}finally{checking=false;if(checkAgain){checkAgain=false;void check();}}}
  function params(){return{p_email:$('recipientEmail').value.trim().toLowerCase(),p_order_ref:$('orderRef').value.trim(),p_duration_days:Number($('durationDays').value),p_redeem_days:Number($('redeemDays').value),p_max_views:$('unlimitedViews').checked?null:Number($('maxViews').value)};}
  function randomCode(){const bytes=crypto.getRandomValues(new Uint8Array(32));return 'bj_'+btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
  $('unlimitedViews').onchange=()=>{$('maxViews').disabled=$('unlimitedViews').checked;$('maxViews').required=!$('unlimitedViews').checked;};
  $('issueForm').onsubmit=async ev=>{ev.preventDefault();if(!authorized||busy||!$('issueForm').reportValidity())return;const e=epoch,p=params();
    if(pending&&JSON.stringify(p)!==JSON.stringify(pending.params)){$('issueStatus').textContent='上次发码结果尚未确认，请先使用原参数重试。';return;}
    if(!pending)pending={params:p,token:randomCode()};busy=true;$('issueFields').disabled=true;$('issueButton').disabled=true;$('issueStatus').textContent='正在核验管理员身份并生成账号绑定兑换码…';
    try{const r=await cloud.rpc('housing_admin_issue',{...pending.params,p_token:pending.token});if(e!==epoch||!authorized)return;
      if(!r.ok)throw Error(r.error||'issue_failed');$('issuedCode').value=pending.token;
      $('issuedSummary').textContent=`${r.email} · ${r.duration_days} 天 · ${r.max_views==null?'不限次数':r.max_views+' 次'} · 需在 ${new Date(r.redeem_before).toLocaleString('zh-CN')} 前兑换 · ${r.order_ref}`;
      $('issuedResult').hidden=false;$('issueStatus').textContent='已生成。请复制并私聊交付，不要公开发送。';
    }catch(err){if(e!==epoch)return;if(/admin_required|verified_email_required/.test(err.message)){deny(message(err));return;}
      $('issueStatus').textContent=message(err);if(errors[err.message]){pending=null;$('issueFields').disabled=false;} // definite validation rejection
    }finally{if(e===epoch){busy=false;$('issueButton').disabled=!$('issuedResult').hidden;$('issueButton').textContent=pending&&$('issuedResult').hidden?'重试同一订单（不重复发码）':'生成兑换码';}}};
  $('copyCode').onclick=async()=>{if(!authorized||!$('issuedCode').value)return;const e=epoch;try{await navigator.clipboard.writeText($('issuedCode').value);if(e===epoch)$('issueStatus').textContent='已复制，请仅交付给指定用户。';}catch{if(e===epoch){$('issuedCode').select();$('issueStatus').textContent='无法自动复制，已选中，请手动复制。';}}};
  $('newIssue').onclick=()=>{clear();$('issueFields').disabled=false;$('issueButton').disabled=false;$('issueButton').textContent='生成兑换码';$('issueStatus').textContent='';freshOrder();};
  $('cacheRefresh').onclick=()=>cacheRequest();$('cacheCleanup').onclick=()=>cacheRequest('expired');$('cacheSettings').onsubmit=event=>{event.preventDefault();if(!$('cacheSettings').reportValidity())return;cacheRequest('settings',{p_ttl:Number($('cacheTtl').value),p_budget:Math.round(Number($('cacheBudget').value)*1048576)});};
  const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('housing-account'):null;
  $('adminLogout').onclick=async()=>{deny('已退出管理员页面。');channel?.postMessage('logout');try{if(cloud.signOut)await cloud.signOut();else await cloud.client.auth.signOut({scope:'local'});}catch{};};
  channel?.addEventListener('message',()=>deny('账号已退出，请重新登录。'));
  window.addEventListener('storage',e=>{if(e.key===null||e.key?.startsWith('housing-auth-mehbviiakjcbfckonzqk-v2')){const identity=cloud?.sessionStore?.identity();if(identity===knownAuthIdentity)return;knownAuthIdentity=identity;deny('账号状态已变化，正在重新核验。');void check();}});
  cloud?.client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')deny('账号已退出，请重新登录。');});
  window.addEventListener('pagehide',()=>deny('请重新核验管理员权限。'));
  window.addEventListener('pageshow',e=>{if(e.persisted)check();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});
  setInterval(check,15000);check();
})();
