// Keep the existing authenticated application on the same origin as the Aurora landing.
// Only known HTML views and immutable frontend assets may use this read-only adapter.
export function createWorkspaceProxy({ appOrigin, frontendOrigin, fetcher = fetch }) {
 const backend=new URL(appOrigin);
 return async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method))return false;
  const url=new URL(req.url,frontendOrigin);
  const page=/^\/(?:app(?:\/(?:repositories|settings))?|login|bounties|demo)$/.test(url.pathname);
  const asset=/^\/(?:assets\/[A-Za-z0-9_-]+\.(?:js|css)|fonts\/[a-z-]+\.ttf|brand\/[a-z-]+\.(?:png|ico))$/.test(url.pathname);
  if(!page&&!asset)return false;
  try{
   const headers={Accept:page?'text/html':'*/*'};if(page&&req.headers.cookie)headers.Cookie=req.headers.cookie;
   const upstream=await fetcher(new URL(url.pathname+url.search,backend),{method:req.method,headers,redirect:'manual',signal:AbortSignal.timeout(20000)});
   const type=upstream.headers.get('content-type')||'';
   if(upstream.status!==200 || (page&&!type.includes('text/html')))throw new Error('Workspace unavailable');
   res.writeHead(200,{'Content-Type':type,'Cache-Control':page?'no-store':'public, max-age=3600','X-Content-Type-Options':'nosniff'});
   res.end(req.method==='HEAD'?undefined:Buffer.from(await upstream.arrayBuffer()));
  }catch{res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('NearPortal workspace is restarting. Refresh in a moment.');}
  return true;
 };
}
