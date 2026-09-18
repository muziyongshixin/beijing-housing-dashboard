/* Public snapshot analytics only; no private rows, sessions or credentials. */
self.window=self;
importScripts('./vendor/sql-wasm.js','./pages-data.js');
let queue=Promise.resolve();
self.onmessage=({data:{id,method,params}})=>{
  queue=queue.then(async()=>{
    try{
      if(!['initialize','analyze','trend','communityHeatmap','communityDetail','searchCommunities'].includes(method))throw Error('Unknown calculation');
      const value=method==='initialize'
        ?await DashboardData.initialize(message=>postMessage({id,progress:message}))
        :await DashboardData[method](new URLSearchParams(params));
      postMessage({id,value});
    }catch(e){postMessage({id,error:e.message||String(e)});}
  });
};
