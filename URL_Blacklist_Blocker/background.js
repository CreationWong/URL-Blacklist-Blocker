// 哈希函数：确保每个 pattern 对应唯一 ID（1~999,999,999）
function hashPattern(pattern) {
  let hash = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 转为 32 位整数
  }
  return Math.abs(hash) % 999999999 + 1;
}

function migrateEntry(entry) {
  if (typeof entry === 'string') return { pattern: entry, reason: '' };
  return { pattern: entry?.pattern || '', reason: entry?.reason || '' };
}

// Escape string to be used inside a regex literal
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isBlocked(url, entries) {
  try {
    const urlObj = new URL(url);
    const hostPath = `${urlObj.hostname}${urlObj.pathname}`;
    for (const entry of entries) {
      if (!entry.pattern) continue;
      const clean = entry.pattern.replace(/^\|\|/, '').replace(/\^$/, '');
      if (hostPath.startsWith(clean) || url.includes(clean)) {
        return entry;
      }
    }
  } catch (e) {}
  return null;
}

async function updateRules(entries) {
  // If entries not provided, read both local and remote blacklists from storage
  if (!entries) {
    const res = await chrome.storage.local.get(['blacklist', 'remote_blacklist']);
    const local = (res.blacklist || []).map(migrateEntry);
    const remote = (res.remote_blacklist || []).map(migrateEntry);
    entries = local.concat(remote);
  }
  console.log('updateRules: total entries to consider =', (entries || []).length);
  // Build rules while ensuring each rule ID is unique and stable across updates.
  // We'll keep a mapping pattern -> id in storage (`pattern_id_map`) so that the same
  // pattern always maps to the same id. If a collision occurs we'll pick the next
  // available id deterministically.
  const idMapRes = await chrome.storage.local.get(['pattern_id_map']);
  const idMap = idMapRes.pattern_id_map || {};

  // Gather currently used ids from existing dynamic rules and from idMap
  const existingDynamic = await chrome.declarativeNetRequest.getDynamicRules();
  const usedIds = new Set(existingDynamic.map(r => r.id));
  Object.values(idMap || {}).forEach(v => usedIds.add(v));

  const rules = [];
  const currentPatterns = new Set();

  for (const entry of entries) {
    if (!entry || !entry.pattern) continue;
    const pattern = entry.pattern;
    currentPatterns.add(pattern);

    // Normalize pattern to a DNR-friendly urlFilter (strip adblock-like markers)
    const clean = pattern.replace(/^\|\|/, '').replace(/\^$/, '');

    // Try to split into host + path for better matching
    let urlFilter = clean;
    const firstSlash = clean.indexOf('/');
    let domains = undefined;
    if (firstSlash > 0) {
      const host = clean.substring(0, firstSlash);
      const path = clean.substring(firstSlash); // includes '/'
      if (host && host.includes('.')) {
        domains = [host];
        urlFilter = path || host;
      }
    }

    // Determine a stable unique id for this pattern
    let id = idMap[pattern];
    if (!id) {
      id = hashPattern(pattern);
      // If collision, step forward deterministically until free
      const MAX_ID = 999999999;
      while (usedIds.has(id)) {
        id = id % MAX_ID + 1; // wrap-around
      }
      idMap[pattern] = id;
      usedIds.add(id);
    } else {
      // ensure id is recorded in usedIds to avoid duplicates in this run
      usedIds.add(id);
    }

    // Build condition: prefer a regexFilter matching full URL when host+path available,
    // fallback to urlFilter substring otherwise.
    let condition;
    try {
      if (domains && domains.length > 0) {
        const host = domains[0];
        // Ensure path portion begins with '/'
        let pathPart = urlFilter && urlFilter.startsWith('/') ? urlFilter : (urlFilter ? '/' + urlFilter : '');
        // Construct a regex matching http(s) with optional subdomains for the host and the path
        const regex = '^https?:\\/\\/(?:[^/]+\\.)?' + escapeRegex(host) + (pathPart ? escapeRegex(pathPart) + '.*' : '.*');
        condition = { regexFilter: regex, resourceTypes: ['main_frame'] };
      } else {
        condition = { urlFilter, resourceTypes: ['main_frame'] };
      }
    } catch (e) {
      // fallback to simple substring if anything goes wrong
      condition = { urlFilter, resourceTypes: ['main_frame'] };
    }

    rules.push({ id, priority: 1, action: { type: 'redirect', redirect: { url: chrome.runtime.getURL('blocked.html') } }, condition });
  }

  // Persist any new id mappings so future updates are stable
  try {
    await chrome.storage.local.set({ pattern_id_map: idMap });
  } catch (e) {
    console.warn('updateRules: failed to persist pattern_id_map', e);
  }

  console.log('updateRules: built rules count =', rules.length);
  if (rules.length > 0) console.log('updateRules: sample rule', rules[0]);

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const existingIds = new Set(existing.map(r => r.id));
  const newIds = new Set(rules.map(r => r.id));

  // Build index of existing rules by id for comparison
  const existingById = {};
  for (const r of existing) existingById[r.id] = r;

  const toRemoveSet = new Set();
  const toAdd = [];

  for (const rule of rules) {
    const ex = existingById[rule.id];
    if (!ex) {
      // new id -> add
      toAdd.push(rule);
    } else {
      // exists: compare condition and action; if different, replace
      try {
        const a = JSON.stringify(ex.condition || {});
        const b = JSON.stringify(rule.condition || {});
        const aa = JSON.stringify(ex.action || {});
        const bb = JSON.stringify(rule.action || {});
        if (a !== b || aa !== bb) {
          toRemoveSet.add(rule.id);
          toAdd.push(rule);
        }
      } catch (e) {
        // fallback: if comparison fails, replace conservatively
        toRemoveSet.add(rule.id);
        toAdd.push(rule);
      }
    }
  }

  // remove rules that are not present in new set
  for (const id of existingIds) {
    if (!newIds.has(id)) toRemoveSet.add(id);
  }

  const toRemove = Array.from(toRemoveSet);

  if (toRemove.length > 0 || toAdd.length > 0) {
    console.log('updateRules: removing', toRemove.length, 'rules; adding', toAdd.length, 'rules');
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: toRemove,
        addRules: toAdd
      });
      console.log('updateRules: updateDynamicRules completed');

      // log current dynamic rules for verification
      try {
        const current = await chrome.declarativeNetRequest.getDynamicRules();
        console.log('updateRules: dynamic rules now count =', current.length);
        if (current.length <= 20) console.log('updateRules: dynamic rules sample', current);
        else console.log('updateRules: dynamic rules sample', current.slice(0, 20));
      } catch (e) {
        console.error('updateRules: failed to list dynamic rules', e);
      }

    } catch (e) {
      console.error('updateRules: updateDynamicRules failed', e);
    }
  } else {
    console.log('updateRules: no changes required');
  }
}

