const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('extensionsApi', {
  versions: () => ipcRenderer.invoke('extensions:versions'),
  registry: () => ipcRenderer.invoke('extensions:registry'),
  installRuntime: (version) => ipcRenderer.invoke('extensions:install-runtime', version),
  installPlugin: (plugin) => ipcRenderer.invoke('extensions:install-plugin', plugin),
  openSource: (url) => ipcRenderer.invoke('extensions:open-source', url),
  onProgress: (listener) => ipcRenderer.on('extensions:progress', (_event, value) => listener(value)),
});
