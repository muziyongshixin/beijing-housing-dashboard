/* Coordinates are independent of price windows and account entitlements. */
((root)=>{
  const key=c=>`${c.district}|${c.business_area}|${c.community}`;
  const valid=v=>v&&Number.isFinite(Number(v.lng))&&Number.isFinite(Number(v.lat))&&Number(v.lng)>=115.4&&Number(v.lng)<=117.6&&Number(v.lat)>=39.4&&Number(v.lat)<=41.1;
  function create({storage,load,save,now=Date.now,locks,onPersistenceError=()=>{}}){
    const entries=Object.create(null),pending=new Map();let loaded,circuitUntil=0;
    const paused=()=>{try{circuitUntil=Math.max(circuitUntil,Number(storage?.getItem('amap-location:service-retry-after'))||0);}catch{}return circuitUntil>now();};
    const read=c=>{const k=key(c);try{const disk=JSON.parse(storage?.getItem(`amap-location:${k}`)||'null');if(disk&&((valid(disk)&&!valid(entries[k]))||(valid(disk)===!!valid(entries[k])&&Number(disk.updated_at||0)>=Number(entries[k]?.updated_at||0))))entries[k]=disk;}catch{}return entries[k]||null;};
    const reusable=v=>valid(v)||v&&Number(v.retry_after)>now();
    const ready=()=>loaded||(loaded=Promise.resolve().then(load).then(r=>{for(const[k,v]of Object.entries(r.locations||{})){if(valid(v)||!valid(entries[k]))entries[k]=v;if(v?.status==='error')circuitUntil=Math.max(circuitUntil,Number(v.retry_after)||0);}return entries;}).catch(e=>{loaded=null;throw e;}));
    const put=async(c,v)=>{const k=key(c);if(!valid(v)&&valid(read(c)))return entries[k];entries[k]=v;try{storage?.setItem(`amap-location:${k}`,JSON.stringify(v));}catch{}try{const r=await save(c,v);if(r?.saved===false)onPersistenceError();}catch{onPersistenceError();}return v;};
    const resolve=(c,search,{force=false,query=''}={})=>{
      const k=key(c);if(pending.has(k))return pending.get(k);
      const run=async()=>{
        await ready();const cached=read(c);
        if(!force&&reusable(cached))return{location:valid(cached)?cached:null,cached:true,status:cached.status||'located',retry_after:cached.retry_after};
        if(!force&&paused())return{location:null,cached:true,status:'paused',retry_after:circuitUntil};
        let result;try{result=await search();}catch(e){result={status:'error',message:e.message};}
        if(valid(result?.location)){
          const v={...c,...result.location,status:'located',coordinate_system:'GCJ-02',updated_at:now()};await put(c,v);return{location:v,cached:false,status:'located'};
        }
        const status=result?.status==='not_found'?'not_found':'error';
        // No-match is retried after 7 days; service failures back off for 15 minutes.
        const v={...c,status,query,updated_at:now(),retry_after:now()+(status==='not_found'?7*86400000:900000)};
        if(status==='error'){circuitUntil=now()+900000;try{storage?.setItem('amap-location:service-retry-after',String(circuitUntil));}catch{}}
        await put(c,v);return{location:null,cached:false,status,retry_after:v.retry_after,message:result?.message};
      };
      const promise=(locks?locks.request(`housing-location:${k}`,run):run()).finally(()=>pending.delete(k));pending.set(k,promise);return promise;
    };
    return{ready,read,resolve,put,valid,reusable,paused,entries};
  }
  root.HousingLocationCache={create,key,valid};
})(typeof window==='undefined'?globalThis:window);
