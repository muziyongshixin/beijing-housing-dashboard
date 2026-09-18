import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Actual PostgreSQL engine, synthetic fixtures only. Does not connect to Supabase.
const db = new PGlite();
const users = {
  alice: '00000000-0000-0000-0000-000000000001',
  bob: '00000000-0000-0000-0000-000000000002',
  unverified: '00000000-0000-0000-0000-000000000003',
  anonymous: '00000000-0000-0000-0000-000000000004',
  admin: '00000000-0000-0000-0000-000000000005',
  buyer: '00000000-0000-0000-0000-000000000006',
};
before(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean);
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid$$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/202609170001_account_entitlements.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202609170002_catalog_and_read_limits.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202609170003_admin_and_view_quotas.sql', import.meta.url), 'utf8'));
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values ($1,$2,$3,$4)',
      [id, `${name}@example.test`, name === 'unverified' ? null : '2026-09-01', name === 'anonymous']);
  }
  await db.exec(`
    insert into housing_private.super_admins(user_id) values ('${users.admin}');
    insert into housing_private.communities(id,district,business_area,community) values
      (1,'测试区','测试商圈','甲'),(2,'测试区','测试商圈','乙'),
      (3,'测试区','测试商圈','丙'),(4,'测试区','测试商圈','仅旧数据');
    insert into housing_private.transactions(id,community_id,sale_date,area,unit_price,sale_price,listing_price)
    values (1,1,'2025-09-01',80,50000,400,420),(2,1,'2026-08-29',80,40000,320,350),
      (3,2,'2026-08-29',70,40000,280,300),(4,3,'2026-08-29',90,40000,360,390);
  `);
});
after(async () => db.close());

async function asUser(name, sql, params = [], role = 'authenticated') {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [users[name] || '']);
    await db.exec(`set local role ${role}`);
    const out = await db.query(sql, params);
    await db.exec('commit');
    return out.rows[0]?.result;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}
const access = name => asUser(name, 'select public.housing_access() as result');
const claim = (name, c) => asUser(name, 'select public.housing_claim_trial($1,$2,$3) as result', ['测试区','测试商圈',c]);
const records = (name, c, date = null, id = null, size = 200) => asUser(name,
  'select public.housing_new_transactions($1,$2,$3,$4,$5,$6) as result', ['测试区','测试商圈',c,date,id,size]);
const redeem = (name, token) => asUser(name, 'select public.housing_redeem($1) as result', [token]);
const token = 'bj_' + 'a'.repeat(43);

test('anon, anonymous auth and unverified emails have no private access', async () => {
  await assert.rejects(asUser('', 'select public.housing_access() as result', [], 'anon'), /permission denied/);
  for (const name of ['unverified','anonymous']) {
    await assert.rejects(access(name), /verified_email_required/);
    await assert.rejects(claim(name,'甲'), /verified_email_required/);
    await assert.rejects(records(name,'甲'), /verified_email_required/);
    await assert.rejects(redeem(name,token), /verified_email_required/);
  }
});

test('private tables, internal privilege helpers and token lists are inaccessible', async () => {
  for (const table of ['communities','transactions','accounts','trial_unlocks','paid_tokens','redeem_limits']) {
    await assert.rejects(asUser('alice', `select * from housing_private.${table}`), /permission denied/);
  }
  await assert.rejects(asUser('alice', 'select housing_private.paid_until($1) as result', [users.alice]), /permission denied/);
  const r = await db.query("select relname, relrowsecurity from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='housing_private' and c.relkind='r'");
  assert.ok(r.rows.every(x => x.relrowsecurity));
});