// 捕获被拦截的页面，记录原始信息
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (
    tab.url &&
    changeInfo.status === 'loading' &&
    !['chrome://', 'edge://', 'about:', 'extension://', 'chrome-extension://'].some(p => tab.url.startsWith(p))
  ) {
  const res = await chrome.storage.local.get(['blacklist', 'remote_blacklist']);
  const local = (res.blacklist || []).map(migrateEntry);
  const remote = (res.remote_blacklist || []).map(migrateEntry);
  const entries = local.concat(remote);
    const matched = isBlocked(tab.url, entries);

    if (matched) {
      await chrome.storage.local.set({
        [`blocked_info_${tabId}`]: {
          originalUrl: tab.url,
          reason: matched.reason || '',
          pattern: matched.pattern || ''
        }
      });
    }
  }
});

// 更早期的导航监听：在导航开始时记录信息，补强 tabs.onUpdated 的时序问题
if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    try {
      // 仅处理主框架导航
      if (details.frameId !== 0) return;
      const tabId = details.tabId;
      if (typeof tabId !== 'number' || tabId < 0) return;
      const url = details.url;
      if (!url) return;
      if (['chrome://', 'edge://', 'about:', 'extension://', 'chrome-extension://'].some(p => url.startsWith(p))) return;

  const res = await chrome.storage.local.get(['blacklist', 'remote_blacklist']);
  const local = (res.blacklist || []).map(migrateEntry);
  const remote = (res.remote_blacklist || []).map(migrateEntry);
  const entries = local.concat(remote);
      const matched = isBlocked(url, entries);
      if (matched) {
        // 写入 blocked_info，便于 blocked.html 读取（覆盖旧值也没问题）
        await chrome.storage.local.set({
          [`blocked_info_${tabId}`]: {
            originalUrl: url,
            reason: matched.reason || '',
            pattern: matched.pattern || ''
          }
        });
      }
    } catch (e) {
      // swallow errors to avoid breaking navigation
      console.error('webNavigation.onBeforeNavigate handler error', e);
    }
  });
}

