-- Shared trusted calculations, never public history or account-specific payloads.
create table housing_private.market_settings (
  id boolean primary key default true check(id), ttl_seconds integer not null default 604800 check(ttl_seconds between 60 and 604800),
  budget_bytes bigint not null default 36700160 check(budget_bytes between 1048576 and 52428800)
);
insert into housing_private.market_settings(id) values(true);
create table housing_private.market_dataset (
  id boolean primary key default true check(id), revision bigint not null default 1
);
insert into housing_private.market_dataset(id) values(true);
create function housing_private.market_bump_version() returns trigger language plpgsql security definer set search_path='' as $$
begin update housing_private.market_dataset set revision=revision+1; return null; end; $$;
create trigger market_facts_version after insert or update or delete or truncate on housing_private.transactions
  for each statement execute function housing_private.market_bump_version();
create trigger market_catalog_version after insert or update or delete or truncate on housing_private.communities
  for each statement execute function housing_private.market_bump_version();
create table housing_private.market_cache (
  cache_key text primary key check(cache_key ~ '^[0-9a-f]{64}$'), params jsonb not null,
  public_version text not null, private_version bigint not null, algorithm_version text not null,
  payload jsonb, payload_bytes bigint not null default 0, created_at timestamptz not null default now(),
  expires_at timestamptz not null default now(), last_access_at timestamptz not null default now(),
  lease_id uuid, lease_until timestamptz, hits bigint not null default 0
);
create table housing_private.market_receipts (
  user_id uuid not null references auth.users(id) on delete cascade, request_id uuid not null,
  cache_key text not null, token_id uuid references housing_private.paid_tokens(id),
  created_at timestamptz not null default now(), primary key(user_id,request_id)
);
create index market_receipts_cache on housing_private.market_receipts(cache_key,created_at);
create table housing_private.market_jobs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  lease_id uuid not null, lease_until timestamptz not null
);
create table housing_private.market_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null, attempts integer not null
);
alter table housing_private.market_settings enable row level security;
alter table housing_private.market_dataset enable row level security;
alter table housing_private.market_cache enable row level security;
alter table housing_private.market_receipts enable row level security;
alter table housing_private.market_jobs enable row level security;
alter table housing_private.market_limits enable row level security;
revoke all on all tables in schema housing_private from public,anon,authenticated;

