-- Administrators are provisioned separately by account UUID, never by client metadata.
create table housing_private.super_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table housing_private.super_admins enable row level security;
revoke all on housing_private.super_admins from public,anon,authenticated;
alter table housing_private.paid_tokens
  add column max_views integer check(max_views between 1 and 1000000),
  add column used_views integer not null default 0 check(used_views>=0),
  add column issued_by uuid references auth.users(id),
  add column created_at timestamptz not null default now(),
  add column redeem_days integer;
create table housing_private.view_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  community_id bigint not null references housing_private.communities(id),
  token_id uuid not null references housing_private.paid_tokens(id),
  created_at timestamptz not null default now(),
  primary key(user_id,request_id)
);
alter table housing_private.view_receipts enable row level security;
revoke all on housing_private.view_receipts from public,anon,authenticated;

create function housing_private.is_super_admin(p_uid uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from housing_private.super_admins a join auth.users u on u.id=a.user_id
    where a.user_id=p_uid and a.enabled and u.email_confirmed_at is not null
    and coalesce(u.email,'')<>'' and not coalesce(u.is_anonymous,false));
$$;
create function housing_private.require_admin() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=housing_private.verified_uid();
begin
  if not housing_private.is_super_admin(v_uid) then raise exception 'admin_required' using errcode='42501'; end if;
  return v_uid;
end;
$$;
create function public.housing_admin_access() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=housing_private.verified_uid();
begin return jsonb_build_object('is_admin',housing_private.is_super_admin(v_uid)); end;
$$;
create or replace function public.housing_access() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=housing_private.verified_uid(); v_exp timestamptz; v_admin boolean;
  v_unlimited boolean; v_remaining bigint;
begin
  v_admin:=housing_private.is_super_admin(v_uid); v_exp:=housing_private.paid_until(v_uid);
  select coalesce(bool_or(max_views is null),false),coalesce(sum(greatest(0,max_views-used_views)),0)
    into v_unlimited,v_remaining from housing_private.paid_tokens
    where redeemed_by=v_uid and revoked_at is null and expires_at>now();
  return jsonb_build_object('user_id',v_uid,'is_admin',v_admin,
    'tier',case when v_admin then 'admin' when v_exp is not null then 'paid' else 'registered' end,
    'free_through','2025-08-31','paid_from','2025-09-01','expires_at',v_exp,
    'unlimited_views',v_admin or v_unlimited,'remaining_views',case when v_admin or v_unlimited then null else v_remaining end,
    'trial_limit',2,'trial_communities',coalesce((select jsonb_agg(jsonb_build_object(
      'district',c.district,'business_area',c.business_area,'community',c.community) order by t.created_at,c.id)
      from housing_private.trial_unlocks t join housing_private.communities c on c.id=t.community_id
      where t.user_id=v_uid),'[]'::jsonb));
end;
$$;