// 临时放行
let rulesDisabled = false;
let restoreTimeout = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 支持：blocked 页面请求当前 tab 的 blocked_info
  if (msg.action === 'getBlockedInfo') {
    // sender.tab may be undefined when message comes from an extension page
    const resolveForTab = async () => {
      let tabId = sender?.tab?.id;
      if (tabId == null) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tabs && tabs[0] && tabs[0].id;
      }
      if (tabId == null) return sendResponse({ info: null });
      const key = `blocked_info_${tabId}`;
      chrome.storage.local.get(key).then(data => {
        sendResponse({ info: data[key] || null });
      }).catch(() => sendResponse({ info: null }));
    };
    resolveForTab();
    return true;
  }

  if (msg.action === 'triggerFetchRemote') {
    // manual trigger to fetch remote sources now
    fetchRemoteSources().then(() => sendResponse({ triggered: true })).catch(() => sendResponse({ triggered: false }));
    return true;
  }

  if (msg.action === 'ping') {
    // simple liveness check
    try { sendResponse({ pong: true }); } catch (e) {}
    return false;
  }

  if (msg.action === 'refreshRules') {
    // request to immediately refresh dynamic rules from storage
    updateRules().then(() => sendResponse({ refreshed: true })).catch((e) => {
      console.error('refreshRules failed', e);
      sendResponse({ refreshed: false });
    });
    return true;
  }

  if (msg.action === 'testMatch') {
    // Test whether a URL would be matched by current local+remote rules
    (async () => {
      try {
        const res = await chrome.storage.local.get(['blacklist','remote_blacklist']);
        const local = (res.blacklist || []).map(migrateEntry);
        const remote = (res.remote_blacklist || []).map(migrateEntry);
        const entries = local.concat(remote);
        const matched = isBlocked(msg.url, entries);
        sendResponse({ matched: matched || null, totalEntries: entries.length });
      } catch (e) {
        console.error('testMatch failed', e);
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === 'listDynamicRules') {
    (async () => {
      try {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        sendResponse({ rules });
      } catch (e) {
        console.error('listDynamicRules failed', e);
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === 'tempAllow') {
    // Support messages from extension page where sender.tab may be undefined by falling back to active tab
    const resolveForTab = async () => {
      let tabId = sender?.tab?.id;
      if (tabId == null) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tabs && tabs[0] && tabs[0].id;
      }
      if (tabId == null) return sendResponse({ success: false });
      const key = `blocked_info_${tabId}`;

      chrome.storage.local.get(key).then(async (data) => {
        const info = data[key];
        chrome.storage.local.remove(key);

      if (!rulesDisabled) {
        const existing = await chrome.declarativeNetRequest.getDynamicRules();
        if (existing.length > 0) {
          const ids = existing.map(r => r.id);
          await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
          rulesDisabled = true;

          clearTimeout(restoreTimeout);
          restoreTimeout = setTimeout(async () => {
            const res = await chrome.storage.local.get(['blacklist']);
            await updateRules((res.blacklist || []).map(migrateEntry));
            rulesDisabled = false;
          }, 5000);
        }
      }

        sendResponse({ success: true, originalUrl: info?.originalUrl || '' });
      }).catch(() => sendResponse({ success: false }));
    };
    resolveForTab();
    return true;
  }
});

// 安装时初始化
chrome.runtime.onInstalled.addListener(async () => {
  const res = await chrome.storage.local.get(['blacklist']);
  let blacklist = res.blacklist || [];
  const migrated = blacklist.map(migrateEntry);
  const hasOld = blacklist.some(e => typeof e === 'string');
  if (hasOld) {
    await chrome.storage.local.set({ blacklist: migrated });
    blacklist = migrated;
  }
  if (blacklist.length === 0) {
    blacklist = [{ pattern: '||0d000721.com^', reason: '测试：当你看见这个时说明安装成功' }];
    await chrome.storage.local.set({ blacklist });
  }
  await updateRules();
});

// 监听黑名单变更
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && !rulesDisabled && (changes.blacklist || changes.remote_blacklist)) {
    // re-read both lists and update rules
    await updateRules();
  }
});

