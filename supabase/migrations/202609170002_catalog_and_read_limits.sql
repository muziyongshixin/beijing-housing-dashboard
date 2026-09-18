create table housing_private.read_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  attempts integer not null
);
alter table housing_private.read_limits enable row level security;
revoke all on housing_private.read_limits from public, anon, authenticated;

create function housing_private.check_read_limit(p_uid uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  insert into housing_private.read_limits as r values(p_uid,now(),1)
  on conflict(user_id) do update set
    attempts=case when r.window_start < now()-interval '1 minute' then 1 else r.attempts+1 end,
    window_start=case when r.window_start < now()-interval '1 minute' then now() else r.window_start end
  returning attempts into n;
  return n<=120;
end;
$$;
revoke all on function housing_private.check_read_limit(uuid) from public,anon,authenticated;

-- Catalog reveals names only, not prices, counts, volumes or latest sale dates.
create function public.housing_search_catalog(p_query text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if p_query is null or length(trim(p_query)) not between 2 and 80 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(to_jsonb(c)) from (
    select district,business_area,community from housing_private.communities
    where position(trim(p_query) in community)>0 order by community,district,business_area limit 20
  ) c),'[]'::jsonb);
end;
$$;
revoke all on function public.housing_search_catalog(text) from public;
grant execute on function public.housing_search_catalog(text) to anon,authenticated;

-- A wrapper persists throttling failures instead of rolling back the counter.
alter function public.housing_new_transactions(text,text,text,date,bigint,integer)
  rename to housing_new_transactions_internal;
alter function public.housing_new_transactions_internal(text,text,text,date,bigint,integer)
  set schema housing_private;
revoke all on function housing_private.housing_new_transactions_internal(text,text,text,date,bigint,integer) from public,anon,authenticated;
create function public.housing_new_transactions(
  p_district text,p_business_area text,p_community text,
  p_after_date date default null,p_after_id bigint default null,p_page_size integer default 200
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid := housing_private.verified_uid();
begin
  if not housing_private.check_read_limit(v_uid) then
    return jsonb_build_object('error','rate_limited','transactions','[]'::jsonb);
  end if;
  return housing_private.housing_new_transactions_internal(p_district,p_business_area,p_community,p_after_date,p_after_id,p_page_size);
end;
$$;
revoke all on function public.housing_new_transactions(text,text,text,date,bigint,integer) from public,anon;
grant execute on function public.housing_new_transactions(text,text,text,date,bigint,integer) to authenticated;
