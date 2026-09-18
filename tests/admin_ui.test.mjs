import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../static/admin.html',import.meta.url),'utf8'),script=await readFile(new URL('../static/admin.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture({logged=true,admin=true,issue}={}){
  const d=new JSDOM(html,{url:'http://localhost/admin.html',runScripts:'outside-only'}),w=d.window,q=id=>w.document.getElementById(id),calls=[];let authChange;
  w.HousingCloud={client:{auth:{getSession:async()=>({data:{session:logged?{user:{email:'test@example.test'}}:null}}),onAuthStateChange:fn=>authChange=fn,signOut:async()=>{}}},rpc:async(name,args)=>{
    calls.push({name,args});if(name==='housing_admin_access')return{is_admin:admin};if(issue)return issue(args);
    return{ok:true,email:args.p_email,order_ref:args.p_order_ref,duration_days:args.p_duration_days,max_views:args.p_max_views,redeem_before:'2026-10-17'};
  }};
  w.eval(script);return{d,w,q,calls,logout:()=>authChange('SIGNED_OUT'),fill:()=>{q('recipientEmail').value='buyer@example.test';q('issueConfirm').checked=true;},submit:()=>q('issueForm').onsubmit({preventDefault(){}})};
}
test('admin page starts locked; logged-out and ordinary users cannot use issuance',async()=>{
  for(const options of [{logged:false},{admin:false}]){const f=fixture(options);try{assert.equal(f.q('adminPanel').hidden,true);await tick();assert.equal(f.q('adminPanel').hidden,true);f.fill();await f.submit();assert.equal(f.calls.filter(x=>x.name==='housing_admin_issue').length,0);}finally{f.d.window.close();}}
});
test('verified admin issues bounded code without persisting token, duplicate click blocked',async()=>{
  const f=fixture();try{await tick();assert.equal(f.q('adminPanel').hidden,false);f.fill();f.q('maxViews').value='200';await f.submit();
    const c=f.calls.find(x=>x.name==='housing_admin_issue');assert.equal(c.args.p_max_views,200);assert.match(c.args.p_token,/^bj_[A-Za-z0-9_-]{43}$/);assert.equal(f.q('issuedCode').value,c.args.p_token);
    assert.equal(f.q('issuedResult').hidden,false);assert.equal(f.w.localStorage.length,0);assert.equal(f.w.sessionStorage.length,0);
    f.logout();assert.equal(f.q('adminPanel').hidden,true);assert.equal(f.q('issuedCode').value,'');assert.equal(f.q('recipientEmail').value,'');
  }finally{f.d.window.close();}
});
test('network retry keeps exact code/order; a late success after logout is discarded',async()=>{
  let attempt=0,release;const f=fixture({issue:async args=>{if(++attempt===1)throw Error('network');return new Promise(r=>release=()=>r({ok:true,email:args.p_email,order_ref:args.p_order_ref,duration_days:30,max_views:100,redeem_before:'2026-10-17'}));}});
  try{await tick();f.fill();await f.submit();assert.match(f.q('issueButton').textContent,/重试/);const retry=f.submit();await tick();
    const calls=f.calls.filter(x=>x.name==='housing_admin_issue');assert.deepEqual(calls[0].args,calls[1].args);f.logout();release();await retry;assert.equal(f.q('issuedCode').value,'');assert.equal(f.q('adminPanel').hidden,true);
  }finally{f.d.window.close();}
});
test('admin page contains no analytics, user metadata grant, or third-party scripts',()=>{
  const d=new JSDOM(html);try{assert.deepEqual([...d.window.document.scripts].map(s=>s.getAttribute('src')),['./cloud.js','./admin.js']);assert.match(d.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,/script-src 'self'/);assert.doesNotMatch(script,/@qq\.com|user_metadata|service_role/);}finally{d.window.close();}
});
