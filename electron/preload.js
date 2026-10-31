'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getSize: () => ipcRenderer.invoke('get-size'),
  getOpacity: () => ipcRenderer.invoke('get-opacity'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore', ignore),
  sendMask: (w, h, bits) => ipcRenderer.send('mask', { w, h, bits }),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, d) => cb(d)),
  onShown: (cb) => ipcRenderer.on('shown', () => cb()),
  onDragEnd: (cb) => ipcRenderer.on('drag-end', (_e, d) => cb(d)),
  onDragShake: (cb) => ipcRenderer.on('drag-shake', (_e, d) => cb(d)),
  onTap: (cb) => ipcRenderer.on('tap', (_e, p) => cb(p)),
  onShakeDizzy: (cb) => ipcRenderer.on('shake-dizzy', (_e, d) => cb(d)),
  onFlingHold: (cb) => ipcRenderer.on('fling-hold', (_e, d) => cb(d)),
  sendMotions: (list) => ipcRenderer.send('motions', list),
  openMenu: () => ipcRenderer.send('open-menu'),
  sendRects: (d) => ipcRenderer.send('ui-rects', d),
  sendPetBox: (b) => ipcRenderer.send('pet-box', b),
  onPlayLine: (cb) => ipcRenderer.on('play-line', (_e, k) => cb(k)),
  onOnboarding: (cb) => ipcRenderer.on('onboarding', (_e, d) => cb(d)),
  onboard: (kind) => ipcRenderer.send('onboard', { kind }),
  onPerf: (cb) => ipcRenderer.on('perf', (_e, m) => cb(m)),
  onPowerSave: (cb) => ipcRenderer.on('power-save', (_e, v) => cb(v)),
  getPowerSave: () => ipcRenderer.invoke('get-power-save'),
  onSetSize: (cb) => ipcRenderer.on('set-size', (_e, f) => cb(f)),
  onOpacity: (cb) => ipcRenderer.on('ui-opacity', (_e, v) => cb(v)),
  onPlayMotion: (cb) => ipcRenderer.on('play-motion', (_e, d) => cb(d)),
  dragStart: (pos) => ipcRenderer.send('drag-start', pos || null),
  dragEnd: () => ipcRenderer.send('drag-end'),
  dragMove: (pos) => ipcRenderer.send('drag-move', pos),
  dragBy: (d) => ipcRenderer.send('drag-by', d),
  quit: () => ipcRenderer.send('quit'),
  log: (...args) => ipcRenderer.send('log', args.map(String).join(' '))
});
