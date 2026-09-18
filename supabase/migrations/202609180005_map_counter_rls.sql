-- Defense in depth: only the SECURITY DEFINER quota function can touch counters.
alter table housing_private.map_proxy_limits enable row level security;
