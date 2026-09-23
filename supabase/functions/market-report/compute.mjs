import {shiftMonth} from './contract.mjs';

const SEP='\u0001';
const round=value=>Number.isFinite(value)?Math.round(value*1e6)/1e6:null;
const change=(current,base)=>current!=null&&base!=null&&base!==0?round(current/base-1):null;
const between=(value,start,end)=>value>=start&&value<=end;

// Select an exact order statistic in-place without sorting the entire window.
// Median-of-three partitioning is bounded; adversarial input falls back to the
// native numeric sort. No random approximation or per-month percentiles.
function select(values,k){
  let left=0,right=values.length-1,budget=2*Math.ceil(Math.log2(values.length+1));
  while(left<right){
    if(--budget<0){values.subarray(left,right+1).sort();return values[k];}
    const mid=(left+right)>>>1,a=values[left],b=values[mid],c=values[right];
    const pivot=a<b?(b<c?b:Math.max(a,c)):(a<c?a:Math.max(b,c));
    let low=left,cursor=left,high=right;
    while(cursor<=high){
      const value=values[cursor];
      if(value<pivot){values[cursor++]=values[low];values[low++]=value;}
      else if(value>pivot){values[cursor]=values[high];values[high--]=value;}
      else cursor++;
    }
    if(k<low)right=low-1;else if(k>high)left=high+1;else return pivot;
  }
  return values[k];
}
export function metric(values,name){
  const size=values.length;
  if(!size)return null;
  if(name==='mean'||name==='min'||name==='max'){
    let value=name==='min'?Infinity:name==='max'?-Infinity:0;
    for(const item of values)value=name==='min'?Math.min(value,item):name==='max'?Math.max(value,item):value+item;
    return round(name==='mean'?value/size:value);
  }
  const working=values instanceof Float64Array?values:Float64Array.from(values);
  const percentile=name==='p30'?.3:name==='p60'?.6:.5,index=(size-1)*percentile;
  const lower=Math.floor(index),upper=Math.ceil(index),lo=select(working,lower);
  if(lower===upper)return round(lo);
  let hi=Infinity;for(let i=upper;i<size;i++)if(working[i]<hi)hi=working[i];
  return round(lo+(hi-lo)*(index-lower));
}
function months(start,end){const result=[];for(let month=start;month<=end;month=shiftMonth(month,1))result.push(month);return result;}
function bucket(metricName){return{metric:metricName,prices:[],areas:[],cycles:[],discounts:[],months:new Set(),volume:0};}
function addBucket(target,month,area,price,cycle,discount){
  target.volume++;target.months.add(month);target.prices.push(price);target.areas.push(area);
  if(Number.isFinite(cycle))target.cycles.push(cycle);if(Number.isFinite(discount))target.discounts.push(discount);
}
function finishBucket(target,name){return{
  [`${name}_price`]:metric(target.prices,target.metric),[`${name}_volume`]:target.volume,[`${name}_months`]:target.months.size,
  [`${name}_area`]:metric(target.areas,'median'),[`${name}_cycle`]:metric(target.cycles,'median'),[`${name}_discount`]:metric(target.discounts,'median'),
};}
function pair(metricName,values={}){return{...values,current:bucket(metricName),base:bucket(metricName)};}
function finishPair(value){return{district:value.district,business_area:value.business_area??null,community:value.community??null,
  ...finishBucket(value.current,'current'),...finishBucket(value.base,'base')};}
