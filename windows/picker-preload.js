// The screen picker's only link to the app: fetch the list, send back the choice.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  sources: () => ipcRenderer.invoke('picker:sources'),
  choose: (id, sound) => ipcRenderer.send('picker:choose', id, sound)
});
