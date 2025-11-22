function migrateEntry(entry) {
  if (typeof entry === 'string') return { pattern: entry, reason: '' };
  return { pattern: entry?.pattern || '', reason: entry?.reason || '' };
}

function toDisplay(pattern) {
  if (!pattern || typeof pattern !== 'string') return '(无效规则)';
  let s = pattern.replace(/^\|\|/, '').replace(/\^$/, '');
  if (s.startsWith('http://') || s.startsWith('https://')) {
    return s;
  }
  return 'https://' + s;
}

// 获取最新黑名单（封装）
async function getBlacklist() {
  const res = await chrome.storage.local.get(['blacklist']);
  // 同步迁移并过滤掉无效项（pattern 为空的项会被保留在 UI 中作为“无效规则”）
  const raw = res.blacklist || [];
  return raw.map(migrateEntry);
}

// 保存黑名单
async function saveBlacklist(blacklist) {
  await chrome.storage.local.set({ blacklist });
}

async function addRule() {
  const url = document.getElementById('newUrl').value.trim();
  const reason = document.getElementById('newReason').value.trim();

  if (!url) {
    alert('请输入网址');
    return;
  }

  try {
    new URL(url);
  } catch (e) {
    alert('请输入完整的网址，如 https://example.com');
    return;
  }

  const u = new URL(url);
  const pattern = `||${u.hostname}${u.pathname}^`;

  const blacklist = await getBlacklist();

  if (blacklist.some(item => item.pattern === pattern)) {
    alert('该网址已在黑名单中！');
    return;
  }

  blacklist.push({ pattern, reason });
  await saveBlacklist(blacklist);
  render(blacklist);

  document.getElementById('newUrl').value = '';
  document.getElementById('newReason').value = '';
}

function createRuleEl(entry) {
  const div = document.createElement('div');
  div.className = 'rule-item';

  const urlEl = document.createElement('div');
  urlEl.className = 'rule-url';
  urlEl.textContent = toDisplay(entry.pattern);

  const reasonEl = document.createElement('div');
  reasonEl.className = 'rule-reason';
  reasonEl.textContent = entry.reason || '—';

  const actions = document.createElement('div');
  const delBtn = document.createElement('button');
  delBtn.className = 'btn-danger';
  delBtn.textContent = '删除';
  delBtn.style.marginLeft = '10px';
  delBtn.onclick = async () => {
    if (!confirm('确定删除？')) return;

    const current = await getBlacklist();
    const filtered = current.filter(item => item.pattern !== entry.pattern);
    await saveBlacklist(filtered);
    render(filtered);
  };

  actions.appendChild(delBtn);
  div.appendChild(urlEl);
  div.appendChild(reasonEl);
  div.appendChild(actions);
  return div;
}

function render(entries) {
  const container = document.getElementById('rulesList');
  document.getElementById('count').textContent = entries.length;

  if (entries.length === 0) {
    container.innerHTML = '<div class="empty">暂无黑名单规则</div>';
    return;
  }

  container.innerHTML = '';
  entries.forEach(entry => {
    container.appendChild(createRuleEl(entry));
  });
}

// ---------------- remote rules ----------------
async function getRemoteRules() {
  const res = await chrome.storage.local.get(['remote_blacklist']);
  return (res.remote_blacklist || []).map(migrateEntry);
}

async function saveRemoteRules(remote) {
  await chrome.storage.local.set({ remote_blacklist: remote });
}

function createRemoteRuleEl(entry) {
  const div = document.createElement('div');
  div.className = 'rule-item';

  const left = document.createElement('div');
  left.className = 'rule-left';
  const urlEl = document.createElement('div');
  urlEl.className = 'rule-url';
  urlEl.textContent = toDisplay(entry.pattern || entry.url || '');

  const infoEl = document.createElement('div');
  infoEl.className = 'rule-reason';
  infoEl.textContent = entry.reason || entry.info || '—';

  left.appendChild(urlEl);
  left.appendChild(infoEl);

  const actions = document.createElement('div');
  const delBtn = document.createElement('button');
  delBtn.className = 'btn-danger';
  delBtn.textContent = '删除';
  delBtn.onclick = async () => {
    if (!confirm('确定删除该远程规则？')) return;
    const current = await getRemoteRules();
    const filtered = current.filter(item => item.pattern !== entry.pattern || item.url !== entry.url);
    await saveRemoteRules(filtered);
    renderRemote(filtered);
    try { chrome.runtime.sendMessage({ action: 'refreshRules' }); } catch (e) {}
  };
  actions.appendChild(delBtn);

  div.appendChild(left);
  div.appendChild(actions);
  return div;
}

