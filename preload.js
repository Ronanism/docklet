const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('docklet', {
  setMouseIgnore: (ignore) => ipcRenderer.send('docklet:mouse-ignore', ignore),
  showContextMenu: () => ipcRenderer.send('docklet:show-context-menu'),
  activateItem: (id) => ipcRenderer.invoke('docklet:activate', id),
  togglePeek: () => ipcRenderer.invoke('docklet:toggle-peek'),
  saveItems: (items) => ipcRenderer.invoke('docklet:save-items', items),
  autoDiscover: () => ipcRenderer.invoke('docklet:auto-discover'),
  pickFile: () => ipcRenderer.invoke('docklet:pick-file'),
  quit: () => ipcRenderer.invoke('docklet:quit'),
  onConfig: (cb) => ipcRenderer.on('docklet:config', (_e, data) => cb(data)),
  onRuntime: (cb) => ipcRenderer.on('docklet:runtime', (_e, data) => cb(data)),
  onCursorLeave: (cb) => ipcRenderer.on('docklet:cursor-leave', () => cb()),
  onOpenDrawer: (cb) => ipcRenderer.on('docklet:open-drawer', () => cb())
});
