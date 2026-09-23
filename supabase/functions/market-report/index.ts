import {createMarketHandler} from './handler.mjs';
import manifest from './public-history-manifest.json' with {type:'json'};
const url=Deno.env.get('SUPABASE_URL')||'',service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
async function rpc(name:string,args:unknown){
  const r=await fetch(url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:service,Authorization:'Bearer '+service,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(100000)});
  const body=await r.json();if(!r.ok||body?.error)throw Error(body?.error||'database_unavailable');return body;
}
Deno.serve(createMarketHandler({manifest,publicBase:Deno.env.get('MARKET_PUBLIC_BASE')||'',rpc,computeParts:async(args)=>{
    const parts=await Promise.all(['summary','city_trend','district_trends'].map(async part=>{
      const response=await fetch(url+'/functions/v1/market-compute',{method:'POST',headers:{apikey:service,Authorization:'Bearer '+service,'Content-Type':'application/json'},body:JSON.stringify({...args,part}),signal:AbortSignal.timeout(110000)});
      const body=await response.json();if(!response.ok||body.error)throw Error(body.code==='WORKER_RESOURCE_LIMIT'?'compute_resource_limit':body.error||'compute_unavailable');return body;
    }));
    return {...parts[0],trends:{...parts[1].trends,...parts[2].trends}};
  },
  authenticate:async(request:Request)=>{
    const bearer=request.headers.get('authorization')||'';if(!bearer.startsWith('Bearer '))return null;
    const r=await fetch(url+'/auth/v1/user',{headers:{apikey:service,Authorization:bearer},signal:AbortSignal.timeout(10000)});
    if(!r.ok)return null;const user=await r.json();return user.email_confirmed_at&&!user.is_anonymous?user.id:null;
  }}));
