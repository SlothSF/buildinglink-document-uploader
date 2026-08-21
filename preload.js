// ═══════════════════════════════════════════════════════════════
// PRELOAD — the only bridge between the sandboxed renderer and the main
// process. Exposes a small, typed API on window.api via contextBridge; the
// renderer can do nothing else (contextIsolation + no nodeIntegration).
// ═══════════════════════════════════════════════════════════════
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Welcome-screen logo as a base64 data URL, or null if not present.
  getLogo: () => ipcRenderer.invoke('get-logo'),

  // Ask the main process to scan the source folder. → { ok, counts } | { ok:false, error }
  scanFiles: () => ipcRenderer.invoke('scan-files'),

  // Start a batch. options: {} | { all:true } | { dryRun:true }, any of which may
  // also carry { types:[...] } to restrict the run to the selected file types.
  // → { ok:true } | { ok:false, error }
  startRun: (options) => ipcRenderer.invoke('start-run', options || {}),

  // Run control. All three act MID-FILE, within a fraction of a second.
  //   pause  → the run parks wherever it is; resume continues the same file on
  //            the same step, with nothing re-done.
  //   stop   → the file in flight is abandoned (nothing uploaded, PDF left in
  //            the source folder) and the run ends.
  // The one exception is a save already in progress: from the Save click to the
  // confirmation that BuildingLink has the document, the run finishes what it
  // started before honouring either. That shows up as state 'finishing'.
  // → { ok:true }
  pauseRun:  () => ipcRenderer.invoke('pause-run'),
  resumeRun: () => ipcRenderer.invoke('resume-run'),
  stopRun:   () => ipcRenderer.invoke('stop-run'),

  // Run-state changes. cb receives { state, reason, finishing, step } where
  // state is 'running' | 'pausing' | 'paused' | 'stopping' | 'finishing' |
  // 'aborted'. `finishing` names the uninterruptible work being completed;
  // `step` is where the run parked, for the Paused label.
  // Returns an unsubscribe fn.
  onRunState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('run-state', handler);
    return () => ipcRenderer.removeListener('run-state', handler);
  },

  // Live log lines from upload.js. Returns an unsubscribe fn.
  onLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on('log', handler);
    return () => ipcRenderer.removeListener('log', handler);
  },

  // Updatable log lines (step timings). cb receives { id, text } to show a new
  // line under that id, or { id, append } to append to the line already shown.
  // Returns an unsubscribe fn.
  onLogUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('log-update', handler);
    return () => ipcRenderer.removeListener('log-update', handler);
  },

  // Structured progress from the batch engine. cb receives one of:
  //   { phase:'batch-start', total, byType, folderCounts }
  //   { phase:'file-start',  type, filename, index, total }
  //   { phase:'file-end',    type, filename, index, total, ok, moved, error, plainError, interrupted }
  //   { phase:'batch-end',   processed, durationMs, pausedMs }
  // Returns an unsubscribe fn.
  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('progress', handler);
    return () => ipcRenderer.removeListener('progress', handler);
  },

  // A plain text prompt is needed (fallback path). cb receives { id, question };
  // answer it with answerPrompt(id, answer). Returns an unsubscribe fn.
  onPrompt: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('prompt', handler);
    return () => ipcRenderer.removeListener('prompt', handler);
  },

  // A structured choice prompt is needed. cb receives { id, spec } where spec
  // has { kind, title, filename, unit, message, options:[{value,label,description}],
  // multi, allowAll, allowSkip }. Answer it with answerPrompt(id, value).
  // Returns an unsubscribe fn.
  onChoice: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('choice', handler);
    return () => ipcRenderer.removeListener('choice', handler);
  },

  // Send the operator's answer back for a given prompt id.
  answerPrompt: (id, answer) => ipcRenderer.send('prompt-answer', { id, answer }),

  // The batch finished. cb receives { ok, summary } | { ok:false, error }.
  // Returns an unsubscribe fn.
  onRunComplete: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('run-complete', handler);
    return () => ipcRenderer.removeListener('run-complete', handler);
  },
});
