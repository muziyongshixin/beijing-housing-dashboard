import {createHandler} from './handler.mjs';
const secret=Deno.env.get('AMAP_SECURITY_CODE')||'',key=Deno.env.get('AMAP_JS_KEY')||'';
const url=Deno.env.get('SUPABASE_URL')||'',service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
Deno.serve(createHandler({key,secret,publicOrigin:url,allow:async(request:Request)=>{
  // Hash with the server secret, so the database never sees raw IP addresses.
  const ip=request.headers.get('x-forwarded-for')?.split(',')[0].trim()||'unknown';
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret+'|'+ip));
  const client=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  const response=await fetch(url+'/rest/v1/rpc/housing_map_allow',{method:'POST',headers:{apikey:service,Authorization:'Bearer '+service,'Content-Type':'application/json'},body:JSON.stringify({p_client:client}),signal:AbortSignal.timeout(5000)});
  return response.ok&&(await response.json())===true;
}}));
