// Browser convenience only: Supabase still validates every protected request.
// Never store OTPs, paid redemption codes or transaction data here.
export function createAuthStorage({local,session,key,legacyKey,now=Date.now,ttlMs=7*86400000}){
  const memory=new Map(),memoryStorage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
  function usable(storage){
    try{const probe=key+':probe';storage.setItem(probe,'1');storage.removeItem(probe);return storage;}catch{return null;}
  }
  const persistent=usable(local),temporary=usable(session)||memoryStorage;
  const epochKey=key+':epoch',stores=[persistent,temporary].filter(Boolean);
  let login=null,lease=null,blocked=false;
  const get=(s,k)=>{try{return s?.getItem(k)??null;}catch{return null;}};
  const remove=(s,k)=>{try{s?.removeItem(k);}catch{}};
  const put=(s,k,v)=>{try{s.setItem(k,v);return true;}catch{return false;}};
  const epoch=()=>get(persistent||temporary,epochKey)||'';
  const newEpoch=()=>{const v=now()+':'+Math.random().toString(36).slice(2);put(persistent||temporary,epochKey,v);return v;};
  function validSession(value){try{const s=JSON.parse(value);return s?.access_token&&s?.refresh_token&&s?.user?.id?s:null;}catch{return null;}}
  // Compare the stable Supabase session id, not a rotating access token.
  // Decoding is only for race detection; authorization always happens on server.
  function sessionId(s){try{return JSON.parse(atob(s.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).session_id||'';}catch{return '';}}
  const sameSession=(a,b)=>a?.user?.id===b?.user?.id&&sessionId(a)===sessionId(b);
  function read(){
    for(const s of stores){
      const raw=get(s,key);if(!raw)continue;
      try{
        const record=JSON.parse(raw);
        if(record.v===1&&record.epoch===epoch()&&Number.isFinite(record.expiresAt)&&record.expiresAt>now()&&validSession(record.value))return{...record,store:s};
      }catch{}
      remove(s,key);
    }
    return null;
  }
  // Preserve old session-only logins without silently making them persistent.
  if(legacyKey&&legacyKey!==key){
    const old=get(temporary,legacyKey),existing=read();
    if(!existing&&!epoch()&&validSession(old)){
      const record={v:1,value:old,expiresAt:now()+ttlMs,remembered:false,epoch:newEpoch()};
      put(temporary,key,JSON.stringify(record));
    }
    remove(temporary,legacyKey);
  }
  function clear(){
    blocked=true;login=null;lease=null;newEpoch();
    for(const s of stores){remove(s,key);remove(s,key+'-code-verifier');remove(s,key+'-user');if(legacyKey)remove(s,legacyKey);}
  }
  const storage={
    getItem(k){
      if(k!==key)return null;
      const r=read();lease=r?.epoch??null;if(r)blocked=false;return r?.value??null;
    },
    setItem(k,value){
      if(k!==key||blocked||!validSession(value))return;
      const current=read();
      if(login){
        if(login.epoch!==epoch())return;
        const record={v:1,value,expiresAt:now()+ttlMs,remembered:login.remember&&!!persistent,epoch:login.epoch};
        for(const s of stores)remove(s,key);
        if(!put(record.remembered?persistent:temporary,key,JSON.stringify(record))){
          record.remembered=false;put(temporary,key,JSON.stringify(record));
        }
        lease=record.epoch;return;
      }
      // A late refresh must not revive a logged-out/expired/replaced account.
      if(!current||lease!==current.epoch||!sameSession(validSession(current.value),validSession(value)))return;
      const {store,...record}=current;put(store,key,JSON.stringify({...record,value}));
    },
    removeItem(k){if(k===key){const r=read();if(r&&r.epoch!==lease)return;clear();}},
  };
  return{
    storage,
    beginLogin(remember=true){blocked=false;login={remember,epoch:newEpoch()};for(const s of stores)remove(s,key);lease=null;},
    finishLogin(){login=null;},
    clear,
    touch(){const r=read();if(!r)return false;const {store,...record}=r;return put(store,key,JSON.stringify({...record,expiresAt:now()+ttlMs}));},
    isCurrent(value){const r=read();return !!r&&!!value?.user?.id&&sameSession(validSession(r.value),value);},
    identity(){const r=read();if(!r)return null;const s=validSession(r.value);return r.epoch+':'+s.user.id+':'+sessionId(s);},
    status(){const r=read();return{remembered:!!r?.remembered,expiresAt:r?.expiresAt??null,persistentAvailable:!!persistent};},
  };
}
