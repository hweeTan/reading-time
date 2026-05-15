const { contextBridge, ipcRenderer, webUtils } = require("electron");

try {
  contextBridge.exposeInMainWorld("ttsApp", {
    getPathForFile: (file) => webUtils.getPathForFile(file),
    pickInputFiles: () => ipcRenderer.invoke("pick-input-files"),
    pickOutputFile: (name) => ipcRenderer.invoke("pick-output-file", name),
    pickOutputDirectory: (defaultPath) =>
      ipcRenderer.invoke("pick-output-directory", defaultPath),
    showItemInFolder: (p) => ipcRenderer.invoke("show-item-in-folder", p),
    readFileBase64: (p) => ipcRenderer.invoke("read-file-base64", p),
    getModelsPath: () => ipcRenderer.invoke("get-models-path"),
    openModelsFolder: () => ipcRenderer.invoke("open-models-folder"),
    rpc: (cmd, payload) => ipcRenderer.invoke("tts-rpc", cmd, payload),
    onEvent: (handler) => {
      const listener = (_e, event) => handler(event);
      ipcRenderer.on("tts-event", listener);
      return () => ipcRenderer.removeListener("tts-event", listener);
    },
  });
} catch (err) {
  console.error("[preload] Failed to expose ttsApp bridge:", err);
}
