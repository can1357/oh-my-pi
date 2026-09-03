// extension/background.ts
var DEFAULT_PORT = 9224;
var PING_INTERVAL_MS = 20000;
var RECONNECT_MIN_MS = 1000;
var RECONNECT_MAX_MS = 1e4;
var ws = null;
var reconnectDelay = RECONNECT_MIN_MS;
var pingTimer = null;
var relayInitiatedDetachTabs = new Set;
async function loadSettings() {
  const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: "" });
  const port = Number(stored.port);
  return {
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
    token: typeof stored.token === "string" ? stored.token : ""
  };
}
function snapshot(tab) {
  if (tab.id === undefined)
    return null;
  return {
    tabId: tab.id,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    active: tab.active,
    windowId: tab.windowId,
    pinned: tab.pinned,
    groupId: tab.groupId
  };
}
var ompGroupTitle = null;
var groupOps = Promise.resolve();
function enqueueGroupOp(fn) {
  const result = groupOps.then(fn, fn);
  groupOps = result.catch(() => {});
  return result;
}
async function groupTabs(tabIds, title, color) {
  ompGroupTitle = title;
  chrome.storage.session.set({ ompGroupTitle: title });
  const byWindow = new Map;
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.pinned || tab.id === undefined)
        continue;
      const bucket = byWindow.get(tab.windowId) ?? [];
      bucket.push(tab.id);
      byWindow.set(tab.windowId, bucket);
    } catch {}
  }
  const grouped = {};
  for (const [windowId, ids] of byWindow) {
    const existing = await chrome.tabGroups.query({ title, windowId });
    let groupId;
    if (existing[0]) {
      groupId = existing[0].id;
      for (const dupe of existing.slice(1)) {
        const dupeTabs = await chrome.tabs.query({ groupId: dupe.id });
        const dupeIds = dupeTabs.map((tab) => tab.id).filter((id) => id !== undefined);
        if (dupeIds.length > 0)
          await chrome.tabs.group({ tabIds: dupeIds, groupId });
      }
      await chrome.tabs.group({ tabIds: ids, groupId });
    } else {
      groupId = await chrome.tabs.group({ tabIds: ids });
    }
    await chrome.tabGroups.update(groupId, { title, color });
    for (const id of ids)
      grouped[String(id)] = groupId;
  }
  return { grouped };
}
async function restoreGroups() {
  if (!ompGroupTitle) {
    const stored = await chrome.storage.session.get({ ompGroupTitle: "" }).catch(() => ({ ompGroupTitle: "" }));
    ompGroupTitle = typeof stored.ompGroupTitle === "string" && stored.ompGroupTitle ? stored.ompGroupTitle : null;
  }
  if (!ompGroupTitle)
    return;
  const groups = await chrome.tabGroups.query({ title: ompGroupTitle }).catch(() => []);
  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
    const ids = tabs.map((tab) => tab.id).filter((id) => id !== undefined);
    if (ids.length > 0)
      await chrome.tabs.ungroup(ids).catch(() => {});
  }
}
function post(msg) {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg));
}
async function setBadge(connected) {
  try {
    await chrome.action.setBadgeText({ text: connected ? "on" : "off" });
    await chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a7f37" : "#8b8b8b" });
  } catch {}
}
async function buildHello() {
  const [tabs, targets] = await Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()]);
  const snapshots = [];
  for (const tab of tabs) {
    const snap = snapshot(tab);
    if (snap)
      snapshots.push(snap);
  }
  const attachedTabIds = [];
  for (const target of targets) {
    if (target.attached && target.tabId !== undefined)
      attachedTabIds.push(target.tabId);
  }
  const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
  return {
    t: "hello",
    userAgent: navigator.userAgent,
    browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
    tabs: snapshots,
    attachedTabIds
  };
}
async function runRpc(msg) {
  switch (msg.op) {
    case "attach":
      await chrome.debugger.attach({ tabId: msg.tabId }, "1.3");
      return {};
    case "detach":
      relayInitiatedDetachTabs.add(msg.tabId);
      try {
        await chrome.debugger.detach({ tabId: msg.tabId });
        return {};
      } catch (error) {
        relayInitiatedDetachTabs.delete(msg.tabId);
        throw error;
      }
    case "send":
      return await chrome.debugger.sendCommand(msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId }, msg.method, msg.params);
    case "createTab": {
      const tab = await chrome.tabs.create({ url: msg.url });
      const snap = snapshot(tab);
      if (!snap)
        throw new Error("created tab has no id");
      return { tab: snap };
    }
    case "removeTab":
      await chrome.tabs.remove(msg.tabId);
      return {};
    case "activateTab": {
      const tab = await chrome.tabs.get(msg.tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(msg.tabId, { active: true });
      return {};
    }
    case "group":
      return await enqueueGroupOp(() => groupTabs(msg.tabIds, msg.title, msg.color));
    case "ungroup":
      await enqueueGroupOp(() => chrome.tabs.ungroup(msg.tabIds).catch(() => {}));
      return {};
  }
}
function handleRelayMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.t === "pong")
    return;
  runRpc(msg).then((result) => post({ t: "rpcResult", id: msg.id, ok: true, result })).catch((err) => {
    post({ t: "rpcResult", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  });
}
function scheduleReconnect() {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  setTimeout(() => void connect(), delay);
}
async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
    return;
  const settings = await loadSettings();
  const url = `ws://127.0.0.1:${settings.port}/ext${settings.token ? `?token=${encodeURIComponent(settings.token)}` : ""}`;
  const socket = new WebSocket(url);
  ws = socket;
  socket.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    setBadge(true);
    buildHello().then((hello) => post(hello));
    clearInterval(pingTimer ?? undefined);
    pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
  };
  socket.onmessage = (event) => {
    if (typeof event.data === "string")
      handleRelayMessage(event.data);
  };
  socket.onclose = () => {
    if (ws !== socket)
      return;
    ws = null;
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    setBadge(false);
    restoreGroups();
    scheduleReconnect();
  };
  socket.onerror = () => {
    socket.close();
  };
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined)
    return;
  post({ t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined)
    return;
  const relayInitiated = relayInitiatedDetachTabs.delete(source.tabId);
  post({ t: "detached", tabId: source.tabId, reason, relayInitiated });
});
chrome.tabs.onCreated.addListener((tab) => {
  const snap = snapshot(tab);
  if (snap)
    post({ t: "tabCreated", tab: snap });
});
chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
  const snap = snapshot(tab);
  if (snap)
    post({ t: "tabUpdated", tab: snap });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  post({ t: "tabRemoved", tabId });
});
chrome.alarms.create("omp-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "omp-relay-keepalive")
    connect();
});
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== "local")
    return;
  ws?.close();
  connect();
});
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
connect();
