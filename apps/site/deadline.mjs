// Display only: deadlines and assignment outcomes remain server-authoritative.
export function deadlineState(b, now = Date.now()) {
  const m = b.deadlineWindow || (b.marketTerms?.kind === 'fixed' ? b.market : null);
  if (!m || b.status?.key === 'paid' || b.task?.payment?.state === 'Processed' || m.settlement?.processed) return null;
  const a = m.assignment;
  if (!a) return {kind:'available', label:'Timed bounty', value:duration(m.deliveryHours), note:'Delivery window after claim', progress:1};
  if (!a.confirmed || !Number.isFinite(a.deadline)) return {kind:'pending', label:'Exclusive assignment', value:'Confirming', note:'Clock starts on confirmation', progress:1};
  if (a.submission) return {kind:'submitted', label:'Delivery registered', value:'On time', note:'Submitted · under review', progress:1, deadline:a.deadline};
  if (a.withdrawRequested) return {kind:'pending', label:'Exclusive assignment', value:'Releasing', note:'Awaiting escrow confirmation', progress:0, deadline:a.deadline};
  const total = Number(m.deliveryHours) * 3600000, left = Math.max(0, a.deadline - now);
  if (!left) return {kind:'expired', label:'Delivery window ended', value:'00:00:00', note:'Awaiting assignment update', progress:0, deadline:a.deadline};
  const seconds = Math.ceil(left / 1000), h = Math.floor(seconds / 3600), min = Math.floor(seconds % 3600 / 60), sec = seconds % 60;
  const value = [h,min,sec].map(n => String(n).padStart(2,'0')).join(':');
  const progress = total > 0 ? Math.min(1,left / total) : 0;
  const found = Number.isSafeInteger(a.candidate?.prNumber) ? `PR #${a.candidate.prNumber} found · not submitted yet` : null;
  return {kind:left <= Math.min(900000,total * .25) ? 'urgent':'active', label:'Time remaining', value, note:found || 'Exclusive delivery window', progress, deadline:a.deadline};
}
export function duration(hours) { return hours % 24 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${hours / 24} day${hours === 24 ? '' : 's'}`; }
const clockOffsets = new WeakMap();
const nodes = new Map();
let ticking = false;
const element = (tag, cls, text) => { const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n; };
export function deadlineIndicator(b, compact=false) {
  const m=b.deadlineWindow||b.market;
  if (m && !clockOffsets.has(m)) clockOffsets.set(m, Number.isFinite(m.serverNow) ? m.serverNow-Date.now() : 0);
  const offset=m ? clockOffsets.get(m)||0 : 0;
  if(!deadlineState(b,Date.now()+offset)) return null;
  const box=element('div','delivery-clock'+(compact?' delivery-clock-compact':''));
  const dial=element('div','delivery-dial');dial.setAttribute('aria-hidden','true');
  const face=element('span','delivery-dial-face');
  if(compact) face.textContent='◷'; else {const img=element('img','');img.src='/public/brand/guide.png';img.alt='';img.width=44;img.height=44;face.append(img);}
  dial.append(face);
  const body=element('div','delivery-clock-body'),label=element('span','delivery-clock-label'),value=element('strong','delivery-clock-value'),note=element('span','delivery-clock-note');
  body.append(label,value,note);
  const due=element('div','delivery-clock-due'),track=element('div','delivery-track'),fill=element('span','');track.setAttribute('aria-hidden','true');track.append(fill);
  box.append(dial,body,due,track);
  let renderedDeadline;
  const update=()=>{const s=deadlineState(b,Date.now()+offset);if(!s){box.hidden=true;return;}box.dataset.phase=s.kind;box.style.setProperty('--delivery-progress',String(s.progress));label.textContent=s.label;value.textContent=s.value;note.textContent=s.note;
    if(s.deadline !== renderedDeadline){renderedDeadline=s.deadline;due.replaceChildren();if(s.deadline){const heading=element('span','','Deadline'),time=element('time','',new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(s.deadline));time.dateTime=new Date(s.deadline).toISOString();due.append(heading,time);box.title='Deadline: '+new Date(s.deadline).toLocaleString();}}
    value.setAttribute('aria-label',s.kind==='active'||s.kind==='urgent'?s.value.split(':').map((n,i)=>`${Number(n)} ${['hours','minutes','seconds'][i]}`).join(', ')+' remaining':s.value);
  };
  update();nodes.set(box,update);
  if(!ticking){ticking=true;setInterval(()=>{for(const [n,fn] of nodes){if(!n.isConnected)nodes.delete(n);else if(!document.hidden)fn();}},1000);}
  return box;
}
