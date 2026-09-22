import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAuthStorage} from '../static/auth-storage.mjs';

const key='housing.auth.session',legacyKey='housing.auth.legacy',ttlMs=7*864e5;
const session=(id='alice',token='access')=>JSON.stringify({access_token:token,refresh_token:`refresh-${id}`,user:{id}});

class MemoryStore {
  #data=new Map();
  getItem(key){return this.#data.has(key)?this.#data.get(key):null;}
  setItem(key,value){this.#data.set(key,String(value));}
  removeItem(key){this.#data.delete(key);}
  entries(){return Object.fromEntries(this.#data);}
}
class BlockedStore {
  getItem(){throw Error('storage disabled');}
  setItem(){throw Error('storage disabled');}
  removeItem(){throw Error('storage disabled');}
}
const clock=(value=1_700_000_000_000)=>({value,now(){return this.value;},advance(ms){this.value+=ms;}});
function make({local=new MemoryStore(),sessionStore=new MemoryStore(),time=clock(),...options}={}) {
  const auth=createAuthStorage({local,session:sessionStore,key,legacyKey,now:()=>time.now(),ttlMs,...options});
  return {auth,local,sessionStore,time};
}
function logIn(f,{remember=true,value=session()}={}) {
  f.auth.beginLogin(remember);
  f.auth.storage.setItem(key,value);
  f.auth.finishLogin();
}

test('does not write a session until an explicit OTP login is begun',()=>{
  const local=new MemoryStore(),sessionStore=new MemoryStore();
  local.setItem('unrelated.local','keep');sessionStore.setItem('unrelated.session','keep');
  make({local,sessionStore});
  assert.deepEqual(local.entries(),{'unrelated.local':'keep'});
  assert.deepEqual(sessionStore.entries(),{'unrelated.session':'keep'});
});

test('remembered OTP session survives a new browser instance, while a fresh tab has no session storage',()=>{
  const local=new MemoryStore(),first=make({local});
  logIn(first);
  assert.notEqual(first.local.getItem(key),null);
  assert.equal(first.sessionStore.getItem(key),null);
  const reopened=make({local,sessionStore:new MemoryStore(),time:first.time});
  assert.equal(reopened.auth.storage.getItem(key),session());
  assert.deepEqual(reopened.auth.status(),{remembered:true,expiresAt:first.time.now()+ttlMs,persistentAvailable:true});
});

test('a non-remembered session is confined to its tab and is not restored in a new one',()=>{
  const local=new MemoryStore(),tab=make({local});
  logIn(tab,{remember:false});
  assert.notEqual(tab.sessionStore.getItem(key),null);
  assert.equal(tab.local.getItem(key),null);
  const freshTab=make({local,sessionStore:new MemoryStore(),time:tab.time});
  assert.equal(freshTab.auth.storage.getItem(key),null);
  assert.equal(freshTab.auth.status().remembered,false);
});

test('a session expires exactly at the seven-day boundary and is removed',()=>{
  const f=make();logIn(f);
  f.time.advance(ttlMs-1);assert.equal(f.auth.storage.getItem(key),session());
  f.time.advance(1);assert.equal(f.auth.storage.getItem(key),null);
  assert.deepEqual(f.auth.status(),{remembered:false,expiresAt:null,persistentAvailable:true});
  assert.equal(f.local.getItem(key),null);
});

test('ordinary SDK setItem refreshes preserve expiry; only touch slides it after successful validation',()=>{
  const f=make();logIn(f);const initial=f.auth.status().expiresAt;
  f.time.advance(60_000);
  f.auth.storage.setItem(key,session('alice','rotated'));
  assert.equal(f.auth.status().expiresAt,initial);
  assert.equal(f.auth.isCurrent(JSON.parse(session('alice','other-rotated'))),true,'identity, not token, defines current user');
  f.auth.touch();
  assert.equal(f.auth.status().expiresAt,f.time.now()+ttlMs);
  assert.ok(f.auth.status().expiresAt>initial);
});

test('clear invalidates this instance before a late SDK refresh can write it back',()=>{
  const f=make();logIn(f);f.auth.clear();
  f.auth.storage.setItem(key,session('alice','late'));
  assert.equal(f.auth.storage.getItem(key),null);
  assert.equal(f.local.getItem(key),null);
  assert.equal(f.sessionStore.getItem(key),null);
});

test('clear in one instance prevents another existing instance from resurrecting a stale refresh',()=>{
  const local=new MemoryStore(),time=clock(),first=make({local,time});logIn(first);
  const second=make({local,sessionStore:new MemoryStore(),time});
  assert.equal(second.auth.storage.getItem(key),session());
  first.auth.clear();
  second.auth.storage.setItem(key,session('alice','late-from-other-tab'));
  assert.equal(second.auth.storage.getItem(key),null);
  assert.equal(local.getItem(key),null);
});

test('a stale failed refresh cannot remove a newer login in another tab',()=>{
  const local=new MemoryStore(),time=clock(),first=make({local,time});logIn(first);
  const second=make({local,time});second.auth.storage.getItem(key);
  first.auth.clear();logIn(first,{value:session('bob')});
  second.auth.storage.removeItem(key);
  assert.equal(first.auth.storage.getItem(key),session('bob'));
  assert.equal(second.auth.storage.getItem(key),session('bob'));
  second.auth.storage.setItem(key,session('bob','rotated'));
  assert.equal(first.auth.storage.getItem(key),session('bob','rotated'));
});

test('garbage session JSON is deleted and never treated as a current login',()=>{
  const f=make();f.local.setItem(key,'not json');
  assert.equal(f.auth.storage.getItem(key),null);
  assert.equal(f.local.getItem(key),null);
  assert.equal(f.auth.isCurrent(session()),false);
});

test('legacy sessionStorage is retained as session-only, and cannot override a newer remembered account',()=>{
  const local=new MemoryStore(),oldTab=new MemoryStore(),time=clock();
  oldTab.setItem(legacyKey,session('alice'));
  const migrated=make({local,sessionStore:oldTab,time});
  assert.equal(migrated.auth.storage.getItem(key),session('alice'));
  assert.equal(local.getItem(key),null,'old tab state needs no consent escalation to localStorage');
  assert.equal(migrated.auth.status().remembered,false);
  const newerLocal=new MemoryStore(),newerTab=new MemoryStore();
  const remembered=make({local:newerLocal,sessionStore:new MemoryStore(),time});logIn(remembered,{value:session('bob')});
  newerTab.setItem(legacyKey,session('alice'));
  const chosen=make({local:newerLocal,sessionStore:newerTab,time});
  assert.equal(chosen.auth.storage.getItem(key),session('bob'));
  assert.equal(chosen.auth.isCurrent(JSON.parse(session('bob','rotated'))),true);
});

test('blocked localStorage falls back safely to session storage and reports no persistent capability',()=>{
  const sessionStore=new MemoryStore(),f=make({local:new BlockedStore(),sessionStore});
  assert.doesNotThrow(()=>logIn(f));
  assert.equal(f.auth.storage.getItem(key),session());
  assert.notEqual(sessionStore.getItem(key),null);
  assert.deepEqual(f.auth.status(),{remembered:false,expiresAt:f.time.now()+ttlMs,persistentAvailable:false});
});

test('clear removes only auth keys in both stores plus legacy, preserving unrelated application data',()=>{
  const f=make();logIn(f);f.sessionStore.setItem(legacyKey,session('legacy'));f.local.setItem(legacyKey,session('legacy'));
  f.local.setItem('unrelated.local','keep');f.sessionStore.setItem('unrelated.session','keep');
  f.auth.clear();
  for(const store of [f.local,f.sessionStore]){
    assert.equal(store.getItem(key),null);assert.equal(store.getItem(legacyKey),null);
  }
  assert.equal(f.local.getItem('unrelated.local'),'keep');
  assert.equal(f.sessionStore.getItem('unrelated.session'),'keep');
});
