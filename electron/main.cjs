const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const readline = require('readline')

let mainWindow = null
let pythonProc = null
let reqCounter = 0
const pending = new Map()
let workerStderr = ''

function isPackagedApp() {
  return app.isPackaged
}

function ttsRoot() {
  return isPackagedApp()
    ? path.join(process.resourcesPath, 'tts')
    : path.resolve(__dirname, '..')
}

function devBundlePythonHome() {
  return path.join(__dirname, '..', 'bundle', 'python')
}

function devBundlePythonExecutable() {
  const home = devBundlePythonHome()
  if (process.platform === 'win32') {
    return path.join(home, 'Scripts', 'python.exe')
  }
  return path.join(home, 'bin', 'python3')
}

function pythonExecutable() {
  if (process.env.TTS_PYTHON) return process.env.TTS_PYTHON
  if (isPackagedApp()) {
    if (process.platform === 'win32') {
      return path.join(process.resourcesPath, 'python', 'Scripts', 'python.exe')
    }
    return path.join(process.resourcesPath, 'python', 'bin', 'python3')
  }
  const devBundlePy = devBundlePythonExecutable()
  if (fs.existsSync(devBundlePy)) return devBundlePy
  return 'python3'
}

function getModelsHome() {
  return path.join(app.getPath('userData'), 'models')
}

function workerEnv() {
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    TTS_MODELS_HOME: getModelsHome(),
  }
  delete env.HF_HUB_OFFLINE
  delete env.TRANSFORMERS_OFFLINE
  const pyHome = isPackagedApp()
    ? path.join(process.resourcesPath, 'python')
    : devBundlePythonHome()
  if (fs.existsSync(pyHome)) {
    env.VIRTUAL_ENV = pyHome
    const binDir =
      process.platform === 'win32'
        ? path.join(pyHome, 'Scripts')
        : path.join(pyHome, 'bin')
    env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`
  }
  return env
}

function assertWorkerRuntime() {
  const py = pythonExecutable()
  const script = path.join(ttsRoot(), 'tts_worker.py')
  if (!fs.existsSync(script)) {
    throw new Error(`Worker script not found at ${script}`)
  }
  if (isPackagedApp() && !fs.existsSync(py)) {
    throw new Error(
      `Bundled Python not found at ${py}. Run: npm run prepare-bundle (from electron/)`,
    )
  }
  if (!isPackagedApp() && !fs.existsSync(devBundlePythonExecutable())) {
    console.warn(
      `[ReadingTime] Dev bundle Python not found. Using "${py}" from PATH.\n` +
        `  If the worker fails, run: cd electron && npm run prepare-bundle\n` +
        `  Or set TTS_PYTHON to your venv python.`,
    )
  }
}

function startPythonWorker() {
  assertWorkerRuntime()
  workerStderr = ''
  const root = ttsRoot()
  const script = path.join(root, 'tts_worker.py')
  const py = pythonExecutable()
  console.log(`[ReadingTime] Starting worker: ${py} ${script}`)
  pythonProc = spawn(py, [script], {
    cwd: root,
    env: workerEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const rl = readline.createInterface({ input: pythonProc.stdout })
  rl.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      console.error('Bad JSON from worker:', line)
      return
    }

    if (msg.event) {
      mainWindow?.webContents.send('tts-event', msg.event)
      return
    }

    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.ok) resolve(msg.data)
      else reject(new Error(msg.error || 'Unknown error'))
    }
  })

  pythonProc.stderr.on('data', (d) => {
    const chunk = d.toString()
    workerStderr = (workerStderr + chunk).slice(-8000)
    console.error('[tts_worker]', chunk)
  })

  pythonProc.on('exit', (code) => {
    console.error('Python worker exited:', code)
    if (workerStderr.trim()) {
      console.error('[tts_worker] last stderr:\n', workerStderr.trim())
    }
    for (const [, { reject }] of pending) {
      reject(new Error('Python worker stopped'))
    }
    pending.clear()
  })
}

function waitForWorkerReady(maxMs = 180_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs

    const attempt = () => {
      if (!pythonProc) {
        reject(new Error('Python worker not started'))
        return
      }
      if (pythonProc.exitCode != null) {
        const hint = workerStderr.trim() ? `\n\n${workerStderr.trim()}` : ''
        reject(
          new Error(
            `Python worker exited during startup (code ${pythonProc.exitCode}).` +
              hint +
              '\n\nTry: cd electron && npm run prepare-bundle',
          ),
        )
        return
      }

      rpc('ping')
        .then(() => resolve())
        .catch(() => {
          if (Date.now() >= deadline) {
            reject(
              new Error(
                'Python worker did not respond in time (still loading models?).',
              ),
            )
            return
          }
          setTimeout(attempt, 400)
        })
    }

    setTimeout(attempt, 300)
  })
}

function rpc(cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!pythonProc) {
      reject(new Error('Python worker not started'))
      return
    }
    const id = String(++reqCounter)
    let timeoutMs = 600_000
    if (cmd === 'preview_voice') timeoutMs = 120_000
    if (cmd === 'download_models') timeoutMs = 3_600_000
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`Timeout: ${cmd}`))
      }
    }, timeoutMs)
    pending.set(id, {
      resolve: (data) => {
        clearTimeout(timer)
        resolve(data)
      },
      reject: (err) => {
        clearTimeout(timer)
        reject(err)
      },
    })
    pythonProc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n')
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'ReadingTime',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Preload + ipcRenderer must work when loading the Vite dev server URL.
      sandbox: false,
    },
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
    // Opt-in only — auto-opening DevTools spams harmless Autofill CDP errors in Electron.
    if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'))
  }
}

app.whenReady().then(async () => {
  try {
    startPythonWorker()
    await waitForWorkerReady()
    createWindow()
  } catch (err) {
    console.error(err)
    dialog.showErrorBox(
      'ReadingTime',
      `${err.message}\n\nDevelopment: cd electron && npm run prepare-bundle\nThen: npm run dev`,
    )
    app.quit()
  }
})

app.on('window-all-closed', () => {
  pythonProc?.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

ipcMain.handle('pick-input-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Documents',
        extensions: ['txt', 'md', 'docx', 'pdf'],
      },
    ],
  })
  return canceled ? [] : filePaths
})

ipcMain.handle('pick-output-file', async (_, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || 'output.wav',
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  })
  return canceled ? null : filePath
})

ipcMain.handle('pick-output-directory', async (_, defaultPath) => {
  const opts = {
    properties: ['openDirectory', 'createDirectory'],
  }
  if (defaultPath) opts.defaultPath = defaultPath
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, opts)
  return canceled ? null : filePaths[0]
})

ipcMain.handle('show-item-in-folder', async (_, filePath) => {
  shell.showItemInFolder(filePath)
})

ipcMain.handle('read-file-base64', async (_, filePath) => {
  const data = await fs.promises.readFile(filePath)
  return data.toString('base64')
})

ipcMain.handle('get-models-path', () => getModelsHome())

ipcMain.handle('open-models-folder', async () => {
  const dir = getModelsHome()
  await fs.promises.mkdir(dir, { recursive: true })
  shell.openPath(dir)
})

ipcMain.handle('tts-rpc', async (_, cmd, payload) => rpc(cmd, payload))