// Fetch remote sources: re-download each unique source and update remote_blacklist
async function fetchRemoteSources() {
  try {
    const res = await chrome.storage.local.get(['remote_blacklist','blacklist']);
    const existingRemote = res.remote_blacklist || [];
    const local = (res.blacklist || []).map(migrateEntry);
    const localPatterns = new Set(local.map(i => i.pattern));

  // determine unique sources: include explicit remote_sources subscriptions as well
  const prev = await chrome.storage.local.get(['remote_sources']);
  const subscribed = Object.keys(prev.remote_sources || {});
  const sources = Array.from(new Set(existingRemote.map(r => r.source).filter(Boolean).concat(subscribed)));
    let updatedRemote = existingRemote.filter(r => !r.source); // keep entries without source

    const remoteSourcesInfo = {};
    for (const src of sources) {
      try {
        const resp = await fetch(src, { cache: 'no-store' });
        if (!resp.ok) {
          console.warn('Failed to fetch remote source', src, resp.status);
          continue;
        }
        const json = await resp.json();
        if (!Array.isArray(json)) {
          console.warn('Remote source not array', src);
          continue;
        }
        const parsed = json.map(item => {
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
          return { pattern, reason: info, url, source: src };
        }).filter(p => !localPatterns.has(p.pattern));

        // remove old entries from this source
        updatedRemote = updatedRemote.filter(r => r.source !== src);
        updatedRemote = updatedRemote.concat(parsed);
        // record metadata for this source
        remoteSourcesInfo[src] = { lastUpdated: Date.now(), count: parsed.length };
      } catch (e) {
        console.error('Error fetching remote source', src, e);
      }
    }

    // persist updated remote blacklist and per-source metadata
    try {
      const prev = await chrome.storage.local.get(['remote_sources']);
      const mergedSources = Object.assign({}, prev.remote_sources || {}, remoteSourcesInfo);
      await chrome.storage.local.set({ remote_blacklist: updatedRemote, remote_sources: mergedSources });
      console.log('Remote sources fetched, total remote rules:', (updatedRemote || []).length);
    } catch (e) {
      console.error('fetchRemoteSources: failed to persist remote results', e);
    }
  } catch (e) {
    console.error('fetchRemoteSources error', e);
  }
}

