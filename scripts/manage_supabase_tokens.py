#!/usr/bin/env python3
"""Operator-only code issuance; never exposes a service key to the website."""
import argparse
import hashlib
import json
import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parent))
from import_supabase import execute, quote, PROJECT, ROOT

def main():
    p=argparse.ArgumentParser(description='人工核实到账后，签发账号绑定的一次性兑换码。')
    p.add_argument('--confirm-project',required=True,choices=[PROJECT])
    sub=p.add_subparsers(dest='action',required=True)
    issue=sub.add_parser('issue');issue.add_argument('--order',required=True);issue.add_argument('--user-id',required=True)
    issue.add_argument('--days',type=int,required=True);issue.add_argument('--redeem-within-days',type=int,default=30)
    issue.add_argument('--payment-confirmed',action='store_true',required=True)
    revoke=sub.add_parser('revoke');revoke.add_argument('--order',required=True);revoke.add_argument('--reason',required=True)
    sub.add_parser('list')
    a=p.parse_args()
    if a.action=='list':
        print(json.dumps(execute('select id,order_ref,duration_days,redeem_before,redeemed_at,expires_at,revoked_at from housing_private.paid_tokens order by redeem_before desc limit 100;'),ensure_ascii=False,indent=2));return
    if a.action=='revoke':
        result=execute(f'update housing_private.paid_tokens set revoked_at=now(),revoke_reason={quote(a.reason)} where order_ref={quote(a.order)} returning id;')
        print('Revoked matching order:',len(result));return
    if not 1<=a.days<=3660 or not 1<=a.redeem_within_days<=365: p.error('invalid duration')
    import uuid
    uid=str(uuid.UUID(a.user_id))
    users=execute(f'select id from auth.users where id={quote(uid)}::uuid and email_confirmed_at is not null and not coalesce(is_anonymous,false);')
    if not users: p.error('user must have a verified email account')
    digest=hashlib.sha256(a.order.encode()).hexdigest()[:24]
    dest=ROOT/'.private'/f'supabase-order-{digest}.json'
    # Stage before sending: a retry reuses the same code even if the response was lost.
    if dest.exists(): record=json.loads(dest.read_text())
    else:
        record={'order':a.order,'user_id':uid,'days':a.days,'redeem_within_days':a.redeem_within_days,'token':'bj_'+secrets.token_urlsafe(32)}
        fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f: json.dump(record,f)
    if any(record[k]!=v for k,v in {'user_id':uid,'days':a.days,'redeem_within_days':a.redeem_within_days}.items()):p.error('order already staged with different parameters')
    hashed=hashlib.sha256(record['token'].encode()).hexdigest()
    execute(f"insert into housing_private.paid_tokens(order_ref,token_hash,duration_days,redeem_before,intended_user_id) values ({quote(a.order)},{quote(hashed)},{a.days},now()+make_interval(days=>{a.redeem_within_days}),{quote(uid)}::uuid) on conflict(order_ref) do nothing;")
    verified=execute(f'select token_hash,intended_user_id::text,duration_days from housing_private.paid_tokens where order_ref={quote(a.order)};')
    if not verified or verified[0]['token_hash']!=hashed or verified[0]['intended_user_id']!=uid or verified[0]['duration_days']!=a.days:p.error('remote order differs; do not deliver staged code')
    print(f'已核实唯一订单，兑换码仅保存在本机私有文件：{dest}\n不要提交 Git 或公开发群；私聊交付给订单本人。')

if __name__=='__main__':main()
