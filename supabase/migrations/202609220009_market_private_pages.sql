-- Return only bounded private fact pages to the trusted Edge Function.  Public
-- history remains on GitHub Pages and is never copied into Supabase.
create function public.housing_market_private_rows(p_uid uuid,p_lease uuid,p_after bigint,p_page_size integer,p_params jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; next_id bigint;
begin
  perform housing_private.market_user(p_uid);
  if p_lease is null or p_after<0 or p_page_size<1 or p_page_size>5000 then raise exception 'invalid_request'; end if;
  if not housing_private.market_entitled(p_uid) then return jsonb_build_object('error','view_quota_exhausted'); end if;
  if not exists(select 1 from housing_private.market_jobs where user_id=p_uid and lease_id=p_lease and lease_until>now())
    then return jsonb_build_object('error','compute_lease_expired'); end if;
  with page as (
    select t.id,jsonb_build_array(to_char(t.sale_date,'YYYY-MM'),c.district,c.business_area,c.community,
      t.area,t.unit_price,t.cycle_days,t.discount_rate,t.rooms) value
    from housing_private.transactions t join housing_private.communities c on c.id=t.community_id
    where t.id>p_after
      and t.sale_date>=to_date((p_params->>'history_start')||'-01','YYYY-MM-DD')
      and t.sale_date<(to_date((p_params->>'history_end')||'-01','YYYY-MM-DD')+interval '1 month')
      and t.area between (p_params->>'area_min')::float8 and (p_params->>'area_max')::float8
      and (p_params->>'rooms'='全部' or t.rooms=p_params->>'rooms')
    order by t.id limit p_page_size
  ) select coalesce(jsonb_agg(value order by id),'[]'::jsonb),max(id) into result,next_id from page;
  -- A progressing reader keeps its short compute lease alive.  The final store
  -- still validates the same opaque lease before publishing a cache entry.
  update housing_private.market_jobs set lease_until=now()+interval '120 seconds' where user_id=p_uid and lease_id=p_lease;
  update housing_private.market_cache set lease_until=now()+interval '120 seconds' where lease_id=p_lease;
  return jsonb_build_object('rows',result,'next_id',next_id);
end; $$;
revoke all on function public.housing_market_private_rows(uuid,uuid,bigint,integer,jsonb) from public,anon,authenticated;
grant execute on function public.housing_market_private_rows(uuid,uuid,bigint,integer,jsonb) to service_role;
