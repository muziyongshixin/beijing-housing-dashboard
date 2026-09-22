export const ALGORITHM='market-edge-v2';
export function shiftMonth(month,delta){const [y,m]=month.split('-').map(Number),n=y*12+m-1+delta;return `${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;}
export function normalizeParams(input={},latest='2026-08'){
  if(!input||Array.isArray(input)||typeof input!=='object')throw Error('invalid_parameters');
  const keys=new Set(['end_month','window','compare','base_start','base_end','metric','district','business_area','rooms','area_min','area_max','min_current','min_base','min_total','min_active_months','level','sort','direction','limit']);
  if(Object.keys(input).some(k=>!keys.has(k)))throw Error('invalid_parameters');
  const str=(key,fallback)=>String(input[key]??fallback).trim();
  const choice=(key,fallback,values)=>{const v=str(key,fallback);if(!values.includes(v))throw Error('invalid_parameters');return v;};
  const num=(key,fallback,min,max,integer=false)=>{const v=Number(input[key]??fallback);if(!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isInteger(v)))throw Error('invalid_parameters');return v;};
  const month=(key,fallback)=>{const v=str(key,fallback);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)||v<'2018-01'||v>latest)throw Error('invalid_date');return v;};
  const end=month('end_month',latest),w=num('window',6,1,24,true),current=shiftMonth(end,1-w);
  const compare=choice('compare','adjacent',['adjacent','yoy','custom']);
  let bs,be;
  if(compare==='yoy'){bs=shiftMonth(current,-12);be=shiftMonth(end,-12);}
  else if(compare==='custom'){bs=month('base_start',shiftMonth(current,-w));be=month('base_end',shiftMonth(current,-1));if(bs>be)[bs,be]=[be,bs];}
  else{bs=shiftMonth(current,-w);be=shiftMonth(current,-1);}
  const location=key=>{const v=str(key,'全部');if(!v||v.length>100||/[\x00-\x1f]/.test(v))throw Error('invalid_parameters');return v;};
  const lo=num('area_min',10,10,500),hi=num('area_max',500,10,500);
  const trendStart=[shiftMonth(end,-47),'2018-04'].sort().at(-1);
  const historyStart=[bs,current,shiftMonth(trendStart,1-w)].sort()[0];
  const businessArea=location('business_area'),district=businessArea==='全部'?'全部':location('district');
  return {end_month:end,window:w,compare,current_start:current,current_end:end,base_start:bs,base_end:be,
    trend_start:trendStart,history_start:historyStart,history_end:[end,be].sort().at(-1),
    metric:choice('metric','median',['median','mean','p30','p60','min','max']),district,business_area:businessArea,
    rooms:location('rooms'),area_min:Math.min(lo,hi),area_max:Math.max(lo,hi),
    min_current:num('min_current',10,0,10000,true),min_base:num('min_base',10,0,10000,true),
    min_total:num('min_total',25,0,20000,true),min_active_months:num('min_active_months',3,0,24,true)};
}
export function historicalMonths(params,manifest){
  const trendStart=shiftMonth(params.trend_start,1-params.window);
  return Object.keys(manifest.months).filter(m=>(m>=params.base_start&&m<=params.base_end)||(m>=params.current_start&&m<=params.current_end)||(m>=trendStart&&m<=params.end_month));
}
export async function digest(text){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof text==='string'?new TextEncoder().encode(text):text)),n=>n.toString(16).padStart(2,'0')).join('');}
export async function cacheKey(params,publicVersion,privateVersion){return digest(JSON.stringify([ALGORITHM,publicVersion,privateVersion,params]));}