function renderRemote(entries) {
  const container = document.getElementById('remoteList');
  if (!entries || entries.length === 0) {
    container.innerHTML = '<div class="empty">暂无远程规则</div>';
    return;
  }
  container.innerHTML = '';
  entries.forEach(e => container.appendChild(createRemoteRuleEl(e)));
}

function renderSubscriptions(subs) {
  const container = document.getElementById('subscriptionsList');
  if (!container) return;
  const keys = Object.keys(subs || {});
  if (keys.length === 0) {
    container.innerHTML = '<div class="empty">暂无订阅</div>';
    return;
  }
  container.innerHTML = '';
  keys.forEach(src => {
    const meta = subs[src] || {};
    const div = document.createElement('div');
    div.className = 'subscription-item';
    const left = document.createElement('div');
    left.textContent = src;
    left.style.fontWeight = '500';
    const right = document.createElement('div');
    right.style.opacity = '0.8';
    const when = meta.lastUpdated ? new Date(meta.lastUpdated).toLocaleString() : '未知';
    const count = meta.count || 0;
    right.textContent = `最近更新时间：${when}，规则数：${count}`;
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    const editBtn = document.createElement('button');
    editBtn.textContent = '编辑';
    editBtn.className = 'btn';
    editBtn.onclick = () => editSubscription(src);
    const delBtn = document.createElement('button');
    delBtn.textContent = '取消订阅';
    delBtn.className = 'btn-danger';
    delBtn.onclick = () => deleteSubscription(src);
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    div.appendChild(left);
    div.appendChild(right);
    div.appendChild(actions);
    div.style.display = 'flex';
    div.style.justifyContent = 'space-between';
    div.style.padding = '8px 0';
    div.style.borderBottom = '1px dashed #eee';
    container.appendChild(div);
  });
}

async function addSubscription() {
  const src = document.getElementById('remoteSource').value.trim();
  if (!src) { alert('请输入订阅 URL'); return; }
  try {
    // basic validation
    new URL(src);
  } catch (e) {
    alert('请输入合法的 URL（包含协议）');
    return;
  }
  // persist to remote_sources with unknown lastUpdated/count initially
  const prev = await chrome.storage.local.get(['remote_sources']);
  const map = prev.remote_sources || {};
  if (map[src]) { alert('该订阅已存在'); return; }
  map[src] = { lastUpdated: null, count: 0 };
  await chrome.storage.local.set({ remote_sources: map });
  renderSubscriptions(map);
  // trigger immediate fetch for this source
  try { chrome.runtime.sendMessage({ action: 'triggerFetchRemote' }); } catch (e) {}
  alert('已添加订阅并触发一次同步');
}

async function deleteSubscription(src) {
  if (!confirm('确认删除订阅？')) return;
  // remove from remote_sources
  const prev = await chrome.storage.local.get(['remote_sources','remote_blacklist']);
  const map = prev.remote_sources || {};
  delete map[src];
  // remove items from remote_blacklist with this source
  const remote = (prev.remote_blacklist || []).filter(r => r.source !== src);
  await chrome.storage.local.set({ remote_sources: map, remote_blacklist: remote });
  renderSubscriptions(map);
  renderRemote(remote);
  try { chrome.runtime.sendMessage({ action: 'refreshRules' }); } catch (e) {}
}

async function editSubscription(src) {
  const newSrc = prompt('修改订阅 URL:', src);
  if (!newSrc || newSrc.trim() === src) return;
  try { new URL(newSrc.trim()); } catch (e) { alert('请输入合法的 URL'); return; }
  // perform delete then add
  await deleteSubscription(src);
  const prev = await chrome.storage.local.get(['remote_sources']);
  const map = prev.remote_sources || {};
  map[newSrc.trim()] = { lastUpdated: null, count: 0 };
  await chrome.storage.local.set({ remote_sources: map });
  renderSubscriptions(map);
  try { chrome.runtime.sendMessage({ action: 'triggerFetchRemote' }); } catch (e) {}
}

