const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { listVisibleWindows, matchWindowForItem, focusOrLaunch, autoDiscoverPaths, extractRealIcons } = require('./win32');

// 单实例锁，避免重复启动产生旧窗口残留
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const CONFIG_PATH = path.join(__dirname, 'config.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'config.example.json');
const WINDOW_WIDTH = 440;

let mainWindow = null;
let tray = null;
let config = null;
let iconCache = {};
let statusTimer = null;
let cursorGuardTimer = null;
let apiServer = null;
let watchTimer = null;
let cursorWasInside = false;
let rendererErrors = [];
let lastIconKeys = [];

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_CONFIG_PATH)) {
      fs.copyFileSync(EXAMPLE_CONFIG_PATH, CONFIG_PATH);
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    config = { port: 4791, hotkey: 'Alt+Space', peekMode: true, items: [] };
  }
  return config;
}

function saveConfig(next) {
  config = next;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  broadcastState();
}

async function resolveIconsForItems(items) {
  const result = {};
  const uncached = [];
  for (const item of items) {
    const key = (item.iconPath || '').trim() || (item.target || '').trim();
    if (!key || /^https?:\/\//i.test(key)) continue;
    if (iconCache[key]) {
      result[item.id] = iconCache[key];
      continue;
    }
    // PNG/JPG/WEBP 直接以原始字节读取，100% 无损零失真
    const ext = path.extname(key).toLowerCase();
    if ((ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') && fs.existsSync(key)) {
      try {
        const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
        const url = `data:${mime};base64,${fs.readFileSync(key).toString('base64')}`;
        iconCache[key] = url;
        result[item.id] = url;
        continue;
      } catch {}
    }
    uncached.push(item);
  }

  if (uncached.length > 0) {
    const extracted = await extractRealIcons(uncached);
    for (const item of uncached) {
      const key = (item.iconPath || '').trim() || (item.target || '').trim();
      if (extracted[item.id]) {
        iconCache[key] = extracted[item.id];
        result[item.id] = extracted[item.id];
      }
    }
  }
  return result;
}

async function pollRuntimeStatuses() {
  if (!config || !mainWindow || mainWindow.isDestroyed()) return;
  const windows = await listVisibleWindows();
  const runtime = {};
  for (const item of config.items) {
    const hit = matchWindowForItem(item, windows);
    if (hit) {
      runtime[item.id] = {
        running: true,
        active: Boolean(hit.isForeground),
        windowTitle: hit.title
      };
    } else {
      runtime[item.id] = { running: false, active: false, windowTitle: '' };
    }
  }
  mainWindow.webContents.send('docklet:runtime', runtime);
}

async function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 先立刻下发配置让色卡 0ms 呈现，再异步补齐真实图标
  mainWindow.webContents.send('docklet:config', {
    config,
    icons: Object.fromEntries(
      (config.items || []).map((it) => {
        const key = (it.iconPath || '').trim() || (it.target || '').trim();
        return [it.id, iconCache[key] || null];
      }).filter(([, v]) => Boolean(v))
    ),
    configPath: CONFIG_PATH
  });

  const icons = await resolveIconsForItems(config.items || []);
  lastIconKeys = Object.keys(icons);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('docklet:config', {
    config,
    icons,
    configPath: CONFIG_PATH
  });
}

// 系统级光标守卫：解决双屏跨屏滑过时 Chromium 丢失 mouseleave 导致色卡卡住突出的问题
function startCursorGuard() {
  if (cursorGuardTimer) clearInterval(cursorGuardTimer);
  cursorGuardTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    const b = mainWindow.getBounds();
    // 注意右侧边界用严格小于 (b.x + b.width - 1)，一旦滑过左屏右边缘进入右屏立刻判定离开
    const inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
    if (!inside && cursorWasInside) {
      cursorWasInside = false;
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      mainWindow.webContents.send('docklet:cursor-leave');
    } else if (inside) {
      cursorWasInside = true;
    }
  }, 50);
}

function getWindowRectForDisplay(display) {
  const { x, y, width, height } = display.workArea;
  const winHeight = Math.min(height - 80, 680);
  const winY = y + Math.round((height - winHeight) / 2);
  return { x: x + width - WINDOW_WIDTH, y: winY, width: WINDOW_WIDTH, height: winHeight };
}

function createWindow() {
  const rect = getWindowRectForDisplay(screen.getPrimaryDisplay());

  mainWindow = new BrowserWindow({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    frame: false,
    thickFrame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) rendererErrors.push(String(msg));
  });

  mainWindow.webContents.on('did-finish-load', async () => {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    await broadcastState();
    await pollRuntimeStatuses();
    startCursorGuard();
  });

  screen.on('display-metrics-changed', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setBounds(getWindowRectForDisplay(screen.getPrimaryDisplay()));
  });
}

