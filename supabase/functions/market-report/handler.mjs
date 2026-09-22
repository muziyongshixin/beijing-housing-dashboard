import {ALGORITHM,normalizeParams,historicalMonths,cacheKey,digest} from './contract.mjs';
const ORIGINS=new Set(['https://liyongzhi.xyz','https://muziyongshixin.github.io','http://127.0.0.1:18876','http://127.0.0.1:18881']);
export function createMarketHandler({authenticate,rpc,manifest,publicBase,fetchPublic=fetch,delay=ms=>new Promise(r=>setTimeout(r,ms))}){
  // Nothing from the request can change the public input URL, hashes, or private SQL.
  async function read(ref){
    if(!/^https:\/\/raw\.githubusercontent\.com\/muziyongshixin\/beijing-housing-dashboard\/[0-9a-f]{40}\/docs\/$/.test(publicBase))throw Error('public_snapshot_not_configured');
    if(!/^data\/history\/[a-z0-9-]+\.json\.gz$/.test(ref.path))throw Error('invalid_manifest');
    const response=await fetchPublic(publicBase+ref.path,{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('public_snapshot_unavailable');
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(bytes.length!==ref.bytes||await digest(bytes)!==ref.sha256)throw Error('public_snapshot_mismatch');
    const raw=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    if(raw.byteLength!==ref.raw_bytes||raw.byteLength>1000000)throw Error('public_snapshot_mismatch');
    return JSON.parse(new TextDecoder().decode(raw));
  }
  return async request=>{
    const origin=request.headers.get('origin')||'',headers={'Content-Type':'application/json','Cache-Control':'private, no-store','Vary':'Origin',...(ORIGINS.has(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'}:{})};
    const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
    if(origin&&!ORIGINS.has(origin))return reply({error:'origin_denied'},403);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
    let lease;
    try{
      const bodyText=await request.text();if(bodyText.length>8192)return reply({error:'request_too_large'},413);
      const body=JSON.parse(bodyText);if(Object.keys(body).some(k=>!['params','request_id'].includes(k)))throw Error('invalid_parameters');
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id||''))throw Error('invalid_request');
      const uid=await authenticate(request);if(!uid)return reply({error:'verified_email_required'},401);
      const meta=await rpc('housing_market_meta',{p_uid:uid});
      const params=normalizeParams(body.params,meta.latest_date?.slice(0,7));
      const version=await digest(JSON.stringify(manifest)),key=await cacheKey(params,version,meta.revision);
      const args={p_uid:uid,p_request_id:body.request_id,p_key:key};
      let begin;
      for(let attempt=0;attempt<25;attempt++){
        begin=await rpc('housing_market_begin',{...args,p_params:params,p_public_version:version,p_private_version:meta.revision,p_algorithm_version:ALGORITHM});
        if(begin.error)throw Error(begin.error);
        if(!begin.pending)break;await delay(1000);
      }
      if(begin.pending)throw Error('compute_busy');
      if(begin.lease){
        lease=begin.lease;
        const communities=await read(manifest.catalog),rows=[],months=historicalMonths(params,manifest);
        // Bound concurrency and keep only necessary old fields. Never persist source rows.
        for(let offset=0;offset<months.length;offset+=4){
         const batch=months.slice(offset,offset+4);
         const chunks=await Promise.all(batch.map(m=>read(manifest.months[m])));
         for(let i=0;i<batch.length;i++){
          const m=batch[i],chunk=chunks[i];
          for(const row of chunk){
            if(row[0]!==m||m>'2025-08')throw Error('public_snapshot_mismatch');
            if(row[2]>=params.area_min&&row[2]<=params.area_max&&(params.rooms==='全部'||row[6]===params.rooms))rows.push(row);
          }
         }
        }
        const report=await rpc('housing_compute_market',{p_params:params,p_history:{communities,rows}});
        report.data_through=meta.latest_date;
        const stored=await rpc('housing_market_store',{p_key:key,p_lease:lease,p_payload:report});if(stored.error)throw Error(stored.error);lease=null;
      }
      const delivered=await rpc('housing_market_deliver',args);if(delivered.error)throw Error(delivered.error);return reply(delivered);
    }catch(error){
      // Never log the request, history parameters, JWT, or premium result.
      const message=String(error?.message||'market_unavailable');
      const safe=/^[a-z_]{3,80}$/.test(message)?message:'market_unavailable';
      return reply({error:safe},/locked|quota|verified/.test(safe)?403:400);
    }finally{if(lease)try{await rpc('housing_market_release',{p_lease:lease});}catch{}}
  };
}