// Each scope owns one copy of its monthly facts. Windows advance by merging
// sorted incoming values and removing outgoing values; percentiles are O(1).
function mergeSorted(a,b,remove=false){
  const result=new Float64Array(a.length+(remove?-b.length:b.length));let i=0,j=0,k=0;
  if(remove){while(i<a.length){if(j<b.length&&a[i]===b[j]){i++;j++;}else result[k++]=a[i++];}}
  else {while(i<a.length&&j<b.length)result[k++]=a[i]<=b[j]?a[i++]:b[j++];while(i<a.length)result[k++]=a[i++];while(j<b.length)result[k++]=b[j++];}
  return result;
}
function sortedMetric(values,name){
  if(!values.length)return null;
  if(name==='mean')return metric(values,name);
  if(name==='min')return round(values[0]);if(name==='max')return round(values.at(-1));
  const q=name==='p30'?.3:name==='p60'?.6:.5,i=(values.length-1)*q,lo=Math.floor(i),hi=Math.ceil(i);
  return round(values[lo]+(values[hi]-values[lo])*(i-lo));
}
function trend(monthly,params){
  const fields=['prices','areas','cycles','discounts'],start=shiftMonth(params.trend_start,1-params.window);
  const current=fields.map(()=>new Float64Array()),sorted=new Map(),points=[];
  let volume=0;
  for(const month of months(start,params.current_end)){
    const incoming=monthly.get(month),values=fields.map(field=>Float64Array.from(incoming?.[field]||[]).sort());sorted.set(month,values);
    const previous=shiftMonth(month,-params.window),outgoing=sorted.get(previous);
    volume+=(incoming?.volume||0)-(monthly.get(previous)?.volume||0);
    for(let i=0;i<fields.length;i++){
      let active=current[i];if(outgoing?.[i].length)active=mergeSorted(active,outgoing[i],true);
      current[i]=values[i].length?mergeSorted(active,values[i]):active;
    }
    sorted.delete(previous);
    if(month>=params.trend_start)points.push({month,price:sortedMetric(current[0],params.metric),volume:incoming?.volume||0,window_volume:volume,area:sortedMetric(current[1],'median'),cycle:sortedMetric(current[2],'median'),discount:sortedMetric(current[3],'median')});
  }
  return {points};
}
function qualify(row,params,cityChange){
  row.price_change=change(row.current_price,row.base_price);row.volume_change=change(row.current_volume,row.base_volume);
  row.area_change=change(row.current_area,row.base_area);row.cycle_change=change(row.current_cycle,row.base_cycle);
  row.discount_change=row.current_discount!=null&&row.base_discount!=null?round(row.current_discount-row.base_discount):null;
  row.relative_beijing=row.price_change!=null&&cityChange!=null?round(row.price_change-cityChange):null;
  row.total_volume=(row.current_volume||0)+(row.base_volume||0);
  row.eligible=(row.current_volume||0)>=params.min_current&&(row.base_volume||0)>=params.min_base&&row.total_volume>=params.min_total&&
    (row.current_months||0)>=params.min_active_months&&(row.base_months||0)>=params.min_active_months&&row.price_change!=null;
  return row;
}