async function importRemote() {
  const src = document.getElementById('remoteSource').value.trim();
  const btn = document.getElementById('importRemoteBtn');
  if (!src) { alert('请输入远程规则文件 URL'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '导入中...'; }
  try {
    console.log('importRemote: fetching', src);
    const resp = await fetch(src, { cache: 'no-store' });
    if (!resp.ok) throw new Error('无法下载远程文件: ' + resp.status);
    // try parse JSON text (some raw hosts may include BOM or whitespace)
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      // fallback: try to strip leading/trailing characters
      const trimmed = text.trim();
      json = JSON.parse(trimmed);
    }
    if (!Array.isArray(json)) throw new Error('远程文件必须为 JSON 数组');

    // map to internal format
    const remoteFromThisSrc = json.map(item => {
      const url = (typeof item.url === 'string') ? item.url : '';
      const info = item.info || item.reason || '';
      // normalize to pattern if possible
      let pattern = '';
      try {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          const u = new URL(url);
          pattern = `||${u.hostname}${u.pathname}^`;
        } else {
          pattern = `||${url.replace(/^\/+/, '')}^`;
        }
      } catch (e) {
        pattern = `||${url}^`;
      }
      return { pattern, reason: info, url };
    });

    // merge: existing local rules take precedence
    const localRes = await chrome.storage.local.get(['blacklist']);
    const local = (localRes.blacklist || []).map(migrateEntry);
    const localPatterns = new Set(local.map(i => i.pattern));

    // read existing remote rules
    const existingRes = await chrome.storage.local.get(['remote_blacklist']);
    const existing = (existingRes.remote_blacklist || []);

    // filter out remote entries that conflict with local (local wins)
    const filteredNew = remoteFromThisSrc.filter(r => !localPatterns.has(r.pattern));

    // remove previous entries from same source (we identify previous by url field matching source)
    const others = existing.filter(e => e.source && e.source !== src);

    // attach source metadata
    const withSource = filteredNew.map(r => ({ ...r, source: src }));

    const merged = others.concat(withSource);
    await saveRemoteRules(merged);
    renderRemote(merged);
    // Notify background to refresh DNR rules immediately
    try { chrome.runtime.sendMessage({ action: 'refreshRules' }); } catch (e) {}
    alert('导入成功，已添加 ' + withSource.length + ' 条远程规则（已排除与本地重复项）');
  } catch (e) {
    console.error(e);
    alert('导入失败：' + e.message);
  }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = '导入远程'; }
  }
}

async function clearRemote() {
  if (!confirm('清空所有远程规则？')) return;
  await saveRemoteRules([]);
  renderRemote([]);
  try { chrome.runtime.sendMessage({ action: 'refreshRules' }); } catch (e) {}
}

// 初始化：统一绑定本地与远程 UI，渲染两侧列表并加载远程抓取设置
async function init() {
  // 本地操作绑定
  const addBtn = document.getElementById('addBtn');
  if (addBtn) addBtn.onclick = addRule;

  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm('清空所有规则？')) return;
    await saveBlacklist([]);
    render([]);
  };

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.onclick = async () => {
    try {
      const res = await chrome.storage.local.get(['blacklist']);
      const list = (res.blacklist || []).map(migrateEntry);
      const out = list.map(item => {
        const clean = (item.pattern || '').replace(/^\|\|/, '').replace(/\^$/, '');
        return { url: clean, info: item.reason || '' };
      });
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'local_rules.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert('导出失败：' + e.message);
    }
  };

  // 本地导入绑定
  const importLocalBtn = document.getElementById('importLocalBtn');
  const localFileInput = document.getElementById('localImportFile');
  if (importLocalBtn && localFileInput) importLocalBtn.onclick = importLocal;

  // 远程操作绑定
  const importBtn = document.getElementById('importRemoteBtn');
  if (importBtn) importBtn.onclick = importRemote;

  const addSubBtn = document.getElementById('addSubscriptionBtn');
  if (addSubBtn) addSubBtn.onclick = addSubscription;

  const clearRemoteBtnEl = document.getElementById('clearRemoteBtn');
  if (clearRemoteBtnEl) clearRemoteBtnEl.onclick = clearRemote;

  // 渲染远程列表
  const remote = await getRemoteRules();
  renderRemote(remote);

  // 渲染本地列表（放在最后以保证 UI 就绪）
  const blacklist = await getBlacklist();
  render(blacklist);

  // 新增：监听 storage 变化，自动刷新（可选但推荐）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.blacklist) {
        const newValue = (changes.blacklist.newValue || []).map(migrateEntry);
        render(newValue);
      }
      if (changes.remote_blacklist) {
        const newRemote = (changes.remote_blacklist.newValue || []).map(migrateEntry);
        renderRemote(newRemote);
      }
    }
  });
}

