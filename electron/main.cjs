// AIOS 本地软件(Electron 壳):无 key 弹激活页 → 粘 key → 起引擎 → 进 AIOS。
// key 只存本机(.aios-key.json),通过环境变量注入引擎,不改引擎代码。
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ENGINE_DIR = path.join(__dirname, '..');
const KEY_FILE = path.join(ENGINE_DIR, '.aios-key.json');
let serverProc = null;
let win = null;

const loadKey = () => { try { return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).key || ''; } catch { return ''; } };
const saveKey = (k) => { try { fs.writeFileSync(KEY_FILE, JSON.stringify({ key: k })); } catch (e) { /* ignore */ } };

function startServer(key) {
  if (serverProc) return;
  serverProc = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: ENGINE_DIR,
    env: { ...process.env, DEEPSEEK_API_KEY: key, PORT: '8911' },
    stdio: 'inherit',
  });
}

// 轮询引擎就绪再加载,避免白屏
function waitThenLoad(retries = 50) {
  http
    .get('http://localhost:8911/', (res) => { res.destroy(); if (win) win.loadURL('http://localhost:8911'); })
    .on('error', () => { if (retries > 0) setTimeout(() => waitThenLoad(retries - 1), 300); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 840, backgroundColor: '#07070a',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const key = loadKey();
  if (!key) {
    win.loadFile(path.join(__dirname, 'setup.html'));
  } else {
    startServer(key);
    waitThenLoad();
  }
}

ipcMain.on('activate', (_e, key) => {
  saveKey(String(key || ''));
  startServer(String(key || ''));
  waitThenLoad();
});
ipcMain.on('open-external', (_e, url) => shell.openExternal(String(url)));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (serverProc) serverProc.kill(); app.quit(); });
app.on('before-quit', () => { if (serverProc) serverProc.kill(); });
