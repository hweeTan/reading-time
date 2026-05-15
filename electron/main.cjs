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
let workerSignaledReady = false
let workerBootComplete = false
let rpcSerial = Promise.resolve()
let bootstrapCache = null
let bootstrapPromise = null

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

function packagedPythonCandidates() {
  const base = path.join(process.resourcesPath, 'python')
  if (process.platform === 'win32') {
    return [path.join(base, 'Scripts', 'python.exe')]
  }
  // Prefer python3; some venvs only expose `python` as the real file.
  return [path.join(base, 'bin', 'python3'), path.join(base, 'bin', 'python')]
}

function pythonExecutable() {
  if (process.env.TTS_PYTHON) return process.env.TTS_PYTHON
  if (isPackagedApp()) {
    for (const candidate of packagedPythonCandidates()) {
      if (fs.existsSync(candidate)) return candidate
    }
    return packagedPythonCandidates()[0]
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
    // Do not set PYTHONHOME with a venv — it breaks stdlib discovery (encodings).
    delete env.PYTHONHOME
    if (isPackagedApp() && process.platform === 'darwin') {
      const fwDir = path.join(pyHome, 'Frameworks')
      if (fs.existsSync(fwDir)) {
        const cur = env.DYLD_FRAMEWORK_PATH || ''
        env.DYLD_FRAMEWORK_PATH = cur ? `${fwDir}${path.delimiter}${cur}` : fwDir
      }
    }
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
      `Bundled Python not found at ${py}. Run: pnpm run prepare-bundle (from electron/)`,
    )
  }
  if (!isPackagedApp() && !fs.existsSync(devBundlePythonExecutable())) {
    console.warn(
      `[ReadingTime] Dev bundle Python not found. Using "${py}" from PATH.\n` +
        `  If the worker fails, run: cd electron && pnpm run prepare-bundle\n` +
        `  Or set TTS_PYTHON to your venv python.`,
    )
  }
}

function startPythonWorker() {
  assertWorkerRuntime()
  workerStderr = ''
  workerSignaledReady = false
  workerBootComplete = false
  bootstrapCache = null
  bootstrapPromise = null
  const root = ttsRoot()
  const script = path.join(root, 'tts_worker.py')
  const py = pythonExecutable()
  console.log(`[ReadingTime] Starting worker: ${py} ${script}`)
  pythonProc = spawn(py, ['-u', script], {
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
      if (msg.event.type === 'worker_ready') {
        workerSignaledReady = true
      }
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

  pythonProc.on('error', (err) => {
    console.error('[ReadingTime] Failed to spawn Python worker:', err)
    workerStderr = `${workerStderr}\n${err.message}`.slice(-8000)
  })

  pythonProc.stderr.on('data', (d) => {
    const chunk = d.toString()
    workerStderr = (workerStderr + chunk).slice(-8000)
    console.error('[tts_worker]', chunk)
  })

  pythonProc.on('exit', (code) => {
    console.error('Python worker exited:', code)
    workerBootComplete = false
    bootstrapCache = null
    bootstrapPromise = null
    if (workerStderr.trim()) {
      console.error('[tts_worker] last stderr:\n', workerStderr.trim())
    }
    for (const [, { reject }] of pending) {
      reject(new Error('Python worker stopped'))
    }
    pending.clear()
  })
}

function waitForWorkerReady(maxMs = 120_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs

    const poll = () => {
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
              '\n\nTry: cd electron && pnpm run prepare-bundle',
          ),
        )
        return
      }
      if (workerSignaledReady) {
        workerBootComplete = true
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        const hint = workerStderr.trim() ? `\n\n${workerStderr.trim()}` : ''
        const dyld = workerStderr.includes('Library not loaded')
        reject(
          new Error(
            (dyld
              ? 'Bundled Python failed to start (missing library). Rebuild the Intel DMG so Python.framework is embedded in the app.'
              : 'Python worker did not respond in time.') +
              ' No worker_ready signal received.' +
              hint +
              '\n\nTry: cd electron && pnpm run prepare-bundle',
          ),
        )
        return
      }
      setTimeout(poll, 50)
    }

    poll()
  })
}

async function bootstrapWorker() {
  if (bootstrapCache) return bootstrapCache
  if (bootstrapPromise) return bootstrapPromise

  bootstrapPromise = (async () => {
    if (!pythonProc || pythonProc.exitCode != null) {
      startPythonWorker()
    }
    await waitForWorkerReady()
    const modelsPath = getModelsHome()
    const status = await rpc('check_models', {}, 120_000)
    bootstrapCache = { modelsPath, ...status }
    return bootstrapCache
  })()

  try {
    return await bootstrapPromise
  } catch (err) {
    bootstrapPromise = null
    throw err
  }
}

function rpc(cmd, payload = {}, timeoutMs) {
  const run = () =>
    new Promise((resolve, reject) => {
      if (!pythonProc) {
        reject(new Error('Python worker not started'))
        return
      }
      if (pythonProc.exitCode != null) {
        reject(new Error('Python worker stopped'))
        return
      }
      const id = String(++reqCounter)
      let ms = timeoutMs
      if (ms == null) {
        ms = 600_000
        if (cmd === 'ping') ms = 60_000
        if (cmd === 'check_models') ms = 60_000
        if (cmd === 'preview_voice') ms = 120_000
        if (cmd === 'download_models') ms = 3_600_000
      }
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`Timeout: ${cmd}`))
        }
      }, ms)
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
      const line = JSON.stringify({ id, cmd, ...payload }) + '\n'
      const ok = pythonProc.stdin.write(line, 'utf8')
      if (!ok) {
        pythonProc.stdin.once('drain', () => {})
      }
    })

  const job = rpcSerial.then(run, run)
  rpcSerial = job.catch(() => {})
  return job
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
    await bootstrapWorker()
    createWindow()
  } catch (err) {
    console.error(err)
    dialog.showErrorBox(
      'ReadingTime',
      `${err.message}\n\nDevelopment: cd electron && pnpm run prepare-bundle\nThen: pnpm run dev`,
    )
    app.quit()
  }
})

app.on('window-all-closed', () => {
  pythonProc?.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length > 0) return
  try {
    await bootstrapWorker()
    createWindow()
  } catch (err) {
    console.error(err)
    dialog.showErrorBox('ReadingTime', err.message)
  }
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

ipcMain.handle('get-models-path', () => getModelsHome())

ipcMain.handle('open-models-folder', async () => {
  const dir = getModelsHome()
  await fs.promises.mkdir(dir, { recursive: true })
  shell.openPath(dir)
})

ipcMain.handle('tts-bootstrap', async () => bootstrapWorker())

ipcMain.handle('tts-rpc', async (_, cmd, payload) => {
  if (
    cmd === 'ping' &&
    workerBootComplete &&
    pythonProc &&
    pythonProc.exitCode == null
  ) {
    return { pong: true }
  }
  return rpc(cmd, payload)
})
