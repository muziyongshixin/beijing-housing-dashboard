import {createClient} from '@supabase/supabase-js';
import {communityHistory} from './detail-math.mjs';
import {createAuthStorage} from './auth-storage.mjs';
const url='https://mehbviiakjcbfckonzqk.supabase.co';
// Intentionally public; authorization is enforced by PostgreSQL, not this key.
const publicKey='sb_publishable_XIAqA7evykNabGCZbaskfw_elj_bNwj';
const storageKey='housing-auth-mehbviiakjcbfckonzqk-v2';
const browserStorage=name=>{try{return window[name];}catch{return null;}};
const sessionStore=createAuthStorage({local:browserStorage('localStorage'),session:browserStorage('sessionStorage'),key:storageKey,legacyKey:'sb-mehbviiakjcbfckonzqk-auth-token'});
const client=createClient(url,publicKey,{auth:{storageKey,storage:sessionStore.storage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false},global:{fetch:(url,options)=>fetch(url,{...options,cache:'no-store',signal:options?.signal||AbortSignal.timeout(15000)})}});
window.HousingCloud={client,sessionStore,communityHistory,latestMonth:'2026-08',
  async validateViews(market,community){const {data,error}=await client.rpc('housing_validate_views',{p_market:market,p_community:community});if(error)throw error;if(data?.error)throw Error(data.error);return data;},
  async marketReport(params,requestId){
    const {data:{session},error}=await client.auth.getSession();
    if(error)throw error;if(!session||!sessionStore.isCurrent(session))throw Error('verified_email_required');
    const response=await fetch(url+'/functions/v1/market-report',{method:'POST',cache:'no-store',headers:{apikey:publicKey,Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'},
      body:JSON.stringify({params:params instanceof URLSearchParams?Object.fromEntries(params):params,request_id:requestId}),signal:AbortSignal.timeout(140000)});
    const body=await response.json();if(!response.ok||body?.error)throw Error(body?.error||'market_unavailable');
    if(!sessionStore.isCurrent(session))throw Error('verified_email_required');return body;
  },
  async signOut(){
    // Capture only the current access token; revoke remotely when reachable.
    // Local removal is immediate even if the network is down.
    const saved=sessionStore.storage.getItem(storageKey);sessionStore.clear();
    const token=saved?JSON.parse(saved).access_token:null;
    let error=null;
    if(token)try{const r=await fetch(url+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:publicKey,Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});if(!r.ok&&![401,403,404].includes(r.status))error=Error('remote_logout_unavailable');}catch(e){error=e;}
    // Do not call the SDK's second signOut after waiting for network: it could
    // delete a newer login in another tab. SDK reads our cleared adapter on
    // the next request; application logout events clear the visible UI.
    return{error};
  },
  async rpc(name,args={}){const{data,error}=await client.rpc(name,args);if(error)throw new Error(error.message);if(data?.error)throw new Error(data.error);return data;}
};
