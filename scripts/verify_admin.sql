-- Synthetic roles and codes only. Entire acceptance test is rolled back.
begin;
set local statement_timeout='30s';
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
 ('de1de1de-0000-4000-8000-000000000011','housing-admin-qa@example.invalid',now(),false),
 ('de1de1de-0000-4000-8000-000000000012','housing-buyer-qa@example.invalid',now(),false);
insert into housing_private.super_admins(user_id) values('de1de1de-0000-4000-8000-000000000011');
create temporary table admin_qa_community as select c.district,c.business_area,c.community from housing_private.communities c
 where exists(select 1 from housing_private.transactions where community_id=c.id) order by c.id limit 1;
grant select on admin_qa_community to authenticated;
set local role authenticated;
do $$
declare c record;r jsonb;code text:='bj_'||repeat('Q',43);
begin
 select * into c from admin_qa_community;
 perform set_config('request.jwt.claim.sub','de1de1de-0000-4000-8000-000000000012',true);
 assert not (public.housing_admin_access()->>'is_admin')::boolean;
 begin
  perform public.housing_admin_issue('housing-buyer-qa@example.invalid',code,'ROLLBACK-ADMIN-QA',30,7,1);
  raise exception 'non-admin issued code';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub','de1de1de-0000-4000-8000-000000000011',true);
 assert (public.housing_admin_access()->>'is_admin')::boolean;
 assert public.housing_access()->>'tier'='admin';
 r:=public.housing_view_community(c.district,c.business_area,c.community,'55555555-5555-4555-8555-555555555555');
 assert jsonb_array_length(r->'transactions')>0 and not (r->>'charged')::boolean;
 r:=public.housing_admin_issue('housing-buyer-qa@example.invalid',code,'ROLLBACK-ADMIN-QA',30,7,1);
 assert (r->>'ok')::boolean and (r->>'max_views')::integer=1;
 assert r=public.housing_admin_issue('housing-buyer-qa@example.invalid',code,'ROLLBACK-ADMIN-QA',30,7,1);
 perform set_config('request.jwt.claim.sub','de1de1de-0000-4000-8000-000000000012',true);
 assert (public.housing_redeem(code)->>'ok')::boolean;
 r:=public.housing_view_community(c.district,c.business_area,c.community,'66666666-6666-4666-8666-666666666666');
 assert (r->>'charged')::boolean and (r->'access'->>'remaining_views')::integer=0;
 r:=public.housing_view_community(c.district,c.business_area,c.community,'66666666-6666-4666-8666-666666666666');
 assert not (r->>'charged')::boolean and jsonb_array_length(r->'transactions')>0;
 r:=public.housing_view_community(c.district,c.business_area,c.community,'77777777-7777-4777-8777-777777777777');
 assert r->>'error'='view_quota_exhausted';
 begin
  perform public.housing_new_transactions(c.district,c.business_area,c.community);
  raise exception 'legacy API bypassed quota';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
select 'admin_issue_redeem_quota_and_bypass_checks_passed' as result;
