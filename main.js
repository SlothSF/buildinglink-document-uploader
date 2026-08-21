// ═══════════════════════════════════════════════════════════════
// ELECTRON MAIN PROCESS
// Hosts the desktop UI and drives the existing upload.js batch engine.
//   - log()  → streamed to the renderer's live log pane (IPC 'log')
//   - ask()  → sent to the renderer as a modal prompt (IPC 'prompt'); the
//              returned Promise resolves when the renderer answers (IPC
//              'prompt-answer'), so the batch pauses exactly like the CLI does.
//   - the batch runs un-awaited inside an IPC handler so the UI thread (and the
//     window) stay responsive while Playwright drives a SEPARATE Chrome window.
// The CLI (node upload.js) is untouched — it still uses upload.js's own
// console/readline IO; this file only matters under `electron .`.
// ═══════════════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const upload = require('./upload.js');

let mainWindow = null;
let runInProgress = false;

// Pending operator prompts, keyed by a monotonic id. ask() stores its resolver
// here and the renderer's answer (IPC 'prompt-answer') pops + resolves it.
const pendingPrompts = new Map();
let promptSeq = 0;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'BuildingLink Document Uploader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile('index.html');

  // Closing the window kills the Playwright session that was launched from this
  // process. Without this, the batch loop would keep marching through the
  // remaining files, erroring instantly on each one against a dead browser — so
  // abort the run and terminate Chrome the moment the window goes away.
  mainWindow.on('closed', () => {
    mainWindow = null;
    // Nothing can answer a prompt any more; release anything still waiting.
    for (const [id, resolve] of pendingPrompts) { resolve(''); pendingPrompts.delete(id); }
    if (runInProgress) upload.abortRun('The application window was closed').catch(() => {});
  });
}

// UI-backed log: forward every line to the renderer (coerced to string so the
// existing emoji/divider lines survive intact).
function uiLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', String(msg));
  }
}

// Updatable log lines, used for step timings: { id, text } shows a line the
// renderer keeps a handle on, { id, append } appends to that same line once the
// step finishes. This is what lets a step print immediately AND still end up
// reading "[3] Opening Documents tab... (4.5s)".
function uiLogUpdate(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-update', payload);
  }
}

// Structured progress events (batch-start / file-start / file-end / batch-end).
// These drive the live per-type counts and the run timer, so they must keep
// flowing even while the batch is busy — they are fire-and-forget, never awaited.
function uiProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress', payload);
  }
}

// UI-backed ask: show a modal in the renderer and wait for its answer. Mirrors
// the CLI's ask() contract — resolves to a trimmed string.
function uiAsk(question) {
  return new Promise(resolve => {
    const id = ++promptSeq;
    pendingPrompts.set(id, resolve);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('prompt', { id, question: String(question) });
    } else {
      // No window to ask — resolve empty so the batch doesn't hang forever.
      pendingPrompts.delete(id);
      resolve('');
    }
  });
}

// UI-backed askChoice: send the structured spec to the renderer, which renders
// clickable buttons and sends back the chosen value string. Resolves to that
// string (same contract as the CLI's askChoice), so upload.js's parsing is
// unchanged. Reuses the same pending-prompt map + 'prompt-answer' channel.
function uiAskChoice(spec) {
  return new Promise(resolve => {
    const id = ++promptSeq;
    pendingPrompts.set(id, resolve);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('choice', { id, spec: spec || {} });
    } else {
      pendingPrompts.delete(id);
      resolve('');
    }
  });
}

// Renderer answered a prompt → resolve the matching pending Promise.
ipcMain.on('prompt-answer', (_event, { id, answer }) => {
  const resolve = pendingPrompts.get(id);
  if (resolve) {
    pendingPrompts.delete(id);
    resolve(String(answer == null ? '' : answer).trim());
  }
});

// Return the welcome-screen logo as a base64 data URL (so the renderer can draw
// it to a canvas and knock out the white background without file:// taint).
// Returns null if logo.png isn't present, so the splash degrades gracefully.
ipcMain.handle('get-logo', () => {
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'logo.png'));
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch {
    return null;
  }
});

// Scan the source folder and return per-type counts for the header. Never
// throws across IPC — a missing S:\ drive comes back as { error }.
ipcMain.handle('scan-files', () => {
  try {
    const cats = upload.scanFiles();
    const counts = {};
    for (const key of Object.keys(cats)) counts[key] = cats[key].length;
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Run control (pause / resume / stop) ────────────────────────
// upload.js gates MID-FILE: all three take effect within a fraction of a second,
// wherever the run happens to be. A pause parks the file in place and resumes on
// the same step; a stop abandons the file in flight with nothing uploaded. The
// only work that is allowed to finish first is a save already in progress —
// reported as state 'finishing'. See the RUN CONTROL block in upload.js.
ipcMain.handle('pause-run',  () => { upload.requestPause();  return { ok: true }; });
ipcMain.handle('resume-run', () => { upload.requestResume(); return { ok: true }; });
ipcMain.handle('stop-run',   () => { upload.requestStop();   return { ok: true }; });

// Mirror the engine's run state ('running' | 'pausing' | 'paused' | 'stopping' |
// 'finishing' | 'aborted') into the renderer so the toolbar can show Pause vs
// Resume, and explain a brief 'finishing' hold rather than looking unresponsive.
upload.setRunStateListener(payload => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('run-state', payload);
});

// Start a batch. options come straight from the UI buttons:
//   {}                          → test mode (1 per type)
//   { all: true }               → full run
//   { dryRun: true }            → offline plan, no Chrome / no moves
// Any of the above may carry { types: [...] } — the file-type squares the
// operator selected in the header. It restricts which categories run and
// composes with every mode, so { all:true, types:[...] } is a FULL run of just
// those types. Omitted/empty → all types (the original behaviour).
// Runs un-awaited so this handler returns immediately and the UI stays live;
// completion is announced via the 'run-complete' event.
ipcMain.handle('start-run', async (_event, options = {}) => {
  if (runInProgress) return { ok: false, error: 'A run is already in progress.' };
  runInProgress = true;

  // Route upload.js's IO through the UI for the duration of the run. outputDir
  // points at a writable folder (the app's userData) — when packaged, upload.js's
  // own __dirname is inside the read-only app.asar, so run logs and debug
  // screenshots must go somewhere writable.
  upload.configureIO({
    log: uiLog, logUpdate: uiLogUpdate, ask: uiAsk, askChoice: uiAskChoice,
    progress: uiProgress, outputDir: app.getPath('userData'),
  });

  // Fire and forget — do NOT await, so the renderer stays responsive.
  (async () => {
    try {
      const summary = await upload.main(options);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('run-complete', { ok: true, summary: summary || null });
      }
    } catch (err) {
      uiLog(`\n  ✗ FATAL: ${err.message}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('run-complete', { ok: false, error: err.message });
      }
    } finally {
      runInProgress = false;
      // Clear any prompts left dangling by an aborted run.
      for (const [id, resolve] of pendingPrompts) { resolve(''); pendingPrompts.delete(id); }
    }
  })();

  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Don't quit until the run has been aborted and Chrome torn down — otherwise a
// packaged build can leave an orphaned browser behind when the window closes
// mid-run.
app.on('window-all-closed', async () => {
  // Capped wait: a wedged browser must never leave the app unable to quit.
  try {
    await Promise.race([
      upload.abortRun('The application window was closed'),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
  } catch {}
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { upload.abortRun('The application is quitting').catch(() => {}); });
