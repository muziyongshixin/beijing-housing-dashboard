import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {createAuthStorage} from '../static/auth-storage.mjs';

const key='sdk-auth-test',legacyKey='sdk-auth-test-legacy',ttlMs=7*864e5;
class Store { #items=new Map();getItem(k){return this.#items.get(k)??null;}setItem(k,v){this.#items.set(k,String(v));}removeItem(k){this.#items.delete(k);} }
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt({id='alice',sessionId='session-alice',exp=Math.floor(Date.now()/1000)+3600}={}) {
  return `${b64({alg:'none',typ:'JWT'})}.${b64({sub:id,session_id:sessionId,exp})}.signature`;
}
function authSession({id='alice',sessionId='session-alice',expired=false,accessToken}={}) {
  const exp=Math.floor(Date.now()/1000)+(expired?-60:3600),token=accessToken||jwt({id,sessionId,exp});
  return {access_token:token,refresh_token:`refresh-${sessionId}`,token_type:'bearer',expires_in:3600,expires_at:exp,user:{id,email:`${id}@example.test`}};
}
function clock(value=1_700_000_000_000){return{value,now(){return this.value;},advance(ms){this.value+=ms;}};}
function fixture({local=new Store(),session=new Store(),time=clock(),fetch}={}) {
  const authStorage=createAuthStorage({local,session,key,legacyKey,now:()=>time.now(),ttlMs});
  const client=createClient('https://example.test','public-anon-key',{auth:{storageKey:key,storage:authStorage.storage,persistSession:true,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch}});
  return {authStorage,client,local,session,time};
}
function fakeAuth({onVerify,onRefresh}={}) {
  const calls={otp:0,verify:0,refresh:0};
  return {calls,fetch:async(input,init={})=>{
    const url=String(input),body=init.body?JSON.parse(init.body):{};
    if(url.endsWith('/otp')){calls.otp++;return json({});}
    if(url.includes('/verify')){calls.verify++;const result=onVerify?.(body)??authSession();return json(result);}
    if(url.includes('/token?grant_type=refresh_token')){calls.refresh++;const result=await(onRefresh?.(body));if(result?.offline)return new Response(JSON.stringify({message:'offline'}),{status:result.status,headers:{'content-type':'application/json'}});return json(result??authSession({accessToken:jwt({sessionId:'session-alice'})}));}
    throw Error(`Unexpected local fetch: ${url}`);
  }};
}

test('real SDK verifyOtp persists remembered session, which a new SDK client restores without another OTP',async()=>{
  const api=fakeAuth(),local=new Store(),first=fixture({local,fetch:api.fetch});
  await first.client.auth.getSession();
  first.authStorage.beginLogin(true);
  const verified=await first.client.auth.verifyOtp({email:'alice@example.test',token:'123456',type:'email'});
  first.authStorage.finishLogin();
  assert.equal(verified.error,null);assert.equal(verified.data.session.user.id,'alice');assert.equal(api.calls.verify,1);
  const second=fixture({local,session:new Store(),time:first.time,fetch:api.fetch});
  const restored=await second.client.auth.getSession();
  assert.equal(restored.error,null);assert.equal(restored.data.session.user.id,'alice');
  assert.equal(api.calls.verify,1,'restoring from local session must not repeat OTP verification');
  assert.equal(api.calls.otp,0);
});

test('a new SDK client automatically refreshes a stored expired access token with the same stable session_id',async()=>{
  const refreshed=authSession({sessionId:'session-alice',accessToken:jwt({sessionId:'session-alice'})});
  const api=fakeAuth({onRefresh:()=>refreshed});
  const f=fixture({fetch:api.fetch});await f.client.auth.getSession();f.authStorage.beginLogin();
  await f.client.auth.verifyOtp({email:'alice@example.test',token:'123456',type:'email'});f.authStorage.finishLogin();
  f.authStorage.storage.setItem(key,JSON.stringify(authSession({expired:true,sessionId:'session-alice'})));
  const restored=fixture({local:f.local,session:new Store(),time:f.time,fetch:api.fetch});
  const result=await restored.client.auth.getSession();
  assert.equal(result.error,null);assert.ok(result.data.session);assert.equal(result.data.session.refresh_token,'refresh-session-alice');
  assert.equal(api.calls.refresh,1);assert.equal(restored.authStorage.isCurrent(result.data.session),true);
});

test('a network failure during refresh returns an error but retains the prior stored session',async()=>{
  const originalNow=Date.now,start=Date.now();
  const api=fakeAuth({onRefresh:()=>{Date.now=()=>start+1_000_000;return{offline:true,status:503};}});
  const f=fixture({fetch:api.fetch});await f.client.auth.getSession();f.authStorage.beginLogin();
  await f.client.auth.verifyOtp({email:'alice@example.test',token:'123456',type:'email'});f.authStorage.finishLogin();
  const before=f.authStorage.storage.getItem(key);
  try{
    const result=await f.client.auth.refreshSession();
    assert.ok(result.error);assert.equal(f.authStorage.storage.getItem(key),before);assert.equal(api.calls.refresh,1);
  }finally{Date.now=originalNow;}
});

test('the storage seven-day expiry prevents a new SDK client from reviving the old session',async()=>{
  const api=fakeAuth(),time=clock(),local=new Store(),f=fixture({local,time,fetch:api.fetch});await f.client.auth.getSession();f.authStorage.beginLogin();
  await f.client.auth.verifyOtp({email:'alice@example.test',token:'123456',type:'email'});f.authStorage.finishLogin();
  time.advance(ttlMs);
  const reopened=fixture({local,session:new Store(),time,fetch:api.fetch});
  const result=await reopened.client.auth.getSession();
  assert.equal(result.data.session,null);assert.equal(reopened.authStorage.storage.getItem(key),null);assert.equal(api.calls.refresh,0);
});

test('offline clear wins over a late real-SDK refresh response and cannot restore the session',async()=>{
  let release;const started=new Promise(resolve=>{release=resolve;});
  const fresh=authSession({sessionId:'session-alice',accessToken:jwt({sessionId:'session-alice'})});
  const api=fakeAuth({onRefresh:async()=>{await started;return fresh;}});
  const f=fixture({fetch:api.fetch});await f.client.auth.getSession();f.authStorage.beginLogin();
  await f.client.auth.verifyOtp({email:'alice@example.test',token:'123456',type:'email'});f.authStorage.finishLogin();
  let refreshStarted;const waitForRefresh=new Promise(resolve=>{refreshStarted=resolve;});
  const fetchWithSignal=async(...args)=>{const url=String(args[0]);if(url.includes('/token?grant_type=refresh_token'))refreshStarted();return api.fetch(...args);};
  const lateClient=createClient('https://example.test','public-anon-key',{auth:{storageKey:key,storage:f.authStorage.storage,persistSession:true,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:fetchWithSignal}});await lateClient.auth.getSession();
  const pending=lateClient.auth.refreshSession();await waitForRefresh;f.authStorage.clear();release();
  const result=await pending;
  assert.equal(result.error,null);assert.ok(result.data.session);assert.equal(f.authStorage.isCurrent(result.data.session),false);
  assert.equal(f.authStorage.storage.getItem(key),null);assert.equal((await lateClient.auth.getSession()).data.session,null);
});

test('a late refresh for the same account but a different JWT session_id is rejected',async()=>{
  const api=fakeAuth({onRefresh:()=>authSession({sessionId:'newer-session'})});
  const f=fixture({fetch:api.fetch});await f.client.auth.getSession();f.authStorage.beginLogin();
  await f.client.auth.verifyOtp({email:'alice@example.test',token:'123456',type:'email'});f.authStorage.finishLogin();
  const before=f.authStorage.storage.getItem(key),result=await f.client.auth.refreshSession();
  assert.equal(result.error,null);assert.ok(result.data.session);assert.equal(result.data.session.refresh_token,'refresh-newer-session');
  assert.equal(f.authStorage.storage.getItem(key),before,'old lease must reject a different server session');
  assert.equal(f.authStorage.isCurrent(result.data.session),false);
});
