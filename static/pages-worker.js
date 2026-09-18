/* Public snapshot analytics only; no private rows, sessions or credentials. */
self.window=self;
importScripts('./pages-data.js');
let ready;
self.onmessage=({data:{id,method,params}})=>{
  (async()=>{
    try{
      if(!['initialize','analyze','trend','communityHeatmap','communityDetail','searchCommunities'].includes(method))throw Error('Unknown calculation');
      if(!ready)ready=DashboardData.initialize(message=>postMessage({id:method==='initialize'?id:0,progress:message})).catch(error=>{ready=null;throw error;});
      const meta=await ready;
      const value=method==='initialize'?meta:await DashboardData[method](new URLSearchParams(params));
      postMessage({id,value});
    }catch(e){postMessage({id,error:e.message||String(e)});}
  })();
};
