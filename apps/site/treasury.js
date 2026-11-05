import { mountShell, poll } from '/workspace-shell.mjs';
const $=selector=>document.querySelector(selector);
const shell=mountShell($('#app-header'),{path:location.pathname,brandSrc:'/public/brand/guide.png'});
const money=cents=>new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR'}).format(cents/100);
async function api(path){const res=await fetch('/api/portal'+path,{credentials:'same-origin',cache:'no-store'});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not load the demo wallet.');return data;}
let refreshing=false;
async function load(){if(refreshing)return;refreshing=true;$('#refresh-wallet').disabled=true;
 try{
  if(!window.__me||Date.now()-window.__meAt>120000){window.__me=await api('/me');window.__meAt=Date.now();}const me=window.__me;shell.setMe(me);
  if(!me.user){$('#wallet-description').textContent='Sign in with GitHub to open the demo wallet. It is available to the demo operator.';$('#wallet-content').hidden=true;return;}
  const wallet=await api('/treasury');
  $('#wallet-error').hidden=true;
  if(!wallet.available||!wallet.configured){$('#wallet-description').textContent=wallet.available?'The demo wallet is not linked yet. The demo operator manages this sandbox treasury.':'Demo wallet unavailable. The demo operator manages this sandbox treasury.';$('#wallet-content').hidden=true;return;}
  $('#wallet-content').hidden=false;$('#wallet-description').textContent='Sandbox EURe used to fund test bounty escrows.';
  $('#wallet-address').textContent=wallet.address;$('#wallet-balance').textContent=wallet.balanceCents===undefined?'Unavailable':money(wallet.balanceCents);$('#wallet-gas').textContent=wallet.gasWei===undefined?'Unavailable':(Number(BigInt(wallet.gasWei))/1e18).toLocaleString(undefined,{maximumFractionDigits:8})+' test ETH';
  $('#wallet-limit').textContent=money(wallet.maxCents)+' per bounty';
  $('#funding-ready').textContent=wallet.balanceCents>0&&BigInt(wallet.gasWei||'0')>0n?'Ready to fund sandbox bounties':'One-time top-up needed';
  $('#wallet-status').textContent=wallet.error||'Base Sepolia · test funds only';
  $('#wallet-explorer').href='https://sepolia.basescan.org/address/'+wallet.address;
  $('#copy-wallet').onclick=async()=>{try{await navigator.clipboard.writeText(wallet.address);$('#copy-wallet').textContent='Copied';setTimeout(()=>$('#copy-wallet').textContent='Copy address',2000);}catch{$('#wallet-status').textContent='Select the address and copy it manually.';}};
 }catch(error){$('#wallet-error').textContent=error.message;$('#wallet-error').hidden=false;return false;}
 finally{refreshing=false;$('#refresh-wallet').disabled=false;}
}
$('#refresh-wallet').addEventListener('click',load);
await load();poll(load,{interval:30000});
