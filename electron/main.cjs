const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

let serverProcess;
const PORT = 3127;

function startServer() {
  const serverPath = path.join(app.getAppPath(), 'src', 'def-market-guard.mjs');
  serverProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function waitForServer(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function createWindow() {
  startServer();
  const ready = await waitForServer(`http://127.0.0.1:${PORT}/api/health`);
  if (!ready) {
    dialog.showErrorBox('Sleeper Draft Assistant', 'The local assistant service could not start.');
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 500,
    height: 900,
    minWidth: 420,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: '#090b10',
    title: 'Sleeper Draft Assistant',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadURL(`http://127.0.0.1:${PORT}/`);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