export function createMarketAccumulator(params,catalog,part=null){
  const summary=!part||part==='summary',cityTrend=!part||part==='city_trend',districtTrends=!part||part==='district_trends';
  const benchmark=pair(params.metric),districts=new Map(),communities=new Map(),mapGroups=new Map(),trendScopes=new Map(cityTrend?[['全部',new Map()]]:[]);
  const trendHistoryStart=shiftMonth(params.trend_start,1-params.window);
  const group=(store,key,values)=>{let value=store.get(key);if(!value){value=pair(params.metric,values);store.set(key,value);}return value;};
  function add(month,district,businessArea,community,area,price,cycle,discount,rooms){
    if(!Number.isFinite(area)||!Number.isFinite(price))throw Error('invalid_fact');
    if(!between(month,params.history_start,params.history_end)||area<params.area_min||area>params.area_max||(params.rooms!=='全部'&&rooms!==params.rooms))return;
    const current=between(month,params.current_start,params.current_end),base=between(month,params.base_start,params.base_end);
    if(summary&&current)addBucket(benchmark.current,month,area,price,cycle,discount);if(summary&&base)addBucket(benchmark.base,month,area,price,cycle,discount);
    if(summary&&(current||base)){
      const mapDistrict=district==='开发区'?'大兴':district,mapPair=group(mapGroups,mapDistrict,{district:mapDistrict});
      if(current)addBucket(mapPair.current,month,area,price,cycle,discount);if(base)addBucket(mapPair.base,month,area,price,cycle,discount);
    }
    const scoped=(params.district==='全部'||district===params.district)&&(params.business_area==='全部'||businessArea===params.business_area);
    if(!scoped)return;
    if(summary&&(current||base)){
      const districtPair=group(districts,district,{district});
      const communityPair=group(communities,[district,businessArea,community].join(SEP),{district,business_area:businessArea,community});
      for(const value of [districtPair,communityPair]){if(current)addBucket(value.current,month,area,price,cycle,discount);if(base)addBucket(value.base,month,area,price,cycle,discount);}
    }
    if(districtTrends&&!trendScopes.has(district))trendScopes.set(district,new Map());
    if(!between(month,trendHistoryStart,params.current_end))return;
    for(const scope of [...(cityTrend?['全部']:[]),...(districtTrends?[district]:[])]){
      let monthly=trendScopes.get(scope);if(!monthly){monthly=new Map();trendScopes.set(scope,monthly);}
      let value=monthly.get(month);if(!value){value=bucket(params.metric);monthly.set(month,value);}addBucket(value,month,area,price,cycle,discount);
    }
  }
  function addPublic(rows,allowedMonths=null){
    for(const row of rows){
      if(!Array.isArray(row)||row.length<7)throw Error('public_snapshot_mismatch');const location=catalog[row[1]];if(!location)throw Error('public_snapshot_mismatch');
      if(allowedMonths&&!allowedMonths.has(row[0]))continue;
      add(String(row[0]),location[0],location[1],location[2],Number(row[2]),Number(row[3]),row[4]==null?null:Number(row[4]),row[5]==null?null:Number(row[5]),row[6]??null);
    }
  }
  function addPrivate(rows){
    for(const row of rows){
      if(!Array.isArray(row)||row.length!==9)throw Error('private_snapshot_mismatch');
      add(String(row[0]),String(row[1]),String(row[2]),String(row[3]),Number(row[4]),Number(row[5]),row[6]==null?null:Number(row[6]),row[7]==null?null:Number(row[7]),row[8]??null);
    }
  }
  function finish(){
    if(!summary){const trends={};for(const [scope,monthly] of trendScopes)trends[scope]=trend(monthly,params);return {trends};}
    const currentPrice=metric(benchmark.current.prices,params.metric),basePrice=metric(benchmark.base.prices,params.metric),cityChange=change(currentPrice,basePrice);
    const benchmarkResult={current_price:currentPrice,base_price:basePrice,price_change:cityChange,current_volume:benchmark.current.volume,base_volume:benchmark.base.volume,
      volume_change:change(benchmark.current.volume,benchmark.base.volume),current_area:metric(benchmark.current.areas,'median'),base_area:metric(benchmark.base.areas,'median')};
    const districtRows=[...districts.values()].map(finishPair).map(row=>qualify(row,params,cityChange));
    const communityRows=[...communities.values()].map(finishPair).map(row=>qualify(row,params,cityChange));
    const resilience=new Map();for(const row of communityRows){if(!row.eligible)continue;const value=resilience.get(row.district)||{count:0,good:0};value.count++;value.good+=Number(row.price_change>cityChange);resilience.set(row.district,value);}
    for(const row of districtRows){const value=resilience.get(row.district);row.resilient_ratio=value?.count?round(value.good/value.count):null;row.eligible_community_count=value?.count||0;}
    for(const row of communityRows){row.resilient_ratio=null;row.eligible_community_count=null;}
    const map=[...mapGroups.values()].map(finishPair).map(row=>({district:row.district,price_change:change(row.current_price,row.base_price),current_volume:row.current_volume,base_volume:row.base_volume,
      eligible:row.current_volume>=params.min_current&&row.base_volume>=params.min_base&&row.current_volume+row.base_volume>=params.min_total&&row.current_price!=null&&row.base_price!=null&&row.base_price!==0}));
    const trends={};for(const [scope,monthly] of trendScopes)trends[scope]=trend(monthly,params);
    const collator=new Intl.Collator('zh-CN'),textSort=(a,b)=>collator.compare(String(a),String(b));districtRows.sort((a,b)=>textSort(a.district,b.district));
    communityRows.sort((a,b)=>textSort(a.district,b.district)||textSort(a.business_area,b.business_area)||textSort(a.community,b.community));map.sort((a,b)=>textSort(a.district,b.district));
    return {config:params,benchmark:benchmarkResult,districts:districtRows,communities:communityRows,map,...(part?{}:{trends})};
  }
  return {addPublic,addPrivate,finish};
}

export function computeMarket(params,history,privateRows=[]){const accumulator=createMarketAccumulator(params,history.communities||[]);accumulator.addPublic(history.rows||[]);accumulator.addPrivate(privateRows);return accumulator.finish();}