// 本地导入实现：读取 JSON 文件并合并到本地 blacklist
async function importLocal() {
  const fileInput = document.getElementById('localImportFile');
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    alert('请选择要导入的 JSON 文件');
    return;
  }
  const file = fileInput.files[0];
  const out = document.getElementById('debugOutput');
  try {
    const text = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsText(file, 'utf-8');
    });
    let json = null;
    try { json = JSON.parse(text); } catch (e) {
      alert('JSON 解析失败：' + e.message);
      return;
    }
    if (!Array.isArray(json)) {
      alert('文件必须是 JSON 数组，格式示例：[{"url":"abc.com/path","info":"说明"}, ...]');
      return;
    }

    // Normalize incoming entries into internal format
    const incoming = json.map(item => {
      if (typeof item === 'string') {
        return migrateEntry(item);
      }
      const url = (typeof item.url === 'string') ? item.url : '';
      const info = item.info || item.reason || '';
      let pattern = '';
      try {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          const u = new URL(url);
          pattern = `||${u.hostname}${u.pathname}^`;
        } else {
          pattern = `||${url.replace(/^\/+/, '')}^`;
        }
      } catch (e) {
        pattern = `||${url}^`;
      }
      return { pattern, reason: info, url };
    }).filter(Boolean);

    // Merge into existing blacklist (local wins)
    const current = await getBlacklist();
    const currentPatterns = new Set(current.map(i => i.pattern));
    let added = 0;
    for (const it of incoming) {
      if (!it.pattern) continue;
      if (currentPatterns.has(it.pattern)) continue;
      current.push({ pattern: it.pattern, reason: it.reason });
      currentPatterns.add(it.pattern);
      added++;
    }
    await saveBlacklist(current);
    render(current);
    try { chrome.runtime.sendMessage({ action: 'refreshRules' }); } catch (e) {}
    alert(`导入完成，新增 ${added} 条规则（已排除与本地重复项）`);
    if (out) out.textContent = `已导入 ${added} 条本地规则`;
  } catch (e) {
    console.error(e);
    alert('导入失败：' + (e?.message || String(e)));
  }
}

// ---------- debug helpers (triggered from manage UI) ----------
async function debugTestUrl() {
  const url = document.getElementById('debugUrl').value.trim();
  const out = document.getElementById('debugOutput');
  if (!url) { out.textContent = '请输入要测试的 URL'; return; }
  out.textContent = '测试中...';
  try {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) out.textContent = '未收到后台响应（超时）';
    }, 3000);

    chrome.runtime.sendMessage({ action: 'testMatch', url }, (resp) => {
      done = true; clearTimeout(timer);
      if (chrome.runtime.lastError) {
        out.textContent = '发送消息失败：' + chrome.runtime.lastError.message;
        return;
      }
      if (!resp) { out.textContent = '没有收到后台响应'; return; }
      if (resp.error) {
        out.textContent = '后台错误：' + resp.error;
        return;
      }
      if (!resp.matched) {
        out.textContent = `未命中（local+remote 共 ${resp.totalEntries || 0} 条规则）`;
      } else {
        out.textContent = `命中！\npattern: ${resp.matched.pattern}\nreason: ${resp.matched.reason || ''}\nsource-url: ${resp.matched.url || ''}`;
      }
    });
  } catch (e) { out.textContent = '发送消息失败：' + e.message; }
}

async function debugListRules() {
  const out = document.getElementById('debugOutput');
  out.textContent = '请求后台列出动态规则...';
  try {
    let done = false;
    const timer = setTimeout(() => { if (!done) out.textContent = '未收到后台响应（超时）'; }, 3000);
    chrome.runtime.sendMessage({ action: 'listDynamicRules' }, (resp) => {
      done = true; clearTimeout(timer);
      if (chrome.runtime.lastError) { out.textContent = '发送消息失败：' + chrome.runtime.lastError.message; return; }
      if (!resp) { out.textContent = '没有收到后台响应'; return; }
      if (resp.error) { out.textContent = '后台错误：' + resp.error; return; }
      const arr = resp.rules || [];
      out.textContent = `动态规则数量: ${arr.length}\n` + JSON.stringify(arr.slice(0, 40), null, 2);
    });
  } catch (e) { out.textContent = '发送消息失败：' + e.message; }
}

// Bind debug buttons (also keep DOMContentLoaded fallback)
document.addEventListener('DOMContentLoaded', () => {
  const tbtn = document.getElementById('debugTestBtn');
  if (tbtn) tbtn.addEventListener('click', debugTestUrl);
  const lbtn = document.getElementById('debugListRulesBtn');
  if (lbtn) lbtn.addEventListener('click', debugListRules);
});

// 全局错误处理：在页面上显示简短的错误信息，便于用户报告或调试
function showRuntimeError(err) {
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
    box.innerHTML = `<h2>页面运行错误</h2><div style="white-space:pre-wrap;color:#4b5563">${String(err)}</div><p>请在扩展控制台查看详细错误或将此信息反馈给开发者。</p>`;
    container.appendChild(box);
  } catch (e) {
    // 忽略二次错误
  }
}

window.addEventListener('error', (e) => {
  showRuntimeError(e.message || e.error || '未知错误');
});
window.addEventListener('unhandledrejection', (e) => {
  showRuntimeError(e.reason || '未处理的 Promise 拒绝');
});

init().catch(err => {
  console.error(err);
  showRuntimeError(err?.stack || err?.message || String(err));
});

// Fallback: ensure import button is bound even if init wrapper didn't run yet
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('importRemoteBtn');
  if (btn) btn.addEventListener('click', importRemote);
  const clearBtn = document.getElementById('clearRemoteBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearRemote);
});