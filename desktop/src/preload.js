// Sandboxed preload: the only bridge between the site and the app. Keep it this small;
// game/src/desktop.ts holds the matching types.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const VERSION_ARG = '--breathless-version=';
const versionArg = process.argv.find((arg) => arg.startsWith(VERSION_ARG));

contextBridge.exposeInMainWorld('breathlessDesktop', {
  platform: process.platform,
  version: versionArg ? versionArg.slice(VERSION_ARG.length) : '',
  walletRequest: (req) => ipcRenderer.invoke('wallet:request', req),
});
