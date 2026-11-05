// Presentation-only controls. No funding, claims, wallet actions or external API calls.
const tabs=[...document.querySelectorAll('[role=tab]')];
function selectTab(tab,focus=false){for(const t of tabs){const active=t===tab;t.setAttribute('aria-selected',String(active));t.tabIndex=active?0:-1;document.getElementById(t.getAttribute('aria-controls')).hidden=!active;}if(focus)tab.focus();}
for(const [index,tab] of tabs.entries()){tab.addEventListener('click',()=>selectTab(tab));tab.addEventListener('keydown',event=>{let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();selectTab(tabs[next],true);});}
const dialog=document.getElementById('agent-preview');
for(const button of document.querySelectorAll('[data-agent-preview]'))button.addEventListener('click',event=>{event.preventDefault();selectTab(document.getElementById('agent-tab'));dialog.showModal();});
dialog.querySelector('.dialog-close').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
