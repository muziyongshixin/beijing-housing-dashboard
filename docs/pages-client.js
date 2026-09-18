/* Keep SQLite calculations off the UI thread so loading animations remain live. */
(()=>{
  let worker,serial=0,failed=null,progressListener;const pending=new Map();
  const fail=error=>{failed=error;for(const p of pending.values())p.reject(error);pending.clear();};
  try{worker=new Worker('./pages-worker.js?v=9d21cc3fa30232ab');}catch(e){fail(new Error('后台计算无法启动，请使用现代浏览器并通过 HTTP(S) 打开页面。'));}
  if(worker){worker.onmessage=({data:r})=>{const p=pending.get(r.id);if(r.progress!==undefined){(p?.progress||progressListener)?.(r.progress);return;}if(!p)return;pending.delete(r.id);r.error?p.reject(new Error(r.error)):p.resolve(r.value);};worker.onerror=()=>fail(new Error('后台计算加载失败，请刷新页面重试。'));worker.onmessageerror=()=>fail(new Error('后台计算结果读取失败，请刷新页面重试。'));}
  const call=(method,params,progress)=>new Promise((resolve,reject)=>{if(failed)return reject(failed);const id=++serial;pending.set(id,{resolve,reject,progress});try{worker.postMessage({id,method,params:params?.toString()||''});}catch(e){pending.delete(id);reject(new Error('后台计算请求失败，请刷新页面重试。'));}});
  window.DashboardData={initialize:progress=>{progressListener=progress;return call('initialize',null,progress);}};
  for(const method of ['analyze','trend','communityHeatmap','communityDetail','searchCommunities'])window.DashboardData[method]=params=>call(method,params);
})();