test('trial quota is account-bound, idempotent, and excludes old-only or nonexistent communities', async () => {
  assert.equal((await access('alice')).trial_communities.length, 0);
  assert.equal((await claim('alice','仅旧数据')).code, 'no_new_data');
  assert.equal((await claim('alice','不存在')).code, 'no_new_data');
  await assert.rejects(records('alice','甲'), /community_locked/);
  for (const c of ['甲','甲','乙']) assert.equal((await claim('alice',c)).ok,true);
  assert.equal((await access('alice')).trial_communities.length,2);
  assert.equal((await claim('alice','丙')).code,'trial_exhausted');
  await assert.rejects(records('alice','丙'), /community_locked/);
  assert.equal((await access('bob')).trial_communities.length,0);
  assert.equal((await claim('bob','丙')).ok,true);
  await assert.rejects(records('bob','甲'), /community_locked/);
});

test('keyset pagination preserves boundary rows and cannot change community scope', async () => {
  const first = await records('alice','甲',null,null,1);
  assert.equal(first.transactions[0].sale_date,'2025-09-01');
  const second = await records('alice','甲','2025-09-01',1,1);
  assert.equal(second.transactions[0].id,2);
  assert.equal((await records('alice','甲','2026-08-29',2)).transactions.length,0);
  assert.equal(second.transactions[0].listing_unit_price,43750);
  await assert.rejects(records('alice','丙','1900-01-01',0), /community_locked/);
  for (const size of [null,0,201,-1]) await assert.rejects(records('alice','甲',null,null,size), /invalid_pagination/);
  await assert.rejects(records('alice','甲','2025-09-01',null), /invalid_pagination/);
  await assert.rejects(db.exec("insert into housing_private.transactions values (9,1,'2025-08-31',80,10000,80,null,null,null,null,null,null,null)"), /check constraint/);
});

test('redemption binds account, starts duration at redemption and never extends on retry', async () => {
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query(`insert into housing_private.paid_tokens(order_ref,token_hash,duration_days,redeem_before,intended_user_id)
    values ('TEST-ONLY-ORDER',$1,7,now()+interval '3 days',$2)`,[hash,users.alice]);
  assert.equal((await redeem('bob',token)).ok,false);
  const first = await redeem('alice',token);
  assert.equal(first.ok,true); assert.equal(first.access.tier,'paid');
  assert.equal((await redeem('alice',token)).access.expires_at,first.access.expires_at);
  assert.equal((await records('alice','丙')).transactions.length,1);
  assert.equal((await claim('alice','丙')).access.trial_communities.length,2);
  assert.equal((await redeem('bob',token)).ok,false);
  const expiry = Date.parse(first.access.expires_at);
  assert.ok(Math.abs(expiry-Date.now()-7*86400000)<10000);
  await db.exec("update housing_private.paid_tokens set revoked_at=now(), revoke_reason='synthetic test'");
  assert.equal((await access('alice')).tier,'registered');
  await assert.rejects(records('alice','丙'), /community_locked/);
  assert.equal((await records('alice','甲')).transactions.length,2);
  assert.equal((await redeem('alice',token)).ok,false);
});

test('expired/invalid tokens fail, and invalid attempts consume a server-side limit', async () => {
  await db.exec("update housing_private.paid_tokens set revoked_at=null, expires_at=now()-interval '1 second'");
  assert.equal((await redeem('alice',token)).ok,false);
  await assert.rejects(records('alice','丙'), /community_locked/);
  for (let i=0;i<11;i++) await redeem('bob','wrong');
  assert.equal((await redeem('bob','wrong')).code,'rate_limited');
  const other = 'bj_'+'b'.repeat(43);
  await db.query(`insert into housing_private.paid_tokens(order_ref,token_hash,duration_days,redeem_before)
    values ('TEST-EXPIRED',$1,7,now()-interval '1 day')`,[createHash('sha256').update(other).digest('hex')]);
  assert.equal((await redeem('alice',other)).ok,false);
});

const limitedCode='bj_'+'z'.repeat(43);
const issue=(name,overrides={})=>asUser(name,'select public.housing_admin_issue($1,$2,$3,$4,$5,$6) as result',
  Object.values({email:'buyer@example.test',code:limitedCode,order:'ADMIN-QA-ORDER-1',days:30,redeemDays:7,max:2,...overrides}));