-- Client creates a cryptographically random code in memory. Only its hash is stored.
-- Exact order+code retry is idempotent even if the first network response was lost.
create function public.housing_admin_issue(
  p_email text,p_token text,p_order_ref text,p_duration_days integer,
  p_redeem_days integer,p_max_views integer default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_admin uuid:=housing_private.require_admin(); v_uid uuid; v_hash text; t housing_private.paid_tokens;
begin
  if not housing_private.check_read_limit(v_admin) then return jsonb_build_object('error','rate_limited'); end if;
  if p_email is null or length(trim(p_email)) not between 3 and 254
    or p_token is null or p_token !~ '^bj_[A-Za-z0-9_-]{43}$'
    or p_order_ref is null or length(trim(p_order_ref)) not between 8 and 120
    or p_duration_days is null or p_duration_days not between 1 and 3660
    or p_redeem_days is null or p_redeem_days not between 1 and 365
    or (p_max_views is not null and p_max_views not between 1 and 1000000)
  then return jsonb_build_object('error','invalid_issue_parameters'); end if;
  select id into v_uid from auth.users where lower(email)=lower(trim(p_email))
    and email_confirmed_at is not null and not coalesce(is_anonymous,false);
  if v_uid is null then return jsonb_build_object('error','recipient_not_verified'); end if;
  v_hash:=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  -- All issuance calls for this order serialize, including concurrent retries.
  perform pg_advisory_xact_lock(hashtextextended(trim(p_order_ref),0));
  select * into t from housing_private.paid_tokens where order_ref=trim(p_order_ref) for update;
  if found then
    if t.token_hash<>v_hash or t.intended_user_id is distinct from v_uid or t.duration_days<>p_duration_days
      or t.max_views is distinct from p_max_views or t.redeem_days is distinct from p_redeem_days
      or t.issued_by is distinct from v_admin or t.revoked_at is not null
    then return jsonb_build_object('error','order_conflict'); end if;
  else
    insert into housing_private.paid_tokens(order_ref,token_hash,duration_days,redeem_before,intended_user_id,max_views,issued_by,redeem_days)
      values(trim(p_order_ref),v_hash,p_duration_days,now()+make_interval(days=>p_redeem_days),v_uid,p_max_views,v_admin,p_redeem_days)
      returning * into t;
  end if;
  return jsonb_build_object('ok',true,'order_ref',t.order_ref,'email',lower(trim(p_email)),
    'duration_days',t.duration_days,'max_views',t.max_views,'redeem_before',t.redeem_before);
end;
$$;

-- One full community response = one charged view. Server stores a ten-minute
-- retry receipt, bound to both user and community. No per-page charging/bypass.
create function public.housing_view_community(
  p_district text,p_business_area text,p_community text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=housing_private.verified_uid(); v_cid bigint; v_token housing_private.paid_tokens;
  receipt housing_private.view_receipts; v_rows jsonb; v_free boolean; v_charged boolean:=false;
begin
  if not housing_private.check_read_limit(v_uid) then return jsonb_build_object('error','rate_limited'); end if;
  if p_request_id is null then return jsonb_build_object('error','invalid_request_id'); end if;
  select id into v_cid from housing_private.communities
    where district=p_district and business_area=p_business_area and community=p_community;
  if v_cid is null or not exists(select 1 from housing_private.transactions where community_id=v_cid)
    then return jsonb_build_object('error','no_new_data'); end if;
  insert into housing_private.accounts values(v_uid) on conflict do nothing;
  perform 1 from housing_private.accounts where user_id=v_uid for update;
  v_free:=housing_private.is_super_admin(v_uid) or exists(select 1 from housing_private.trial_unlocks where user_id=v_uid and community_id=v_cid);
  if not v_free then
    select * into receipt from housing_private.view_receipts where user_id=v_uid and request_id=p_request_id;
    if found then
      if receipt.community_id<>v_cid then return jsonb_build_object('error','view_scope_mismatch'); end if;
      if receipt.created_at<=now()-interval '10 minutes' then return jsonb_build_object('error','view_retry_expired'); end if;
      select * into v_token from housing_private.paid_tokens where id=receipt.token_id and redeemed_by=v_uid and revoked_at is null and expires_at>now() for update;
      if not found then return jsonb_build_object('error','community_locked'); end if;
    else
      select * into v_token from housing_private.paid_tokens where redeemed_by=v_uid and revoked_at is null and expires_at>now()
        and (max_views is null or used_views<max_views)
        order by (max_views is null) desc,expires_at,id limit 1 for update;
      if not found then return jsonb_build_object('error',case when housing_private.paid_until(v_uid) is null then 'community_locked' else 'view_quota_exhausted' end); end if;
      insert into housing_private.view_receipts(user_id,request_id,community_id,token_id) values(v_uid,p_request_id,v_cid,v_token.id);
      update housing_private.paid_tokens set used_views=used_views+1 where id=v_token.id;
      v_charged:=v_token.max_views is not null;
    end if;
  end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.sale_date,t.id),'[]'::jsonb) into v_rows from (
    select id,sale_date,area,unit_price,sale_price,listing_price,
      case when listing_price>0 then listing_price*10000/area end as listing_unit_price,
      layout,rooms,orientation,floor,cycle_days,discount_rate
    from housing_private.transactions where community_id=v_cid
  ) t;
  return jsonb_build_object('transactions',v_rows,'charged',v_charged,'access',public.housing_access());
end;
$$;

-- Close the pre-quota paginated API escape hatch for limited tokens.
create or replace function public.housing_new_transactions(
  p_district text,p_business_area text,p_community text,
  p_after_date date default null,p_after_id bigint default null,p_page_size integer default 200
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=housing_private.verified_uid(); v_cid bigint;
begin
  if not housing_private.check_read_limit(v_uid) then return jsonb_build_object('error','rate_limited','transactions','[]'::jsonb); end if;
  select id into v_cid from housing_private.communities where district=p_district and business_area=p_business_area and community=p_community;
  if not exists(select 1 from housing_private.trial_unlocks where user_id=v_uid and community_id=v_cid)
    and not exists(select 1 from housing_private.paid_tokens where redeemed_by=v_uid and revoked_at is null and expires_at>now() and max_views is null)
  then
    if housing_private.paid_until(v_uid) is null then raise exception 'community_locked' using errcode='42501'; end if;
    raise exception 'view_session_required' using errcode='42501';
  end if;
  return housing_private.housing_new_transactions_internal(p_district,p_business_area,p_community,p_after_date,p_after_id,p_page_size);
end;
$$;
revoke all on function housing_private.is_super_admin(uuid),housing_private.require_admin() from public,anon,authenticated;
revoke all on function public.housing_admin_access(),public.housing_admin_issue(text,text,text,integer,integer,integer),public.housing_view_community(text,text,text,uuid) from public,anon;
grant execute on function public.housing_admin_access(),public.housing_admin_issue(text,text,text,integer,integer,integer),public.housing_view_community(text,text,text,uuid) to authenticated;
