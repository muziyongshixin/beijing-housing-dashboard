import {shiftMonth} from './contract.mjs';

const SEP='\u0001';
const round=value=>Number.isFinite(value)?Math.round(value*1e6)/1e6:null;
const change=(current,base)=>current!=null&&base!=null&&base!==0?round(current/base-1):null;
const between=(value,start,end)=>value>=start&&value<=end;

function metric(values,name){
  const clean=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!clean.length)return null;
  if(name==='mean')return round(clean.reduce((sum,value)=>sum+value,0)/clean.length);
  if(name==='min')return round(clean[0]);
  if(name==='max')return round(clean.at(-1));
  const percentile=name==='p30'?.3:name==='p60'?.6:.5,index=(clean.length-1)*percentile;
  const lower=Math.floor(index),upper=Math.ceil(index);
  return round(clean[lower]+(clean[upper]-clean[lower])*(index-lower));
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
function combined(buckets,field){const values=[];for(const item of buckets)values.push(...item[field]);return values;}
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

export function createMarketAccumulator(params,catalog){
  const benchmark=pair(params.metric),districts=new Map(),communities=new Map(),mapGroups=new Map(),trendScopes=new Map();
  const trendHistoryStart=shiftMonth(params.trend_start,1-params.window);
  const group=(store,key,values)=>{let value=store.get(key);if(!value){value=pair(params.metric,values);store.set(key,value);}return value;};
  function add(month,district,businessArea,community,area,price,cycle,discount,rooms){
    if(!between(month,params.history_start,params.history_end)||area<params.area_min||area>params.area_max||(params.rooms!=='全部'&&rooms!==params.rooms))return;
    const current=between(month,params.current_start,params.current_end),base=between(month,params.base_start,params.base_end);
    if(current)addBucket(benchmark.current,month,area,price,cycle,discount);if(base)addBucket(benchmark.base,month,area,price,cycle,discount);
    if(current||base){
      const mapDistrict=district==='开发区'?'大兴':district,mapPair=group(mapGroups,mapDistrict,{district:mapDistrict});
      if(current)addBucket(mapPair.current,month,area,price,cycle,discount);if(base)addBucket(mapPair.base,month,area,price,cycle,discount);
    }
    const scoped=(params.district==='全部'||district===params.district)&&(params.business_area==='全部'||businessArea===params.business_area);
    if(!scoped)return;
    if(current||base){
      const districtPair=group(districts,district,{district});
      const communityPair=group(communities,[district,businessArea,community].join(SEP),{district,business_area:businessArea,community});
      for(const value of [districtPair,communityPair]){if(current)addBucket(value.current,month,area,price,cycle,discount);if(base)addBucket(value.base,month,area,price,cycle,discount);}
    }
    if(!between(month,trendHistoryStart,params.current_end))return;
    for(const scope of ['全部',district]){
      let monthly=trendScopes.get(scope);if(!monthly){monthly=new Map();trendScopes.set(scope,monthly);}
      let value=monthly.get(month);if(!value){value=bucket(params.metric);monthly.set(month,value);}addBucket(value,month,area,price,cycle,discount);
    }
  }
  function addPublic(rows){
    for(const row of rows){
      if(!Array.isArray(row)||row.length<7)throw Error('public_snapshot_mismatch');const location=catalog[row[1]];if(!location)throw Error('public_snapshot_mismatch');
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
    const trends={};for(const [scope,monthly] of trendScopes)trends[scope]={points:months(params.trend_start,params.current_end).map(month=>{
      const window=months(shiftMonth(month,1-params.window),month).map(cursor=>monthly.get(cursor)).filter(Boolean),exact=monthly.get(month);
      return {month,price:metric(combined(window,'prices'),params.metric),volume:exact?.volume||0,window_volume:window.reduce((sum,item)=>sum+item.volume,0),area:metric(combined(window,'areas'),'median'),cycle:metric(combined(window,'cycles'),'median'),discount:metric(combined(window,'discounts'),'median')};
    })};
    const textSort=(a,b)=>String(a).localeCompare(String(b),'zh-CN');districtRows.sort((a,b)=>textSort(a.district,b.district));
    communityRows.sort((a,b)=>textSort(a.district,b.district)||textSort(a.business_area,b.business_area)||textSort(a.community,b.community));map.sort((a,b)=>textSort(a.district,b.district));
    return {config:params,benchmark:benchmarkResult,districts:districtRows,communities:communityRows,map,trends};
  }
  return {addPublic,addPrivate,finish};
}

export function computeMarket(params,history,privateRows=[]){const accumulator=createMarketAccumulator(params,history.communities||[]);accumulator.addPublic(history.rows||[]);accumulator.addPrivate(privateRows);return accumulator.finish();}