// Alarm handling: schedule periodic remote fetch
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Use a single async wrapper so we ALWAYS return true and ensure sendResponse is called
  (async () => {
    try {
      if (msg.action === 'getBlockedInfo') {
        // sender.tab may be undefined when message comes from an extension page
        let tabId = sender?.tab?.id;
        if (tabId == null) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tabs && tabs[0] && tabs[0].id;
        }
        if (tabId == null) return sendResponse({ info: null });
        const key = `blocked_info_${tabId}`;
        const data = await chrome.storage.local.get(key);
        return sendResponse({ info: data[key] || null });
      }

      if (msg.action === 'triggerFetchRemote') {
        try {
          await fetchRemoteSources();
          return sendResponse({ triggered: true });
        } catch (e) {
          return sendResponse({ triggered: false });
        }
      }

      if (msg.action === 'refreshRules') {
        try {
          await updateRules();
          return sendResponse({ refreshed: true });
        } catch (e) {
          console.error('refreshRules failed', e);
          return sendResponse({ refreshed: false });
        }
      }

      if (msg.action === 'testMatch') {
        try {
          const res = await chrome.storage.local.get(['blacklist','remote_blacklist']);
          const local = (res.blacklist || []).map(migrateEntry);
          const remote = (res.remote_blacklist || []).map(migrateEntry);
          const entries = local.concat(remote);
          const matched = isBlocked(msg.url, entries);
          return sendResponse({ matched: matched || null, totalEntries: entries.length });
        } catch (e) {
          console.error('testMatch failed', e);
          return sendResponse({ error: String(e) });
        }
      }

      if (msg.action === 'listDynamicRules') {
        try {
          const rules = await chrome.declarativeNetRequest.getDynamicRules();
          return sendResponse({ rules });
        } catch (e) {
          console.error('listDynamicRules failed', e);
          return sendResponse({ error: String(e) });
        }
      }

      if (msg.action === 'tempAllow') {
        try {
          let tabId = sender?.tab?.id;
          if (tabId == null) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tabs && tabs[0] && tabs[0].id;
          }
          if (tabId == null) return sendResponse({ success: false });
          const key = `blocked_info_${tabId}`;
          const data = await chrome.storage.local.get(key);
          const info = data[key];
          await chrome.storage.local.remove(key);

          if (!rulesDisabled) {
            const existing = await chrome.declarativeNetRequest.getDynamicRules();
            if (existing.length > 0) {
              const ids = existing.map(r => r.id);
              await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
              rulesDisabled = true;

              clearTimeout(restoreTimeout);
              restoreTimeout = setTimeout(async () => {
                const res = await chrome.storage.local.get(['blacklist']);
                await updateRules((res.blacklist || []).map(migrateEntry));
                rulesDisabled = false;
              }, 5000);
            }
          }

          return sendResponse({ success: true, originalUrl: info?.originalUrl || '' });
        } catch (e) {
          console.error('tempAllow failed', e);
          return sendResponse({ success: false });
        }
      }

      if (msg.action === 'ping') {
        return sendResponse({ pong: true });
      }

      // unknown action
      return sendResponse({ error: 'unknown action' });
    } catch (e) {
      console.error('onMessage handler exception', e);
      try { sendResponse({ error: String(e) }); } catch (e2) {}
    }
  })();
  // Keep the message channel open for async response
  return true;
});

// Alarm handling: schedule periodic remote fetch
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm && alarm.name === 'fetch-remote-rules') {
    await fetchRemoteSources();
  }
});

// Adjust alarm when settings change (use minutes unit)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.remote_fetch_enabled || changes.remote_fetch_interval_minutes)) {
    (async () => {
      const s = await chrome.storage.local.get(['remote_fetch_enabled','remote_fetch_interval_minutes']);
      const enabled = s.remote_fetch_enabled;
      const minutes = Number(s.remote_fetch_interval_minutes) || 720;
      // clear existing alarm
      chrome.alarms.clear('fetch-remote-rules');
      if (enabled) {
        chrome.alarms.create('fetch-remote-rules', { periodInMinutes: Math.max(1, minutes) });
      }
    })();
  }
});

// On startup, ensure alarm respects stored settings
chrome.runtime.onStartup.addListener(async () => {
  const s = await chrome.storage.local.get(['remote_fetch_enabled','remote_fetch_interval_minutes']);
  const enabled = s.remote_fetch_enabled;
  const minutes = Number(s.remote_fetch_interval_minutes) || 720;
  chrome.alarms.clear('fetch-remote-rules');
  if (enabled) chrome.alarms.create('fetch-remote-rules', { periodInMinutes: Math.max(1, minutes) });
});