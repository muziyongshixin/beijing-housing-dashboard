// Local-only fixture: exact reports remain under ignored .private/.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {computeMarket} from '../supabase/functions/market-report/compute.mjs';
import {normalizeParams,historicalMonths} from '../supabase/functions/market-report/contract.mjs';
const manifest=JSON.parse(readFileSync('docs/data/history/manifest.json')),catalog=JSON.parse(gunzipSync(readFileSync('docs/'+manifest.catalog.path)));
const privateRows=JSON.parse(execFileSync('sqlite3',['-readonly','-json','data/transactions.sqlite3',"select sale_month,district,business_area,community,area,unit_price,cycle_days,discount_rate,rooms from transactions where sale_date>='2025-09-01'"],{encoding:'utf8',maxBuffer:64e6})).map(Object.values);
mkdirSync('.private/market-preview',{recursive:true});
for(const [name,input] of [['default',{}],['long',{window:24,compare:'yoy'}]]){
 const params=normalizeParams(input),rows=historicalMonths(params,manifest).flatMap(month=>JSON.parse(gunzipSync(readFileSync('docs/'+manifest.months[month].path))));
 const report=computeMarket(params,{communities:catalog,rows},privateRows);report.data_through='2026-08-29';
 writeFileSync('.private/market-preview/'+name+'.json',JSON.stringify(report),{mode:0o600});
}
console.log('Exact loopback reports prepared in ignored private directory');
