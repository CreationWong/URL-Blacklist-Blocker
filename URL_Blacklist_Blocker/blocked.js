(async () => {
  // 尝试获取当前 extension 页面所在的 tab（更可靠），再回退到 active tab 查询
  const getCurrentTab = () => new Promise(resolve => chrome.tabs.getCurrent(resolve));
  let tab = await getCurrentTab();
  if (!tab) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  }

  let info = null;
  if (tab && tab.id != null) {
    const data = await chrome.storage.local.get(`blocked_info_${tab.id}`);
    info = data[`blocked_info_${tab.id}`];
  }

  // 如果没有在 storage 中找到信息，向后台请求（有时 tab id 获取失败，但后台可以通过 sender.tab 回退）
  if (!info) {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'getBlockedInfo' });
      if (resp && resp.info) info = resp.info;
    } catch (e) {
      // 忽略，最终会保留默认文本
    }
  }

  function fmtPattern(pattern) {
    if (!pattern || typeof pattern !== 'string') return '(无效规则)';
    let s = pattern.replace(/^\|\|/, '').replace(/\^$/, '');
    if (s.startsWith('http://') || s.startsWith('https://')) return s;
    return 'https://' + s;
  }

  if (info) {
    // 显示原始网址
    document.getElementById('url').textContent = `${info.originalUrl}`;
    // 显示触发的黑名单规则（原始 pattern 与友好格式）
    if (info.pattern) {
      document.getElementById('rule').textContent = `${info.pattern}`;
    }
    // 显示触发原因
    document.getElementById('reason').textContent = info.reason ? `${info.reason}` : '（无说明）';
  }

  document.getElementById('allowBtn').onclick = async () => {
    const response = await chrome.runtime.sendMessage({ action: 'tempAllow' });
    if (response?.success && response.originalUrl) {
      window.location.href = response.originalUrl;
    }
  };

  // 打开管理页（避免使用内联事件以满足 CSP）
  const openManageBtn = document.getElementById('openManage');
  if (openManageBtn) {
    openManageBtn.addEventListener('click', () => {
      // 使用 location.href 跳转到扩展的 options/manage 页面
      window.location.href = 'manage.html';
    });
  }
})();

// 全局错误处理，防止页面静默崩溃并展示错误信息
function showRuntimeErrorBlocked(msg) {
  try {
    const container = document.body;
    container.innerHTML = '';
    const box = document.createElement('div');
    box.style.padding = '20px';
    box.style.fontFamily = 'sans-serif';
    box.style.background = '#fff5f5';
    box.style.color = '#7f1d1d';
    box.style.border = '1px solid #fca5a5';
    box.style.borderRadius = '8px';
    box.style.margin = '24px';
    box.innerHTML = `<h2>页面运行错误</h2><div style="white-space:pre-wrap;color:#4b5563">${String(msg)}</div><p>请在扩展控制台查看详细错误或将此信息反馈给开发者。</p>`;
    container.appendChild(box);
  } catch (e) {}
}

window.addEventListener('error', (e) => showRuntimeErrorBlocked(e.message || e.error || '未知错误'));
window.addEventListener('unhandledrejection', (e) => showRuntimeErrorBlocked(e.reason || '未处理的 Promise 拒绝'));