create function housing_private.market_user(p_uid uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
  perform set_config('request.jwt.claim.sub',coalesce(p_uid::text,''),true);
  perform housing_private.verified_uid();
end; $$;
create function housing_private.market_entitled(p_uid uuid) returns boolean
language sql volatile security definer set search_path='' as $$
  select housing_private.is_super_admin(p_uid) or exists(select 1 from housing_private.paid_tokens
    where redeemed_by=p_uid and revoked_at is null and expires_at>now() and (max_views is null or used_views<max_views));
$$;
create function public.housing_market_meta(p_uid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform housing_private.market_user(p_uid);
  return jsonb_build_object('revision',(select revision from housing_private.market_dataset),
    'latest_date',(select max(sale_date) from housing_private.transactions));
end; $$;

-- Serialize short lease acquisition. Expensive computation runs outside this transaction.
create function public.housing_market_begin(p_uid uuid,p_request_id uuid,p_key text,p_params jsonb,
  p_public_version text,p_private_version bigint,p_algorithm_version text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c housing_private.market_cache; r housing_private.market_receipts; lease uuid; n integer;
begin
  perform housing_private.market_user(p_uid);
  if p_request_id is null or p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'invalid_request'; end if;
  if not housing_private.check_read_limit(p_uid) then return jsonb_build_object('error','rate_limited'); end if;
  select * into r from housing_private.market_receipts where user_id=p_uid and request_id=p_request_id;
  if found then
    if r.cache_key<>p_key then return jsonb_build_object('error','view_scope_mismatch'); end if;
    if r.created_at<=now()-interval '10 minutes' then return jsonb_build_object('error','view_retry_expired'); end if;
    if r.token_id is null then
      if not housing_private.is_super_admin(p_uid) then return jsonb_build_object('error','market_locked'); end if;
    elsif not exists(select 1 from housing_private.paid_tokens where id=r.token_id and redeemed_by=p_uid and revoked_at is null and expires_at>now())
      then return jsonb_build_object('error','market_locked'); end if;
  elsif not housing_private.market_entitled(p_uid) then return jsonb_build_object('error','view_quota_exhausted'); end if;
  perform pg_advisory_xact_lock(hashtextextended('housing-market-cache',0));
  select * into c from housing_private.market_cache where cache_key=p_key;
  if c.payload is not null and (c.expires_at>now() or r.request_id is not null) then
    return jsonb_build_object('ready',true);
  end if;
  if p_private_version<>(select revision from housing_private.market_dataset) then return jsonb_build_object('error','dataset_changed'); end if;
  if c.lease_until>now() then return jsonb_build_object('pending',true); end if;
  if exists(select 1 from housing_private.market_jobs where user_id=p_uid and lease_until>now())
    or (select count(*) from housing_private.market_jobs where lease_until>now())>=3
    then return jsonb_build_object('error','compute_busy'); end if;
  insert into housing_private.market_limits as l values(p_uid,now(),1) on conflict(user_id) do update set
    attempts=case when l.window_start<now()-interval '1 minute' then 1 else l.attempts+1 end,
    window_start=case when l.window_start<now()-interval '1 minute' then now() else l.window_start end returning attempts into n;
  if n>6 then return jsonb_build_object('error','rate_limited'); end if;
  lease:=gen_random_uuid();
  insert into housing_private.market_cache(cache_key,params,public_version,private_version,algorithm_version,lease_id,lease_until)
    values(p_key,p_params,p_public_version,p_private_version,p_algorithm_version,lease,now()+interval '120 seconds')
    on conflict(cache_key) do update set lease_id=lease,lease_until=now()+interval '120 seconds';
  insert into housing_private.market_jobs values(p_uid,lease,now()+interval '120 seconds')
    on conflict(user_id) do update set lease_id=lease,lease_until=now()+interval '120 seconds';
  return jsonb_build_object('lease',lease);
end; $$;

create function public.housing_market_store(p_key text,p_lease uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c housing_private.market_cache; size bigint; budget bigint; victim text;
begin
  perform pg_advisory_xact_lock(hashtextextended('housing-market-cache',0));
  select * into c from housing_private.market_cache where cache_key=p_key for update;
  if not found or p_lease is null or c.lease_id is distinct from p_lease or c.lease_until is null or c.lease_until<=now() then return jsonb_build_object('error','compute_lease_expired'); end if;
  if c.private_version<>(select revision from housing_private.market_dataset) then return jsonb_build_object('error','dataset_changed'); end if;
  if p_payload is null or not (p_payload ?& array['config','benchmark','districts','communities','map','trends']) then raise exception 'invalid_report'; end if;
  size:=octet_length(p_payload::text);
  select budget_bytes into budget from housing_private.market_settings;
  if size>budget then return jsonb_build_object('error','report_too_large'); end if;
  -- Keep a receipt's result available for network retries, including explicit admin cleanup.
  delete from housing_private.market_receipts where created_at<=now()-interval '1 day';
  delete from housing_private.market_cache x where x.cache_key<>p_key and x.expires_at<=now()
    and coalesce(x.lease_until,now())<=now() and not exists(select 1 from housing_private.market_receipts r where r.cache_key=x.cache_key and r.created_at>now()-interval '10 minutes');
  while (select coalesce(sum(payload_bytes),0) from housing_private.market_cache where cache_key<>p_key)+size>budget loop
    select x.cache_key into victim from housing_private.market_cache x where x.cache_key<>p_key and coalesce(x.lease_until,now())<=now()
      and not exists(select 1 from housing_private.market_receipts r where r.cache_key=x.cache_key and r.created_at>now()-interval '10 minutes') order by last_access_at limit 1;
    if victim is null then return jsonb_build_object('error','cache_capacity_busy'); end if;
    delete from housing_private.market_cache where cache_key=victim;
  end loop;
  update housing_private.market_cache set payload=p_payload,payload_bytes=size,created_at=now(),last_access_at=now(),
    expires_at=now()+make_interval(secs=>(select ttl_seconds from housing_private.market_settings)),lease_id=null,lease_until=null where cache_key=p_key;
  delete from housing_private.market_jobs where lease_id=p_lease;
  return jsonb_build_object('ok',true);
end; $$;
create function public.housing_market_release(p_lease uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  update housing_private.market_cache set lease_id=null,lease_until=null where lease_id=p_lease;
  delete from housing_private.market_jobs where lease_id=p_lease;
end; $$;

-- This is the only market delivery path. Cache hits go through the same atomic charge.
create function public.housing_market_deliver(p_uid uuid,p_request_id uuid,p_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c housing_private.market_cache; r housing_private.market_receipts; t housing_private.paid_tokens; charged boolean:=false;
begin
  perform housing_private.market_user(p_uid);
  if p_request_id is null then raise exception 'invalid_request'; end if;
  insert into housing_private.accounts values(p_uid) on conflict do nothing;
  perform 1 from housing_private.accounts where user_id=p_uid for update;
  select * into r from housing_private.market_receipts where user_id=p_uid and request_id=p_request_id;
  if found then
    if r.cache_key<>p_key then return jsonb_build_object('error','view_scope_mismatch'); end if;
    if r.created_at<=now()-interval '10 minutes' then return jsonb_build_object('error','view_retry_expired'); end if;
    if r.token_id is null then
      if not housing_private.is_super_admin(p_uid) then return jsonb_build_object('error','market_locked'); end if;
    elsif not exists(select 1 from housing_private.paid_tokens where id=r.token_id and redeemed_by=p_uid and revoked_at is null and expires_at>now())
      then return jsonb_build_object('error','market_locked'); end if;
  elsif not housing_private.is_super_admin(p_uid) then
    select * into t from housing_private.paid_tokens where redeemed_by=p_uid and revoked_at is null and expires_at>now()
      and (max_views is null or used_views<max_views) order by (max_views is null) desc,expires_at,id limit 1 for update;
    if not found then return jsonb_build_object('error','view_quota_exhausted'); end if;
  end if;
  select * into c from housing_private.market_cache where cache_key=p_key for update;
  if c.payload is null or (r.request_id is null and (c.expires_at<=now() or c.private_version<>(select revision from housing_private.market_dataset)))
    then return jsonb_build_object('error','cache_miss'); end if;
  if r.request_id is null then
    insert into housing_private.market_receipts(user_id,request_id,cache_key,token_id) values(p_uid,p_request_id,p_key,t.id);
    if t.id is not null then update housing_private.paid_tokens set used_views=used_views+1 where id=t.id; charged:=t.max_views is not null; end if;
  end if;
  -- Access writes are bounded to one per minute, not one per chart or hover.
  update housing_private.market_cache set last_access_at=now(),hits=hits+1 where cache_key=p_key and last_access_at<now()-interval '1 minute';
  return jsonb_build_object('report',c.payload,'charged',charged,'access',public.housing_access(),'data_version',c.private_version);
end; $$;

create function public.housing_admin_cache(p_action text default 'list',p_key text default null,p_ttl integer default null,p_budget bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=housing_private.require_admin(); deleted integer:=0;
begin
  if not housing_private.check_read_limit(uid) then return jsonb_build_object('error','rate_limited'); end if;
  perform pg_advisory_xact_lock(hashtextextended('housing-market-cache',0));
  if p_action='settings' then
    update housing_private.market_settings set ttl_seconds=coalesce(p_ttl,ttl_seconds),budget_bytes=coalesce(p_budget,budget_bytes);
  elsif p_action in ('delete','expired') then
    -- Mark invalid for new requests immediately; preserve only current retry receipts.
    update housing_private.market_cache set expires_at=least(expires_at,now()) where p_action='expired' and expires_at<=now() or p_action='delete' and cache_key=p_key;
    delete from housing_private.market_cache c where (p_action='expired' and expires_at<=now() or p_action='delete' and cache_key=p_key)
      and coalesce(lease_until,now())<=now() and not exists(select 1 from housing_private.market_receipts r where r.cache_key=c.cache_key and r.created_at>now()-interval '10 minutes');
    get diagnostics deleted=row_count;
  elsif p_action<>'list' then raise exception 'invalid_cache_action'; end if;
  return jsonb_build_object('deleted',deleted,'settings',(select to_jsonb(s) from housing_private.market_settings s),
    'payload_bytes',(select coalesce(sum(payload_bytes),0) from housing_private.market_cache),
    'physical_bytes',pg_total_relation_size('housing_private.market_cache'),
    'database_bytes',pg_database_size(current_database()),'revision',(select revision from housing_private.market_dataset),
    'entries',coalesce((select jsonb_agg(to_jsonb(x)) from (select cache_key,params,public_version,private_version,algorithm_version,payload_bytes,created_at,expires_at,last_access_at,hits,lease_until from housing_private.market_cache order by last_access_at desc limit 100) x),'[]'::jsonb));
end; $$;
revoke all on function housing_private.market_bump_version(),housing_private.market_user(uuid),housing_private.market_entitled(uuid) from public,anon,authenticated;
revoke all on function public.housing_market_meta(uuid),public.housing_market_begin(uuid,uuid,text,jsonb,text,bigint,text),public.housing_market_store(text,uuid,jsonb),public.housing_market_release(uuid),public.housing_market_deliver(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.housing_market_meta(uuid),public.housing_market_begin(uuid,uuid,text,jsonb,text,bigint,text),public.housing_market_store(text,uuid,jsonb),public.housing_market_release(uuid),public.housing_market_deliver(uuid,uuid,text) to service_role;
revoke all on function public.housing_admin_cache(text,text,integer,bigint) from public,anon;
grant execute on function public.housing_admin_cache(text,text,integer,bigint) to authenticated;

-- Validate the exact delivered grant, not just any other code on the account.
-- Exhausted balances do not invalidate a response already paid for.
create function public.housing_validate_views(p_market uuid default null,p_community uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=housing_private.verified_uid();
begin
  if not housing_private.check_read_limit(uid) then return jsonb_build_object('error','rate_limited'); end if;
  return jsonb_build_object(
    'market_valid',exists(select 1 from housing_private.market_receipts r where r.user_id=uid and r.request_id=p_market
      and ((r.token_id is null and housing_private.is_super_admin(uid)) or exists(select 1 from housing_private.paid_tokens t
        where t.id=r.token_id and t.redeemed_by=uid and t.revoked_at is null and t.expires_at>now()))),
    'community_valid',exists(select 1 from housing_private.view_receipts r join housing_private.paid_tokens t on t.id=r.token_id
      where r.user_id=uid and r.request_id=p_community and t.redeemed_by=uid and t.revoked_at is null and t.expires_at>now()));
end; $$;
revoke all on function public.housing_validate_views(uuid,uuid) from public,anon;
grant execute on function public.housing_validate_views(uuid,uuid) to authenticated;
