/* Keep SQLite calculations off the UI thread so loading animations remain live. */
(()=>{
  let worker,serial=0,failed=null,progressListener;const pending=new Map();
  const fail=error=>{
    failed=error;worker?.terminate();worker=null;
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}
    pending.clear();
  };
  function start(){
    try{worker=new Worker('./pages-worker.js?v=f62f957deba16b34');}catch(e){fail(new Error('后台计算无法启动，请使用现代浏览器并通过 HTTP(S) 打开页面。'));return;}
    const active=worker;
    worker.onmessage=({data:r})=>{
      if(active!==worker)return;
      const p=pending.get(r.id);
      if(r.progress!==undefined){(p?.progress||progressListener)?.(r.progress);return;}
      if(!p)return;
      clearTimeout(p.timer);pending.delete(r.id);
      r.error?p.reject(new Error(r.error)):p.resolve(r.value);
    };
    worker.onerror=()=>{if(active===worker)fail(new Error('后台计算加载失败，请刷新页面重试。'));};
    worker.onmessageerror=()=>{if(active===worker)fail(new Error('后台计算结果读取失败，请刷新页面重试。'));};
  }
  const call=(method,params,progress)=>new Promise((resolve,reject)=>{
    if(failed)return reject(failed);
    if(!worker)start();
    if(failed)return reject(failed);
    const id=++serial;
    // Custom queries may download the full public DB with two 90-second attempts.
    // A main-thread deadline also catches a stuck decoder/WASM worker.
    const timer=setTimeout(()=>{
      fail(new Error('后台计算超时，请检查网络后重试。'));
      failed=null; // The next request starts a fresh worker and reloads metadata.
    },method==='initialize'?45000:240000);
    pending.set(id,{resolve,reject,progress,timer});
    try{worker.postMessage({id,method,params:params?.toString()||''});}
    catch(e){clearTimeout(timer);pending.delete(id);reject(new Error('后台计算请求失败，请刷新页面重试。'));}
  });
  window.DashboardData={initialize:progress=>{progressListener=progress;return call('initialize',null,progress);}};
  for(const method of ['analyze','trend','communityHeatmap','communityDetail','searchCommunities'])window.DashboardData[method]=params=>call(method,params);
})();
