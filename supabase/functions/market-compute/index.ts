import {computeReportPart} from '../market-report/handler.mjs';
import {normalizeParams,digest} from '../market-report/contract.mjs';
import manifest from '../market-report/public-history-manifest.json' with {type:'json'};
const url=Deno.env.get('SUPABASE_URL')||'',service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
Deno.serve(async request=>{
  const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store'}});
  // Only the report orchestrator can invoke this worker. No browser CORS route,
  // user JWT, client history, custom data URL, or unnormalized parameters.
  if(request.method!=='POST'||!service||await digest(request.headers.get('authorization')||'')!==await digest('Bearer '+service))return reply({error:'unauthorized'},401);
  try{
    const text=await request.text();if(text.length>8192)throw Error('invalid_request');
    const {uid,lease,params,part}=JSON.parse(text);
    if(!['summary','city_trend','district_trends'].includes(part)||!uid||!lease)throw Error('invalid_request');
    const input=Object.fromEntries(Object.entries(params).filter(([key])=>['end_month','window','compare','base_start','base_end','metric','district','business_area','rooms','area_min','area_max','min_current','min_base','min_total','min_active_months'].includes(key)));
    if(JSON.stringify(normalizeParams(input,params.end_month))!==JSON.stringify(params))throw Error('invalid_parameters');
    const rpc=async(name:string,args:unknown)=>{const r=await fetch(url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:service,Authorization:'Bearer '+service,'Content-Type':'application/json'},body:JSON.stringify(args)});const body=await r.json();if(!r.ok||body.error)throw Error(body.error||'database_unavailable');return body;};
    // Check the existing lease and entitlement before any substantial work.
    await rpc('housing_market_private_rows',{p_uid:uid,p_lease:lease,p_after:0,p_page_size:1,p_params:params});
    return reply(await computeReportPart({uid,lease,params,part,manifest,publicBase:Deno.env.get('MARKET_PUBLIC_BASE')||'',rpc}));
  }catch(error){const message=String(error?.message||'compute_unavailable');return reply({error:/^[a-z_]{3,80}$/.test(message)?message:'compute_unavailable'},400);}
});
