-- Service-only quota guard for the public map proxy. No location, IP or query storage.
create table housing_private.map_proxy_limits (
  bucket text not null, period bigint not null, hits integer not null,
  primary key(bucket,period)
);
revoke all on housing_private.map_proxy_limits from public,anon,authenticated;
create function public.housing_map_allow(p_client text) returns boolean
language plpgsql security definer set search_path='' as $$
declare minute bigint:=floor(extract(epoch from now())/60); day bigint:=floor(extract(epoch from now())/86400); n integer;
begin
  if p_client is null or p_client !~ '^[a-f0-9]{64}$' then return false; end if;
  -- Serializes the tiny counters, avoiding multi-edge races. Limits are deliberate budget caps.
  perform pg_advisory_xact_lock(9182026);
  delete from housing_private.map_proxy_limits where (bucket='day' and period<day-1) or (bucket<>'day' and period<minute-2);
  insert into housing_private.map_proxy_limits values('day',day,1)
    on conflict(bucket,period) do update set hits=housing_private.map_proxy_limits.hits+1 returning hits into n;
  if n>10000 then return false; end if;
  insert into housing_private.map_proxy_limits values('minute',minute,1)
    on conflict(bucket,period) do update set hits=housing_private.map_proxy_limits.hits+1 returning hits into n;
  if n>300 then return false; end if;
  insert into housing_private.map_proxy_limits values(p_client,minute,1)
    on conflict(bucket,period) do update set hits=housing_private.map_proxy_limits.hits+1 returning hits into n;
  return n<=60;
end;
$$;
revoke all on function public.housing_map_allow(text) from public,anon,authenticated;
grant execute on function public.housing_map_allow(text) to service_role;
