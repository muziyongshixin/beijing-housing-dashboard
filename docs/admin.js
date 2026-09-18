/* No admin email allowlist, service-role credential, analytics, or persisted codes. */
(() => {
  const $=id=>document.getElementById(id),cloud=window.HousingCloud;
  let epoch=0,authorized=false,busy=false,pending=null,checking=false;
  const errors={admin_required:'无权访问。此页面仅允许超级管理员使用。',verified_email_required:'请先回首页验证邮箱登录。',recipient_not_verified:'该用户尚未注册或未验证邮箱，请先让对方完成邮箱验证。',order_conflict:'订单编号已存在且参数不同，或已撤销。请核对原订单，不要重复发码。',invalid_issue_parameters:'请检查邮箱、有效天数、次数及订单编号。',rate_limited:'操作频繁，请稍后重试。'};
  const message=e=>errors[e.message]||'请求未完成。请检查网络后重试；相同订单重试不会重复发码。';
  function clear(){pending=null;$('issuedCode').value='';$('issuedSummary').textContent='';$('issuedResult').hidden=true;$('recipientEmail').value='';$('issueConfirm').checked=false;}
  function deny(text){epoch++;authorized=false;busy=false;clear();$('issueFields').disabled=false;$('issueButton').disabled=false;$('issueButton').textContent='生成兑换码';$('orderRef').value='';$('issueStatus').textContent='';$('adminPanel').hidden=true;$('adminGate').hidden=false;$('gateMessage').textContent=text;}
  function freshOrder(){$('orderRef').value=`WEB-${crypto.randomUUID()}`;}
  async function check(){if(checking)return;checking=true;const e=epoch;
    try{if(!cloud)throw Error('service_unavailable');const {data:{session}}=await cloud.client.auth.getSession();if(e!==epoch)return;
      if(!session){deny('请先在首页完成邮箱登录，再打开此页。');return;}
      const access=await cloud.rpc('housing_admin_access');if(e!==epoch)return;
      if(!access.is_admin){deny(errors.admin_required);return;}
      authorized=true;$('adminGate').hidden=true;$('adminPanel').hidden=false;
      if(!$('orderRef').value)freshOrder();
    }catch(err){if(e===epoch)deny(message(err));}finally{checking=false;}}
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
  const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('housing-account'):null;
  $('adminLogout').onclick=async()=>{deny('已退出管理员页面。');channel?.postMessage('logout');try{await cloud.client.auth.signOut({scope:'local'});}catch{};};
  channel?.addEventListener('message',()=>deny('账号已退出，请重新登录。'));
  cloud?.client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')deny('账号已退出，请重新登录。');});
  window.addEventListener('pagehide',()=>deny('请重新核验管理员权限。'));
  window.addEventListener('pageshow',e=>{if(e.persisted)check();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});
  setInterval(check,15000);check();
})();
