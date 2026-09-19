const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('d6', {
  randomizeDesktop: () => ipcRenderer.invoke('randomize-desktop'),
  restoreDesktop: () => ipcRenderer.invoke('restore-desktop'),
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  moveWindow: (x, y) => ipcRenderer.send('move-window', x, y),
  showMenu: () => ipcRenderer.send('show-menu')
});
