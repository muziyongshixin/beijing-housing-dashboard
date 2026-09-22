import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../supabase/functions/amap-proxy/handler.mjs';
const key='fake-public-key',secret='fake-private-security-code';
const base='https://project.supabase.co/functions/v1/amap-proxy';
const request=(path,headers={Origin:'https://liyongzhi.xyz'},method='GET')=>new Request(base+path,{headers,method});
test('configuration exposes only the public SDK key and proxy',async()=>{
  const handler=createHandler({key,secret,allow:async()=>true});
  const r=await handler(request('/config',{})),s=await r.text();
  assert.equal(r.status,200);assert.ok(!s.includes(secret));
  assert.equal(JSON.parse(s).service_host,base+'/_AMapService');
  assert.equal(JSON.parse(s).auto_geocode,false);
});
test('proxy restricts origin, method, endpoint, key and callback',async()=>{
  let calls=0;
  const handler=createHandler({key,secret,allow:async()=>true,fetchUpstream:async()=>{calls++;return new Response('{}');}});
  for(const [r,status]of [
    [request('/_AMapService/v3/place/text?key='+key,{Origin:'https://evil.test'}),403],
    [request('/_AMapService/v3/place/text?key='+key,{}),403],
    [request('/config',undefined,'POST'),405],
    [request('/_AMapService/other?key='+key),404],
    [request('/_AMapService/v3/place/text?key=wrong'),403],
    [request('/_AMapService/v3/place/text?key='+key+'&url=https://evil.test'),400],
    [request('/_AMapService/v3/place/text?key='+key+'&callback=alert(1)'),400],
  ])assert.equal((await handler(r)).status,status);
  assert.equal(calls,0);
});
test('proxy injects server secret, blocks redirects/reflection and never forwards auth',async()=>{
  let target,options;
  const handler=createHandler({key,secret,allow:async()=>true,fetchUpstream:async(u,o)=>{target=u;options=o;return new Response('cb({"ok":true})');}});
  const r=await handler(request('/_AMapService/v3/place/text?key='+key+'&callback=cb',{Origin:'https://liyongzhi.xyz',Authorization:'Bearer private'}));
  assert.equal(r.status,200);assert.equal(target.host,'restapi.amap.com');assert.equal(target.searchParams.get('jscode'),secret);
  assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,undefined);
  assert.match(r.headers.get('content-type'),/^application\/javascript/);
  const telemetry=await handler(request('/_AMapService/v3/log/init?key='+key+'&callback=jsonp_123'));
  assert.equal(telemetry.status,200);assert.match(telemetry.headers.get('content-type'),/^application\/javascript/);
  const reflected=createHandler({key,secret,allow:async()=>true,fetchUpstream:async()=>new Response(secret)});
  const error=await reflected(request('/_AMapService/v4/maps?key='+key));assert.equal(error.status,502);assert.ok(!(await error.text()).includes(secret));
});
test('proxy fails closed when quota denied or quota service fails',async()=>{
  for(const allow of [async()=>false,async()=>{throw Error('offline');}]){
    const handler=createHandler({key,secret,allow,fetchUpstream:async()=>{throw Error('must not fetch');}});
    const r=await handler(request('/_AMapService/v4/maps?key='+key));assert.ok([429,503].includes(r.status));
  }
});
test('Supabase stripped prefix and internal HTTP URL retain public HTTPS serviceHost',async()=>{
  const handler=createHandler({key,secret,allow:async()=>true,fetchUpstream:async()=>new Response('{}')});
  const r=await handler(new Request('http://project.supabase.co/amap-proxy/config'));
  assert.equal((await r.json()).service_host,base+'/_AMapService');
  assert.equal((await handler(new Request('http://project.supabase.co/amap-proxy/_AMapService/v4/maps?key='+key,{headers:{Origin:'https://liyongzhi.xyz'}}))).status,200);
});
