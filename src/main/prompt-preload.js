const { contextBridge, ipcRenderer } = require('electron');

function onPromptData(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('prompt-data', listener);

    return () => {
        ipcRenderer.removeListener('prompt-data', listener);
    };
}

contextBridge.exposeInMainWorld('promptAPI', {
    onPromptData,
    sendPromptResponse: (payload) => ipcRenderer.send('prompt-response', payload)
});