const view=(name,c,id)=>asUser(name,'select public.housing_view_community($1,$2,$3,$4) as result',['测试区','测试商圈',c,id]);
test('only server-provisioned administrator can issue; spoofed metadata and direct table access fail',async()=>{
  for(const name of ['alice','bob','buyer'])await assert.rejects(issue(name),/admin_required/);
  for(const name of ['unverified','anonymous'])await assert.rejects(issue(name),/verified_email_required/);
  await assert.rejects(asUser('','select public.housing_admin_access() as result',[],'anon'),/permission denied/);
  await assert.rejects(asUser('alice',`insert into housing_private.super_admins(user_id) values ('${users.alice}')`),/permission denied/);
  await assert.rejects(asUser('admin','select * from housing_private.paid_tokens'),/permission denied/);
  assert.equal((await asUser('admin','select public.housing_admin_access() as result')).is_admin,true);
  assert.equal((await access('admin')).tier,'admin');
  assert.equal((await issue('admin',{email:'missing@example.test'})).error,'recipient_not_verified');
  assert.equal((await issue('admin',{email:'unverified@example.test'})).error,'recipient_not_verified');
  for(const max of [0,-1,1000001])assert.equal((await issue('admin',{max})).error,'invalid_issue_parameters');
  const first=await issue('admin');assert.equal(first.ok,true);assert.equal(first.max_views,2);
  assert.deepEqual(await issue('admin'),first);
  assert.equal((await issue('admin',{max:200})).error,'order_conflict');
  const rows=(await db.query("select * from housing_private.paid_tokens where order_ref='ADMIN-QA-ORDER-1'")).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].token_hash,createHash('sha256').update(limitedCode).digest('hex'));
  assert.equal(rows[0].issued_by,users.admin);assert.ok(!JSON.stringify(rows).includes(limitedCode));
});
test('limited views deduct once per successful request, retry is bound and old API cannot bypass quota',async()=>{
  assert.equal((await redeem('buyer',limitedCode)).ok,true);
  assert.equal((await access('buyer')).remaining_views,2);
  const id='11111111-1111-4111-8111-111111111111',id2='22222222-2222-4222-8222-222222222222',id3='33333333-3333-4333-8333-333333333333';
  assert.equal((await view('buyer','不存在',id)).error,'no_new_data');
  assert.equal((await access('buyer')).remaining_views,2);
  const first=await view('buyer','甲',id);assert.equal(first.charged,true);assert.equal(first.transactions.length,2);assert.equal(first.access.remaining_views,1);
  assert.equal((await view('buyer','甲',id)).charged,false);assert.equal((await access('buyer')).remaining_views,1);
  assert.equal((await view('buyer','乙',id)).error,'view_scope_mismatch');
  await assert.rejects(records('buyer','乙'),/view_session_required/);
  assert.equal((await view('buyer','乙',id2)).access.remaining_views,0);
  assert.equal((await view('buyer','丙',id3)).error,'view_quota_exhausted');
  assert.equal((await view('buyer','乙',id2)).transactions.length,1);
  assert.equal((await redeem('buyer',limitedCode)).access.remaining_views,0);
  await db.exec("update housing_private.view_receipts set created_at=now()-interval '11 minutes'");
  assert.equal((await view('buyer','甲',id)).error,'view_retry_expired');
});
test('admin and pre-existing free trials need no code or quota; disabled admin is denied immediately',async()=>{
  const id='44444444-4444-4444-8444-444444444444';
  const before=(await db.query('select count(*)::integer n from housing_private.view_receipts')).rows[0].n;
  assert.equal((await view('admin','丙',id)).transactions.length,1);
  assert.equal((await view('alice','甲',id)).transactions.length,2);
  assert.equal((await db.query('select count(*)::integer n from housing_private.view_receipts')).rows[0].n,before);
  await db.query('update housing_private.super_admins set enabled=false where user_id=$1',[users.admin]);
  await assert.rejects(issue('admin'),/admin_required/);
  assert.equal((await view('admin','丙',id)).error,'community_locked');
  await db.query('update housing_private.super_admins set enabled=true where user_id=$1',[users.admin]);
});
