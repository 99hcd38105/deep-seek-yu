const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopPet', {
  getState: () => ipcRenderer.invoke('desktop-pet:get-state'),
  setCollapsed: (value) => ipcRenderer.invoke('desktop-pet:set-collapsed', value),
  feed: () => ipcRenderer.invoke('desktop-pet:feed'),
  play: () => ipcRenderer.invoke('desktop-pet:play'),
  dragStart: (point) => ipcRenderer.invoke('desktop-pet:drag-start', point),
  dragMove: (point) => ipcRenderer.invoke('desktop-pet:drag-move', point),
  dragEnd: () => ipcRenderer.invoke('desktop-pet:drag-end'),
  eatDroppedFiles: (files) => ipcRenderer.invoke('desktop-pet:eat-dropped-files', Array.from(files || []).map((file) => webUtils.getPathForFile(file)).filter(Boolean)),
  sendMessage: (message) => ipcRenderer.invoke('desktop-pet:send-message', message),
  chooseImage: (question) => ipcRenderer.invoke('desktop-pet:choose-image', question),
  openSettings: () => ipcRenderer.invoke('desktop-pet:open-settings'),
  hide: () => ipcRenderer.invoke('desktop-pet:hide'),
  showMainWindow: () => ipcRenderer.invoke('desktop-pet:show-main-window'),
  getSettings: () => ipcRenderer.invoke('desktop-pet:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('desktop-pet:save-settings', settings),
  prepareVision: () => ipcRenderer.invoke('desktop-pet:prepare-vision'),
  openModelDirectory: () => ipcRenderer.invoke('desktop-pet:open-model-directory'),
  openPetDirectory: () => ipcRenderer.invoke('desktop-pet:open-directory'),
  refreshCharacters: () => ipcRenderer.invoke('desktop-pet:refresh-characters'),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('desktop-pet:state', handler);
    return () => ipcRenderer.removeListener('desktop-pet:state', handler);
  },
  onVisionState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('desktop-pet:vision-state', handler);
    return () => ipcRenderer.removeListener('desktop-pet:vision-state', handler);
  },
});
