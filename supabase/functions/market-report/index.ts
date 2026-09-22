import {createMarketHandler} from './handler.mjs';
import manifest from './public-history-manifest.json' with {type:'json'};
const url=Deno.env.get('SUPABASE_URL')||'',service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
async function rpc(name:string,args:unknown){
  const r=await fetch(url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:service,Authorization:'Bearer '+service,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(100000)});
  const body=await r.json();if(!r.ok||body?.error)throw Error(body?.error||'database_unavailable');return body;
}
Deno.serve(createMarketHandler({manifest,publicBase:Deno.env.get('MARKET_PUBLIC_BASE')||'',rpc,
  authenticate:async(request:Request)=>{
    const bearer=request.headers.get('authorization')||'';if(!bearer.startsWith('Bearer '))return null;
    const r=await fetch(url+'/auth/v1/user',{headers:{apikey:service,Authorization:bearer},signal:AbortSignal.timeout(10000)});
    if(!r.ok)return null;const user=await r.json();return user.email_confirmed_at&&!user.is_anonymous?user.id:null;
  }}));
