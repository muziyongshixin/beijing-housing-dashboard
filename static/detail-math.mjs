// Recompute one authorized community without changing market-wide caches.
export function quantile(values, metric='median') {
  const a=values.filter(Number.isFinite).sort((a,b)=>a-b); if(!a.length)return null;
  if(metric==='mean')return a.reduce((x,y)=>x+y,0)/a.length;
  if(metric==='min')return a[0];if(metric==='max')return a.at(-1);
  const i=(a.length-1)*(metric==='p30'?.3:metric==='p60'?.6:.5),lo=Math.floor(i),hi=Math.ceil(i);
  return a[lo]+(a[hi]-a[lo])*(i-lo);
}
export function monthShift(month,n){const[y,m]=month.split('-').map(Number),v=y*12+m-1+n;return `${Math.floor(v/12)}-${String((v%12+12)%12+1).padStart(2,'0')}`;}
function months(a,b){const r=[];for(let m=a;m<=b;m=monthShift(m,1))r.push(m);return r;}
export function communityHistory(item,oldRows,newRows,inputConfig,latestMonth){
  const rows=[...oldRows.filter(r=>r.sale_date<='2025-08-31'),...newRows.filter(r=>r.sale_date>='2025-09-01')]
    .map(r=>({...r,listing_unit_price:r.listing_price>0&&r.area>0?r.listing_price*10000/r.area:null}))
    .sort((a,b)=>a.sale_date.localeCompare(b.sale_date)||(a.id||0)-(b.id||0));
  if(!rows.length)throw new Error('该小区在当前权限范围内暂无成交记录');
  const c={...inputConfig,end_month:latestMonth,current_end:latestMonth};c.current_start=monthShift(latestMonth,-c.window+1);
  if(c.compare==='yoy'){c.base_start=monthShift(c.current_start,-12);c.base_end=monthShift(latestMonth,-12);}
  else if(c.compare!=='custom'){c.base_end=monthShift(c.current_start,-1);c.base_start=monthShift(c.base_end,-c.window+1);}
  const between=(a,b)=>rows.filter(r=>r.sale_date.slice(0,7)>=a&&r.sale_date.slice(0,7)<=b);
  const value=(r,key='unit_price',metric=c.metric)=>quantile(r.map(x=>x[key]),metric);
  const current=between(c.current_start,c.current_end),base=between(c.base_start,c.base_end),cp=value(current),bp=value(base);
  const range=months(rows[0].sale_date.slice(0,7),rows.at(-1).sale_date.slice(0,7));
  return {...item,config:c,summary:{transaction_count:rows.length,first_date:rows[0].sale_date,last_date:rows.at(-1).sale_date,
    overall_median_price:value(rows,'unit_price','median'),overall_median_area:value(rows,'area','median'),average_monthly_volume:rows.length/new Set(rows.map(r=>r.sale_date.slice(0,7))).size,
    current_price:cp,base_price:bp,price_change:cp!=null&&bp?cp/bp-1:null,current_volume:current.length,base_volume:base.length,current_monthly_average:current.length/c.window,base_monthly_average:base.length/months(c.base_start,c.base_end).length},
    monthly:range.map(m=>{const s=between(m,m);return {month:m,volume:s.length,median_price:value(s,'unit_price','median'),mean_price:value(s,'unit_price','mean'),median_area:value(s,'area','median')};}),
    rolling:range.map(m=>{const s=between(monthShift(m,-c.window+1),m),l=s.filter(r=>Number.isFinite(r.listing_unit_price));return {month:m,price:value(s),listing_price:value(l,'listing_unit_price'),sample_count:s.length,listing_sample_count:l.length};}),transactions:rows.slice().reverse()};
}