function createTray() {
  const icoPath = path.join(__dirname, 'docklet.ico');
  const icon = fs.existsSync(icoPath)
    ? nativeImage.createFromPath(icoPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Docklet AI 右侧色卡轨');

  const menu = Menu.buildFromTemplate([
    { label: '切换贴边半隐藏 (Alt+Space)', click: () => togglePeekMode() },
    { label: '打开配置抽屉', click: () => mainWindow?.webContents.send('docklet:open-drawer') },
    { type: 'separator' },
    { label: '退出 Docklet', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
}

function togglePeekMode() {
  config.peekMode = !config.peekMode;
  saveConfig(config);
}

function startLocalApi() {
  const port = config.port || 4791;
  apiServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      if (body) {
        try { json = JSON.parse(body); } catch { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, count: (config.items || []).length }));
      }
      if (req.method === 'GET' && url.pathname === '/debug') {
        res.writeHead(200);
        return res.end(JSON.stringify({
          visible: mainWindow ? mainWindow.isVisible() : false,
          bounds: mainWindow ? mainWindow.getBounds() : null,
          displays: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, primary: d.id === screen.getPrimaryDisplay().id })),
          iconKeys: lastIconKeys,
          peekMode: config.peekMode,
          rendererErrors
        }));
      }
      if (req.method === 'GET' && url.pathname === '/snapshot') {
        (async () => {
          try {
            const domInfo = await mainWindow.webContents.executeJavaScript(`(() => {
              const tabs = Array.from(document.querySelectorAll('.edge-tab')).map(t => {
                const r = t.getBoundingClientRect();
                const spine = t.querySelector('.color-spine');
                const img = t.querySelector('img');
                return {
                  id: t.dataset.id,
                  run: t.dataset.run,
                  rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                  spineBg: spine ? getComputedStyle(spine).backgroundColor : null,
                  imgLoaded: img ? (img.complete && img.naturalWidth > 0) : false
                };
              });
              return { innerW: window.innerWidth, innerH: window.innerHeight, tabCount: tabs.length, tabs };
            })()`);
            const png = await mainWindow.webContents.capturePage();
            const outPath = path.join(__dirname, 'self-test.png');
            fs.writeFileSync(outPath, png.toPNG());
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, outPath, domInfo }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        })();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/items') {
        res.writeHead(200);
        return res.end(JSON.stringify({ items: config.items || [] }));
      }
      if (req.method === 'POST' && url.pathname === '/items') {
        if (!json.name) { res.writeHead(400); return res.end(JSON.stringify({ error: 'name is required' })); }
        const id = json.id || json.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const nextItem = {
          id,
          name: json.name,
          target: json.target || '',
          iconPath: json.iconPath || json.target || '',
          processHints: json.processHints || [id],
          color: json.color || 'auto',
          iconKey: json.iconKey || 'custom',
          aiStatus: json.aiStatus || null,
          statusText: json.statusText || null
        };
        const idx = config.items.findIndex((i) => i.id === id);
        if (idx >= 0) config.items[idx] = { ...config.items[idx], ...nextItem };
        else config.items.push(nextItem);
        saveConfig(config);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, item: nextItem }));
      }

      const statusMatch = url.pathname.match(/^\/items\/([^/]+)\/status$/);
      if (req.method === 'PUT' && statusMatch) {
        const id = decodeURIComponent(statusMatch[1]);
        const target = config.items.find((i) => i.id === id);
        if (!target) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Not found' })); }
        target.aiStatus = json.aiStatus ?? null;
        target.statusText = json.statusText ?? null;
        saveConfig(config);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, item: target }));
      }

      const delMatch = url.pathname.match(/^\/items\/([^/]+)$/);
      if (req.method === 'DELETE' && delMatch) {
        const id = decodeURIComponent(delMatch[1]);
        config.items = config.items.filter((i) => i.id !== id);
        saveConfig(config);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true }));
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Route not found' }));
    });
  });

  apiServer.on('error', () => {});
  apiServer.listen(port, '127.0.0.1');
}

function watchConfigFile() {
  try {
    fs.watch(CONFIG_PATH, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        loadConfig();
        broadcastState();
      }, 150);
    });
  } catch {}
}

ipcMain.on('docklet:mouse-ignore', (_e, ignore) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  }
});

ipcMain.on('docklet:show-context-menu', () => {
  const menu = Menu.buildFromTemplate([
    { label: config.peekMode ? '关闭贴边半隐藏' : '开启贴边半隐藏', click: () => togglePeekMode() },
    { label: '打开色卡配置', click: () => mainWindow?.webContents.send('docklet:open-drawer') },
    { type: 'separator' },
    { label: '退出 Docklet', click: () => app.quit() }
  ]);
  menu.popup({ window: mainWindow });
});

ipcMain.handle('docklet:activate', async (_e, id) => {
  const item = (config.items || []).find((i) => i.id === id);
  if (!item) return { action: 'not_found' };
  const res = await focusOrLaunch(item);
  setTimeout(pollRuntimeStatuses, 450);
  return res;
});

ipcMain.handle('docklet:toggle-peek', () => {
  togglePeekMode();
  return config.peekMode;
});

ipcMain.handle('docklet:save-items', (_e, items) => {
  config.items = items;
  saveConfig(config);
  return true;
});

ipcMain.handle('docklet:auto-discover', async () => {
  const found = await autoDiscoverPaths(config.items || []);
  let count = 0;
  config.items = config.items.map((it) => {
    if (found[it.id]) {
      count++;
      return { ...it, target: found[it.id], iconPath: found[it.id] };
    }
    return it;
  });
  if (count > 0) saveConfig(config);
  return { count, found };
});

ipcMain.handle('docklet:pick-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择软件程序或快捷方式',
    properties: ['openFile'],
    filters: [{ name: '应用程序与快捷方式', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('docklet:quit', () => app.quit());

app.whenReady().then(() => {
  loadConfig();
  createWindow();
  createTray();
  startLocalApi();
  watchConfigFile();

  globalShortcut.register(config.hotkey || 'Alt+Space', () => {
    togglePeekMode();
  });

  statusTimer = setInterval(pollRuntimeStatuses, 2000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (statusTimer) clearInterval(statusTimer);
  if (cursorGuardTimer) clearInterval(cursorGuardTimer);
  if (apiServer) apiServer.close();
});
