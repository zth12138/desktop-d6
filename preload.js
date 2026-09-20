const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('d6', {
  randomizeDesktop: () => ipcRenderer.invoke('randomize-desktop'),
  restoreDesktop: () => ipcRenderer.invoke('restore-desktop'),
  getDisplayMode: () => ipcRenderer.invoke('get-display-mode'),
  onDisplayModeChanged: callback => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('display-mode-changed', listener);
    return () => ipcRenderer.removeListener('display-mode-changed', listener);
  },
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  moveWindow: (x, y) => ipcRenderer.send('move-window', x, y),
  showMenu: () => ipcRenderer.send('show-menu')
});
