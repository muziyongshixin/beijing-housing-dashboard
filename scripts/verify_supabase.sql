-- Live RPC smoke test. All synthetic accounts, claims and tokens are rolled back.
-- Never substitute a real user id/email. Does not validate email delivery/concurrency.
begin;
set local statement_timeout = '30s';
insert into auth.users(id,email,email_confirmed_at,is_anonymous)
values ('de1de1de-0000-4000-8000-000000000001','housing-qa-one@example.invalid',now(),false),
       ('de1de1de-0000-4000-8000-000000000002','housing-qa-two@example.invalid',now(),false);
create temporary table housing_qa_communities as
select row_number() over(order by c.id) as n,c.district,c.business_area,c.community
from housing_private.communities c
where exists(select 1 from housing_private.transactions t where t.community_id=c.id)
order by c.id limit 3;
grant select on housing_qa_communities to authenticated;
insert into housing_private.paid_tokens(order_ref,token_hash,duration_days,redeem_before,intended_user_id)
values ('ROLLBACK-ONLY-HOUSING-QA',encode(sha256(convert_to(repeat('rollback-test-only-',4),'UTF8')),'hex'),1,
now()+interval '1 day','de1de1de-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare c record; r jsonb; before_exp text; after_exp text;
begin
  perform set_config('request.jwt.claim.sub','de1de1de-0000-4000-8000-000000000001',true);
  assert public.housing_access()->>'tier'='registered';
  for c in select * from housing_qa_communities order by n loop
    r:=public.housing_claim_trial(c.district,c.business_area,c.community);
    if c.n<=2 then
      assert (r->>'ok')::boolean;
      assert (public.housing_claim_trial(c.district,c.business_area,c.community)->>'ok')::boolean;
      r:=public.housing_new_transactions(c.district,c.business_area,c.community,null,null,1);
      assert jsonb_array_length(r->'transactions')=1;
      assert r->'transactions'->0->>'sale_date'>='2025-09-01';
    else
      assert r->>'code'='trial_exhausted';
      begin
        perform public.housing_new_transactions(c.district,c.business_area,c.community);
        raise exception 'third community unexpectedly readable';
      exception when insufficient_privilege then null;
      end;
    end if;
  end loop;
  assert jsonb_array_length(public.housing_access()->'trial_communities')=2;
  r:=public.housing_redeem(repeat('rollback-test-only-',4));
  assert (r->>'ok')::boolean;
  before_exp:=r->'access'->>'expires_at';
  r:=public.housing_redeem(repeat('rollback-test-only-',4));
  after_exp:=r->'access'->>'expires_at';
  assert before_exp=after_exp;
  assert public.housing_access()->>'tier'='paid';
  perform set_config('request.jwt.claim.sub','de1de1de-0000-4000-8000-000000000002',true);
  assert public.housing_redeem(repeat('rollback-test-only-',4))->>'code'='invalid_token';
  begin
    perform 1 from housing_private.transactions limit 1;
    raise exception 'private table unexpectedly readable';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
update housing_private.paid_tokens set revoked_at=now() where order_ref='ROLLBACK-ONLY-HOUSING-QA';
set local role authenticated;
do $$
declare c record;
begin
  perform set_config('request.jwt.claim.sub','de1de1de-0000-4000-8000-000000000001',true);
  assert public.housing_access()->>'tier'='registered';
  select * into c from housing_qa_communities where n=3;
  begin
    perform public.housing_new_transactions(c.district,c.business_area,c.community);
    raise exception 'revoked entitlement unexpectedly readable';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
select 'cloud RPC assertions passed; all test writes rolled back' as result;
