import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const buyer=uid(1),admin=uid(2),other=uid(3),rid=n=>uid(100+n),key=n=>String(n).repeat(64);
const payload={config:{end_month:'2026-08'},benchmark:{},districts:[],communities:[],map:[],trends:{}};
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth,public to anon,authenticated,service_role;`);
 for(const f of ['202609170001_account_entitlements.sql','202609170002_catalog_and_read_limits.sql','202609170003_admin_and_view_quotas.sql','202609220007_market_cache.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8'));
 await db.exec(`insert into auth.users values('${buyer}','buyer@example.test',now(),false),('${admin}','admin@example.test',now(),false),('${other}','other@example.test',now(),false);
 insert into housing_private.super_admins values('${admin}',true,now());
 insert into housing_private.communities(id,district,business_area,community) values(1,'测试','测试','甲');
 insert into housing_private.transactions(id,community_id,sale_date,area,unit_price,sale_price) values(1,1,'2026-08-29',80,50000,400);
 insert into housing_private.paid_tokens(order_ref,token_hash,duration_days,redeem_before,redeemed_by,redeemed_at,expires_at,max_views) values('TEST-CACHE',repeat('a',64),30,now()+interval '1 day','${buyer}',now(),now()+interval '1 day',2);`);
});
after(()=>db.close());
async function as(role,who,sql,args=[]){await db.exec('begin');try{await db.query("select set_config('request.jwt.claim.sub',$1,true)",[who]);await db.exec('set local role '+role);const r=await db.query(sql,args);await db.exec('commit');return r.rows[0]?.r;}catch(e){await db.exec('rollback');throw e;}}
const rpc=(name,args)=>as('service_role','',`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args);
const begin=(who,r,k)=>rpc('housing_market_begin',[who,r,k,{},'snapshot',3,'test-v1']);
const deliver=(who,r,k)=>rpc('housing_market_deliver',[who,r,k]);
const used=async()=>Number((await db.query('select used_views from housing_private.paid_tokens')).rows[0].used_views);
test('internal computation/cache RPCs deny anonymous and normal authenticated callers',async()=>{
 for(const role of ['anon','authenticated']){
  await assert.rejects(as(role,buyer,'select public.housing_market_meta($1) r',[buyer]),/permission denied/);
  await assert.rejects(as(role,buyer,'select * from housing_private.market_cache'),/permission denied/);
 }
 await assert.rejects(as('authenticated',buyer,'select public.housing_admin_cache() r'),/admin_required/);
 assert.equal((await begin(other,rid(1),key(1))).error,'view_quota_exhausted');
});
test('failure, shared compute leases, null leases and missing cache never debit',async()=>{
 const a=await begin(buyer,rid(1),key(1));assert.ok(a.lease);
 assert.equal((await begin(admin,rid(2),key(1))).pending,true);
 assert.equal((await begin(buyer,rid(2),key(2))).error,'compute_busy');
 assert.equal((await rpc('housing_market_store',[key(2),null,payload])).error,'compute_lease_expired');
 assert.equal((await deliver(buyer,rid(3),key(3))).error,'cache_miss');assert.equal(await used(),0);
 await rpc('housing_market_release',[a.lease]);
 const b=await begin(buyer,rid(1),key(1));assert.ok(b.lease);assert.notEqual(b.lease,a.lease);
 assert.equal((await rpc('housing_market_store',[key(1),a.lease,payload])).error,'compute_lease_expired');
 assert.equal((await rpc('housing_market_store',[key(1),b.lease,payload])).ok,true);assert.equal(await used(),0);
});
test('one report and one community share balance; retry at zero is free, a new request denied',async()=>{
 const first=await deliver(buyer,rid(1),key(1));assert.equal(first.charged,true);assert.equal(first.access.remaining_views,1);assert.deepEqual(first.report,payload);
 assert.equal((await deliver(buyer,rid(1),key(1))).charged,false);assert.equal(await used(),1);
 assert.equal((await deliver(buyer,rid(1),key(2))).error,'view_scope_mismatch');
 const community=await as('authenticated',buyer,'select public.housing_view_community($1,$2,$3,$4) r',['测试','测试','甲',rid(2)]);
 assert.equal(community.charged,true);assert.equal(community.access.remaining_views,0);
 assert.equal((await deliver(buyer,rid(1),key(1))).charged,false);assert.equal((await begin(buyer,rid(1),key(1))).ready,true);
 assert.equal((await deliver(buyer,rid(4),key(1))).error,'view_quota_exhausted');assert.equal(await used(),2);
 const valid=await as('authenticated',buyer,'select public.housing_validate_views($1,$2) r',[rid(1),rid(2)]);assert.deepEqual(valid,{market_valid:true,community_valid:true});
 assert.deepEqual(await as('authenticated',other,'select public.housing_validate_views($1,$2) r',[rid(1),rid(2)]),{market_valid:false,community_valid:false});
});
test('admin free access; explicit cache expiry retains retries only; revoked grant invalidates exact receipt',async()=>{
 assert.equal((await deliver(admin,rid(5),key(1))).charged,false);assert.equal(await used(),2);
 await as('authenticated',admin,"select public.housing_admin_cache('delete',$1) r",[key(1)]);
 assert.equal((await deliver(buyer,rid(1),key(1))).charged,false);
 assert.equal((await deliver(admin,rid(6),key(1))).error,'cache_miss');
 await db.exec("update housing_private.paid_tokens set revoked_at=now()");
 assert.equal((await deliver(buyer,rid(1),key(1))).error,'market_locked');
 assert.deepEqual(await as('authenticated',buyer,'select public.housing_validate_views($1,$2) r',[rid(1),rid(2)]),{market_valid:false,community_valid:false});
});
test('dataset revision blocks stale new reports and lease storage; settings budget is bounded',async()=>{
 const a=await begin(admin,rid(6),key(2));assert.ok(a.lease);
 await db.exec("update housing_private.transactions set unit_price=51000 where id=1");
 assert.equal((await rpc('housing_market_store',[key(2),a.lease,payload])).error,'dataset_changed');
 await rpc('housing_market_release',[a.lease]);
 await assert.rejects(as('authenticated',admin,"select public.housing_admin_cache('settings',null,1,1) r"),/check constraint/);
 const list=await as('authenticated',admin,'select public.housing_admin_cache() r');assert.equal(list.revision,4);assert.ok(list.physical_bytes>0);assert.ok(list.entries.every(e=>!('payload' in e)));
});
