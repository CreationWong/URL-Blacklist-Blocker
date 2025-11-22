async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function migrateEntry(entry) {
  if (typeof entry === 'string') return { pattern: entry, reason: '' };
  return { pattern: entry?.pattern || '', reason: entry?.reason || '' };
}

async function init() {
  const tab = await getCurrentTab();

  const isRestricted = !tab?.url || 
    ['chrome://', 'edge://', 'about:', 'extension://', 'chrome-extension://'].some(p => tab.url.startsWith(p));

  const currentUrlEl = document.getElementById('currentUrl');
  const blockBtn = document.getElementById('blockBtn');

  if (isRestricted) {
    currentUrlEl.textContent = '当前页面无法操作';
    blockBtn.disabled = true;
    blockBtn.title = '浏览器内部页面无法屏蔽';
  } else {
    currentUrlEl.textContent = tab.url;
    blockBtn.onclick = async () => {
      const reason = prompt('请输入封禁原因（可留空）：', '');
      if (reason === null) return;

      try {
        const url = new URL(tab.url);
        const pattern = `||${url.hostname}${url.pathname}^`;

        const res = await chrome.storage.local.get(['blacklist']);
        let blacklist = (res.blacklist || []).map(migrateEntry);

        if (blacklist.some(item => item.pattern === pattern)) {
          alert('该网址已在黑名单中！');
          return;
        }

        blacklist.push({ pattern, reason: reason.trim() || '' });
        await chrome.storage.local.set({ blacklist });

        alert('✅ 已成功屏蔽该网址！');
        window.close();
      } catch (e) {
        alert('❌ 屏蔽失败：' + e.message);
      }
    };
  }

  document.getElementById('manageBtn').onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
    window.close();
  };

  // 显示当前使用的规则总数（本地 + 远程）
  try {
    const res = await chrome.storage.local.get(['blacklist', 'remote_blacklist']);
    const local = (res.blacklist || []).length;
    const remote = (res.remote_blacklist || []).length;
    const countEl = document.getElementById('ruleCount');
    if (countEl) countEl.textContent = (local + remote).toString();
  } catch (e) {
    console.error('Failed to read rule counts', e);
  }
}

// 全局错误处理，防止弹出页静默崩溃，显示错误信息
function showRuntimeErrorPopup(msg) {
  try {
    const container = document.body;
    container.innerHTML = '';
    const box = document.createElement('div');
    box.style.padding = '12px';
    box.style.fontFamily = 'sans-serif';
    box.style.background = '#fff5f5';
    box.style.color = '#7f1d1d';
    box.style.border = '1px solid #fca5a5';
    box.style.borderRadius = '8px';
    box.style.margin = '8px';
    box.innerHTML = `<strong>扩展错误</strong><div style="white-space:pre-wrap;color:#4b5563">${String(msg)}</div>`;
    container.appendChild(box);
  } catch (e) {}
}

window.addEventListener('error', (e) => showRuntimeErrorPopup(e.message || e.error || '未知错误'));
window.addEventListener('unhandledrejection', (e) => showRuntimeErrorPopup(e.reason || '未处理的 Promise 拒绝'));

init().catch(err => { console.error(err); showRuntimeErrorPopup(err?.stack || err?.message || String(err)); });