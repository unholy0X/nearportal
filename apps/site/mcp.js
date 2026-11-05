// Guide-only controls. No account requests, signing, funding or MCP actions.
const copyStatus = document.getElementById('copy-status');
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      button.textContent = 'Copied';
      copyStatus.textContent = `${button.getAttribute('aria-label')} copied to clipboard.`;
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'Selected';
      copyStatus.textContent = 'Text selected. Copy it with your keyboard.';
    }
    setTimeout(() => { button.textContent = original; }, 2000);
  });
}
document.getElementById('permission-role').addEventListener('change', event => {
  document.getElementById('login-code').textContent = `nearportal-mcp login --server https://nearportal.com --scopes ${event.target.value}`;
});
const tabs = [...document.querySelectorAll('[role=tab]')];
function selectClient(tab, focus = false) {
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
  }
  if (focus) tab.focus();
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectClient(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectClient(tabs[next], true);
  });
}
