/* First-visit orientation is informational, never a registration gate. */
(()=>{
  const guide=document.getElementById('welcomeDialog'),key='housing-guide-v1';
  const markSeen=()=>{try{localStorage.setItem(key,'seen');}catch{}};
  const close=()=>{markSeen();guide.close();};
  document.getElementById('closeWelcome').onclick=close;
  document.getElementById('startExploring').onclick=()=>{close();document.getElementById('communitySearch').focus();};
  guide.addEventListener('cancel',markSeen);
  ['openGuide','footerGuide'].forEach(id=>document.getElementById(id).onclick=()=>guide.showModal());
  let seen=false;try{seen=localStorage.getItem(key)==='seen';}catch{}
  if(!seen)guide.showModal();
  document.querySelectorAll('[data-jump]').forEach(b=>b.onclick=()=>{const id=b.dataset.jump;if(id!=='communitySearchTitle'){window.closeCommunityView?.();document.getElementById('communityDetail').hidden=true;document.getElementById('marketSection').hidden=false;}document.getElementById(id).scrollIntoView({behavior:'smooth',block:'start'});});
  document.querySelectorAll('[data-search]').forEach(b=>b.onclick=()=>{document.getElementById('communitySearch').value=b.dataset.search;searchCommunities();});
  // User-initiated copying only; never contact WeChat or send account information.
  const copyStatus=document.getElementById('purchaseCopyStatus');
  for(const [buttonId,inputId,label] of [['copyPurchasePhone','purchasePhone','手机号'],['copyPurchaseRemark','purchaseRemark','备注']]){
    document.getElementById(buttonId).onclick=async()=>{
      const input=document.getElementById(inputId);
      try{await navigator.clipboard.writeText(input.value);copyStatus.textContent=`${label}已复制，请打开微信搜索手机号并添加好友。`;}
      catch{input.focus();input.select();copyStatus.textContent=`无法自动复制，已选中${label}，请长按或手动复制。`;}
    };
  }
  document.getElementById('accessDialog').addEventListener('close',()=>{copyStatus.textContent='';});
})();
