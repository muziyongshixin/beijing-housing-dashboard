import {createClient} from '@supabase/supabase-js';
import {communityHistory} from './detail-math.mjs';
const url='https://mehbviiakjcbfckonzqk.supabase.co';
// Intentionally public; authorization is enforced by PostgreSQL, not this key.
const publicKey='sb_publishable_XIAqA7evykNabGCZbaskfw_elj_bNwj';
const safeStorage={getItem(k){try{return sessionStorage.getItem(k);}catch{return null;}},setItem(k,v){try{sessionStorage.setItem(k,v);}catch{}},removeItem(k){try{sessionStorage.removeItem(k);}catch{}}};
const client=createClient(url,publicKey,{auth:{storage:safeStorage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false},global:{fetch:(url,options)=>fetch(url,{...options,cache:'no-store',signal:options?.signal||AbortSignal.timeout(15000)})}});
window.HousingCloud={client,communityHistory,latestMonth:'2026-08',async rpc(name,args={}){const{data,error}=await client.rpc(name,args);if(error)throw new Error(error.message);if(data?.error)throw new Error(data.error);return data;}};
