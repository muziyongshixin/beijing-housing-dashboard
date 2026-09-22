// No user-supplied target URL, auth forwarding, secret reflection or query logging.
const allowedOrigins=new Set(['https://liyongzhi.xyz','http://127.0.0.1:18876','http://127.0.0.1:18878']);
const paths=new Map([
  ['/v4/maps','restapi.amap.com'],
  ['/v3/place/text','restapi.amap.com'],['/v3/place/detail','restapi.amap.com'],
  ['/v3/geocode/geo','restapi.amap.com'],['/v3/geocode/regeo','restapi.amap.com'],
  ['/v3/log/init','restapi.amap.com'],
  ['/v4/map/styles','webapi.amap.com'],
]);
export function createHandler({key,secret,allow,publicOrigin,fetchUpstream=fetch}) {
  return async request=>{
    const url=new URL(request.url),origin=request.headers.get('origin');
    let refOrigin='';try{refOrigin=new URL(request.headers.get('referer')).origin;}catch{}
    const source=origin||refOrigin;
    const headers={'Access-Control-Allow-Origin':source||'https://liyongzhi.xyz','Vary':'Origin','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    const error=(status,message)=>Response.json({error:message},{status,headers});
    if(source&&!allowedOrigins.has(source))return error(403,'origin_not_allowed');
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'content-type'}});
    if(request.method!=='GET')return error(405,'method_not_allowed');
    if(!key||!secret)return error(503,'map_not_configured');
    const endpoint=url.pathname.replace(/^\/functions\/v1/,'');
    if(endpoint==='/amap-proxy/config')return Response.json({provider:'amap',configured:true,key,mode:'server_proxy',service_host:`${publicOrigin||url.origin.replace(/^http:/,'https:')}/functions/v1/amap-proxy/_AMapService`,auto_geocode:false},{headers});
    if(!source)return error(403,'origin_required');
    const prefix='/amap-proxy/_AMapService',path=endpoint.slice(prefix.length);
    if(!endpoint.startsWith(prefix)||!paths.has(path)||url.search.length>4096)return error(404,'unsupported_map_endpoint');
    if(url.searchParams.get('key')!==key)return error(403,'invalid_map_key');
    if(url.searchParams.has('url')||url.searchParams.has('jscode'))return error(400,'invalid_map_parameter');
    const callback=url.searchParams.get('callback');
    if(callback&&!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback))return error(400,'invalid_callback');
    try {
      if(!await allow(request))return error(429,'map_rate_limited');
      const target=new URL('https://'+paths.get(path)+path);target.search=url.search;
      target.searchParams.set('key',key);target.searchParams.set('jscode',secret);
      const response=await fetchUpstream(target,{headers:{Referer:request.headers.get('referer')||'https://liyongzhi.xyz/beijing-housing-dashboard/'},redirect:'error',signal:AbortSignal.timeout(12000)});
      if(!response.ok)return error(502,'map_upstream_unavailable');
      const body=await response.text();
      if(body.length>2*1024*1024||body.includes(secret))return error(502,'invalid_map_response');
      return new Response(body,{headers:{...headers,'Content-Type':callback?'application/javascript; charset=utf-8':'application/json; charset=utf-8'}});
    }catch{return error(503,'map_temporarily_unavailable');}
  };
}
