'use strict';

const { app, BrowserWindow, ipcMain, protocol, net, Tray, Menu, screen, shell, nativeImage, globalShortcut, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// ---------------------------------------------------------------- 启动参数固化
// 以前必须用 electron . --no-sandbox --disable-gpu 启动，否则会以
// -2147483645 (STATUS_BREAKPOINT) 退出。这里把参数写进代码，用户直接双击即可
app.disableHardwareAcceleration();      // 等价 --disable-gpu
app.commandLine.appendSwitch('no-sandbox');   // 等价 --no-sandbox（部分环境仍需命令行传入，见手册）

// ---------------------------------------------------------------- config
// 模型解析顺序：环境变量 → 打包内置 → 开发态仓库内 assets/models → 旧的本机游戏目录
// 这样换机器 / 打包分发都不用再配路径
const MODEL_ENTRY = process.env.MORI_MODEL_ENTRY || 'morichan/morichan.pet.model3.json';
function resolveModelRoot() {
  const candidates = [];
  if (process.env.MORI_MODEL_ROOT) candidates.push(process.env.MORI_MODEL_ROOT);
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'models'));
  candidates.push(path.join(__dirname, '..', 'assets', 'models'));
  candidates.push('D:\\zyxgame\\st\\steamapps\\common\\FoxHimeZero\\图\\L2D');
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, MODEL_ENTRY))) return c;
    } catch (e) { }
  }
  return candidates[candidates.length - 1];
}
const MODEL_ROOT = resolveModelRoot();
const WIN_W_BASE = 380;
let WIN_W = WIN_W_BASE;          // 实际窗口宽度（随大小调整：宽度必须跟着缩放，否则 >100% 时尾巴被裁）
const DIALOG_H = 120;            // 顶部留给气泡的高度
const BASE_CANVAS_H = 520;       // 画布基础高度
const MIN_VISIBLE = 120;        // 救回底线：窗口至少露出这么多像素
// 窗口顶最多可以出屏多少：正好把顶部气泡带让出去，让她（画布贴在窗口底部）的头顶能贴到屏幕最顶
const TOP_OVERHANG = DIALOG_H;
function heightForSize(f) { return DIALOG_H + Math.round(BASE_CANVAS_H * f); }
function widthForSize(f) { return Math.round(WIN_W_BASE * f); }
let WIN_H = 640;                 // 实际窗口高度（随大小调整）
const SNAP_DIST = 10;

// 甩飞（拖拽眩晕）阈值：窗口均速、持续性、累计距离三者同时满足才触发，避免"手一快就晕"
const FLING_ENTER = 1500;      // 250ms 窗口均速（px/s）才进入甩飞
const FLING_EXIT = 1000;       // 退出阈值（滞回，低于它才停）
const FLING_MIN_WIN_D = 90;    // 窗口内累计位移下限
const FLING_HOLD_MS = 180;     // 需连续超过 FLING_ENTER 的时长
const FLING_MIN_TOTAL = 240;   // 本次拖拽累计位移下限（原地快抖不算）

// 用户数据放到 %APPDATA%\mori-pet（与程序目录解耦，装到 Program Files 也能写）
// 旧版本写在程序目录 .userdata，首次运行自动把 window.json 迁过来
// 若 %APPDATA% 不可写（受限沙箱/只读配置），退回程序目录，保证还能启动
function initUserData() {
  const migrate = (ud) => {
    const oldState = path.join(__dirname, '..', '.userdata', 'window.json');
    const newState = path.join(ud, 'window.json');
    if (fs.existsSync(oldState) && !fs.existsSync(newState)) {
      try { fs.copyFileSync(oldState, newState); } catch (e) { }
    }
  };
  // 候选顺序：可写探针逐个验证，全部失败才用 Electron 默认目录。
  // 打包后 __dirname 在 app.asar 里（是文件不是目录），不能再用"程序目录"兜底
  const cands = [];
  if (process.env.MORI_DATA_DIR) cands.push(process.env.MORI_DATA_DIR);
  try { cands.push(path.join(app.getPath('appData'), 'mori-pet')); } catch (e) { }
  try { cands.push(path.join(app.getPath('localAppData'), 'mori-pet')); } catch (e) { }
  // 便携兜底：打包后放 exe 旁边，开发态放仓库里的 .userdata（asar 内部不可写，不能用 __dirname）
  try {
    const base = app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..');
    cands.push(path.join(base, '.userdata'));
  } catch (e) { }
  try { cands.push(path.join(require('node:os').tmpdir(), 'mori-pet')); } catch (e) { }
  for (const ud of cands) {
    try {
      fs.mkdirSync(ud, { recursive: true });
      // 真写一下再删，确认不是"能建目录但写不进文件"
      const probe = path.join(ud, '.write-probe');
      fs.writeFileSync(probe, String(Date.now()));
      fs.unlinkSync(probe);
      app.setPath('userData', ud);
      app.setPath('sessionData', ud);
      migrate(ud);
      console.error('[boot] userData =', ud);
      return;
    } catch (e) {
      console.error('[boot] 数据目录不可用:', ud, '->', e.message);
    }
  }
  console.error('[boot] 所有数据目录候选都不可用，沿用 Electron 默认 userData');
}
initUserData();

// ---------------------------------------------------------------- 设置（settings.json）
// 单一真相：偏好类配置（引导/自启/尺寸/透明度）都写这里；window.json 只留几何 + 兼容旧字段
const SETTINGS_VERSION = 1;
const SETTINGS_DEFAULTS = {
  version: SETTINGS_VERSION,
  onboardingDone: false,
  autoLaunch: false,
  size: 1,
  opacity: 1,
  powerSave: false
};
let settings = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  const out = Object.assign({}, SETTINGS_DEFAULTS);
  let raw = null;
  try {
    raw = fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      try { fs.renameSync(settingsFile(), settingsFile() + '.bad'); } catch { }
    }
  }
  if (raw) {
    try {
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        for (const k of Object.keys(SETTINGS_DEFAULTS)) if (k in s) out[k] = s[k];
        if (s.hotkeys && typeof s.hotkeys === 'object') out.hotkeys = s.hotkeys;
      }
    } catch (e) {
      try { fs.renameSync(settingsFile(), settingsFile() + '.bad'); } catch { }
    }
  } else {
    // 首次运行：从旧 window.json 迁移尺寸/透明度
    const st = loadState();
    if (st) {
      if (Number.isFinite(Number(st.size)) && st.size) out.size = Number(st.size);
      if (Number.isFinite(Number(st.opacity))) out.opacity = Number(st.opacity);
    }
  }
  return out;
}

function saveSettings(patch) {
  settings = Object.assign({}, settings, patch, { version: SETTINGS_VERSION });
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) { logerr('[settings] save fail', e.message); }
  return settings;
}

settings = loadSettings();

protocol.registerSchemesAsPrivileged([{
  scheme: 'l2d',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true }
}]);

let win = null;
let tray = null;

function currentSize() {
  if (settings && Number.isFinite(Number(settings.size)) && Number(settings.size) > 0) return Number(settings.size);
  const st = loadState();
  return st && st.size ? Number(st.size) : 1;
}

function watchdog() {
  if (!win || win.isDestroyed()) return;
  // 拖拽中窗口会被系统逐帧撑大一点,这是已知现象;此时纠正会把"底边锚定"的宠物拽回去,
  // 视觉上就是拖着拖着往下一沉、松手又弹上来 —— 拖拽期间不纠,交给 endDrag 一次性归一
  if (rendererDragging) return;
  try {
    const b = win.getBounds();
    const db = screen.getDisplayMatching(b).bounds;
    const unreachable = !isFinite(b.y) || (b.y + b.height) < db.y + 150 || (b.x + b.width) < db.x + 40 || b.x > db.x + db.width - 40;
    const bad = !isFinite(b.width) || !isFinite(b.height) ||
      b.width > 900 || b.height > 1600 ||
      b.width < 100 || b.height < 100 || unreachable;
    if (bad) {
      logf('[watchdog] abnormal bounds', JSON.stringify(b), '-> rescue');
      rescueWindow('watchdog');
      return;
    }
    // 尺寸漂移自愈（Windows/DPI 下窗口会被一点点撑大）
    const wantH = heightForSize(currentSize());
    if (Math.abs(b.width - WIN_W) > 6 || Math.abs(b.height - wantH) > 6) {
      logf('[watchdog] size drift', JSON.stringify(b), '-> want', WIN_W, wantH);
      WIN_H = wantH;
      win.setBounds({ x: b.x, y: b.y, width: WIN_W, height: wantH });
    }
  } catch (e) { logerr('[watchdog]', e.message); }
}

function ensureOnScreen() {
  if (!win || win.isDestroyed()) return false;
  const b = win.getBounds();
  const db = screen.getDisplayMatching(b).bounds;
  const ix = Math.max(0, Math.min(b.x + b.width, db.x + db.width) - Math.max(b.x, db.x));
  const iy = Math.max(0, Math.min(b.y + b.height, db.y + db.height) - Math.max(b.y, db.y));
  if (ix < MIN_VISIBLE || iy < MIN_VISIBLE) {
    logf('[rescue] offscreen detected', ix, iy);
    rescueWindow('offscreen');
    return true;
  }
  return false;
}

function rescueWindow(reason) {
  if (!win || win.isDestroyed()) return;
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  const h = Math.min(WIN_H, wa.height - 20);
  WIN_W = widthForSize(currentSize());
  WIN_H = h;
  const x = wa.x + wa.width - WIN_W - 40;
  const y = wa.y + wa.height - h;
  win.setBounds({ x, y, width: WIN_W, height: h });
  win.showInactive();
  win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  saveState({ x, y, size: currentSize() });
  logf('[rescue]', reason || 'manual', '->', x, y);
}

function applySize(f) {
    if (!win) return;
    try {
      // 按「她当前所在的那块屏」算高度上限，双屏下副屏更矮时也能正确压倍率
      const wa0 = screen.getDisplayMatching(win.getBounds()).workArea;
      const maxH = wa0.height - 20;
      let nh = heightForSize(f);
      if (nh > maxH) {
        const f2 = Math.max(0.6, (maxH - DIALOG_H) / BASE_CANVAS_H);
        logf('[size] clamped', f, '->', f2.toFixed(3), '(screen too short)');
        f = Number(f2.toFixed(3));
        nh = heightForSize(f);
      }
      const b = win.getBounds();
      const nw = widthForSize(f);
      const nx = Math.round(b.x + b.width / 2 - nw / 2);   // 以窗口中心为轴，别只往右边长
      const ny = b.y + b.height - nh;
      WIN_W = nw;
      win.setBounds({ x: nx, y: ny, width: nw, height: nh });
      WIN_H = nh;
      saveState({ x: nx, y: ny, size: f });
      saveSettings({ size: f });
      win.webContents.send('set-size', f);
      logf('[size]', f, '-> window', nw + 'x' + nh);
    } catch (e) { logerr('[size]', e.message); }
}

// 整窗透明度（0.05~1），写回 window.json 的 opacity 字段，重启后保持。
// 用渲染进程的 CSS opacity 实现（win.setOpacity 在透明窗口上会导致整窗黑掉）
function setOpacity(v) {
  petOpacity = Math.min(1, Math.max(0.05, Number(v) || 1));
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('ui-opacity', petOpacity); } catch (e) { }
  }
  saveState({ opacity: petOpacity });
  saveSettings({ opacity: petOpacity });
  logf('[opacity]', Math.round(petOpacity * 100) + '%');
}

// 节能模式：渲染进程降到 8fps（交互时 25fps），隐藏时照旧停渲染
function setPowerSave(on) {
  const v = !!on;
  saveSettings({ powerSave: v });
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('power-save', v); } catch (e) { }
  }
  logf('[power] 节能模式', v ? 'on' : 'off');
}

// ---------------------------------------------------------------- 开机自启
function loginArgs() {
  // 开发态启动的是 electron.exe，需要把 app 路径当参数带上；打包后不需要
  return app.isPackaged ? ['--no-sandbox'] : [app.getAppPath(), '--no-sandbox'];
}
function syncAutoLaunch(enabled) {
  try {
    const opts = { openAtLogin: !!enabled, path: process.execPath, args: loginArgs() };
    app.setLoginItemSettings(opts);
    const real = app.getLoginItemSettings({ path: process.execPath, args: loginArgs() }).openAtLogin;
    logf('[autolaunch]', enabled ? 'on' : 'off', '-> os =', real);
    if (real !== !!enabled) logerr('[autolaunch] 写入未生效');
    return real;
  } catch (e) { logerr('[autolaunch]', e.message); return false; }
}
function setAutoLaunch(enabled) {
  // 以 OS 实际写入结果为准，避免 UI 勾上了但注册表没写进去
  const real = syncAutoLaunch(enabled);
  saveSettings({ autoLaunch: !!real });
  return real;
}

// ---------------------------------------------------------------- 首启引导
// 三步：启动先提示「拖我」→ 拖完提示「摸我」→ 摸完提示「右键菜单」→ 打开菜单即完成
const ONBOARD_LINES = [
  '先按住我，把我拖到你想放的位置吧。',
  '想摸我的话，点耳朵、尾巴、脚都可以哦……',
  '右键有我全部的动作菜单～热键 Ctrl+Alt+M 叫我出来 / 藏起来，Ctrl+Alt+R 把我叫回来。'
];
let onboardStep = 0;

function sendOnboard(text) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('onboarding', { text }); } catch (e) { }
  logf('[onboard] say', text);
}
function onboardStart(delayMs) {
  onboardStep = 0;
  saveSettings({ onboardingDone: false });
  setTimeout(() => { if (onboardStep === 0) sendOnboard(ONBOARD_LINES[0]); }, delayMs || 0);
}
function onboardMilestone(kind) {
  if (!settings || settings.onboardingDone) return;
  if (kind === 'menu') {
    onboardStep = 3;
    saveSettings({ onboardingDone: true });
    logf('[onboard] done');
    return;
  }
  if (onboardStep === 0 && kind === 'drag') { onboardStep = 1; sendOnboard(ONBOARD_LINES[1]); return; }
  if (onboardStep === 1 && (kind === 'tap' || kind === 'drag')) { onboardStep = 2; sendOnboard(ONBOARD_LINES[2]); return; }
}

function toggleVisible() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
    logf('[toggle] hidden');
  } else {
    win.showInactive();
    logf('[toggle] shown');
  }
}

// 日志：优先写程序目录（开发时方便）；装到 Program Files 等不可写位置时退回 %APPDATA%
const LOG_MAX = 5 * 1024 * 1024;   // 单份日志上限 5MB，超过就滚成 .1
const LOG_PATH = (() => {
  const prefer = path.join(__dirname, '..', 'pet.log');
  try { fs.accessSync(path.dirname(prefer), fs.constants.W_OK); return prefer; } catch { }
  try { return path.join(app.getPath('userData'), 'pet.log'); } catch { return prefer; }
})();

// 单实例：再次启动程序 = 开关她
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 日志轮转：启动时超过 5MB 就滚成 pet.log.1（保留上一份），不再清空——
  // 之前每次启动都覆盖，崩溃现场直接没了
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size > LOG_MAX) {
      const bak = LOG_PATH + '.1';
      try { fs.unlinkSync(bak); } catch { }
      fs.renameSync(LOG_PATH, bak);
    }
  } catch { }
  app.on('second-instance', () => {
    logf('[toggle] second instance -> toggle');
    toggleVisible();
  });
}
let dragTimer = null;
let dragStart = null;
// 渲染进程是否仍处在"按住左键拖动"状态（跟着 mouseup 走，不跟 400ms 兜底走）
let rendererDragging = false;
let alwaysOnTop = true;
let petOpacity = 1;
let DRAG_SCALE = 1;
let dragStart_unitScale = 1;   // 光标位移 -> 窗口位移 的换算系数（按 DPR 校准）
let motionCatalog = [];
let uiCanvas = null;
let uiDialog = null;
let petBox = null;             // 宠物可见包围盒（窗口内坐标），渲染进程上报
let alphaMask = null;          // Uint8Array，窗口内 alpha 掩码（1=实心）
let maskW = 0, maskH = 0;


let logLines = 0;
function appendLog(line) {
  try { fs.appendFileSync(LOG_PATH, line); } catch { return; }
  // 每 500 行检查一次体积，超过 5MB 就滚动为 pet.log.1（保留上一份）
  if (++logLines % 500 === 0) {
    try {
      if (fs.statSync(LOG_PATH).size > LOG_MAX) {
        const bak = LOG_PATH + '.1';
        try { fs.unlinkSync(bak); } catch { }
        fs.renameSync(LOG_PATH, bak);
      }
    } catch { }
  }
}

// 崩溃保留：把错误堆栈 + 最近 40 行日志单独落一份 crash-*.log
function dumpCrash(err, tag) {
  try {
    const name = 'crash-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log';
    const file = path.join(path.dirname(LOG_PATH), name);
    let tail = '';
    try {
      const raw = fs.readFileSync(LOG_PATH, 'utf8');
      tail = raw.split('\n').slice(-40).join('\n');
    } catch { }
    const body = [
      'time: ' + new Date().toISOString(),
      'tag: ' + (tag || 'crash'),
      'error: ' + (err && (err.stack || err.message || String(err))),
      '',
      '--- last 40 log lines ---',
      tail
    ].join('\n');
    fs.writeFileSync(file, body);
    logerr('[crash] dumped ->', name);
  } catch (e) { }
}

function logf(...a) {
  const line = new Date().toISOString() + ' ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n';
  appendLog(line);
}
function logerr(...a) {
  const line = new Date().toISOString() + ' [ERR] ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n';
  appendLog(line);
}

const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function loadState() {
  try {
    // 兼容带 BOM 的 JSON（PowerShell Set-Content 写出来的会带 \uFEFF）
    const raw = fs.readFileSync(stateFile(), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch { return null; }
}
function saveState(s) {
  // 合并写：调用方只传自己关心的字段（位置/尺寸/透明度），不会互相抹掉
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(Object.assign(loadState() || {}, s)));
  } catch {}
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const st = loadState();
  const savedSize = st && st.size ? Number(st.size) : 1;
  WIN_H = heightForSize(savedSize);
  WIN_W = widthForSize(savedSize);
  const x = st ? st.x : wa.x + wa.width - WIN_W - 40;
  const y = st ? st.y : wa.y + wa.height - WIN_H;
  // st.y 就是按 st.size 对应的窗口高记录的上边缘，直接用；之前减 (WIN_H - 满尺寸高)
  // 只在尺寸 < 1 时把窗口往下推（0.6 倍时偏 208px），贴顶位置重启后会丢。

  win = new BrowserWindow({
    x, y, width: WIN_W, height: WIN_H,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  const opRaw = settings && Number.isFinite(Number(settings.opacity))
    ? Number(settings.opacity)
    : (st && Number.isFinite(Number(st.opacity)) ? Number(st.opacity) : 1);
  petOpacity = Math.min(1, Math.max(0.05, opRaw));
  // 注意：不要用 win.setOpacity()。在 Windows 的透明窗口上调用它会把整窗渲染打成黑块，
  // 连 100% 都救不回来。透明度改由渲染进程对 #stage 设 CSS opacity 实现。
  logf('[opacity] restored', Math.round(petOpacity * 100) + '%');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  function calibrateDragScale() {
    win.webContents.executeJavaScript('window.devicePixelRatio || 1')
      .then(dpr => {
        DRAG_SCALE = Number(dpr) || 1;
        logf('[drag] DRAG_SCALE =', DRAG_SCALE);
      })
      .catch(() => { });
  }

  win.once('ready-to-show', () => {
    win.showInactive();
    ensureOnScreen();
    calibrateDragScale();
  });
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.send('set-size', currentSize()); } catch (e) { }
    try { win.webContents.send('ui-opacity', petOpacity); } catch (e) { }
    try { win.webContents.send('power-save', !!(settings && settings.powerSave)); } catch (e) { }
  });

  win.webContents.on('console-message', (_e, level, msg) => {
    logf('[renderer]', msg);
  });

  win.on('show', () => {
    try { win.webContents.send('shown'); } catch (e) { }
    try { win.webContents.send('perf', 'resume'); } catch (e) { }
  });
  win.on('hide', () => {
    // 隐藏时停渲染，别白烧 CPU/GPU
    try { win.webContents.send('perf', 'pause'); } catch (e) { }
    logf('[perf] hidden -> pause render');
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    logerr('[main] renderer gone', JSON.stringify(d));
    dumpCrash(new Error('render-process-gone ' + JSON.stringify(d)), 'render-process-gone');
  });
  win.on('move', onWindowMove);
  win.on('resize', () => { try { logf('[win] resize ->', JSON.stringify(win.getBounds()), new Error().stack.split('\\n')[2].trim()); } catch (e) { } });
  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------- 自定义协议：l2d://local/xxx
function registerModelProtocol() {
  protocol.handle('l2d', async (req) => {
    try {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const root = path.resolve(MODEL_ROOT);
      const abs = path.resolve(path.join(root, rel));
      if (!abs.startsWith(root)) return new Response('forbidden', { status: 403 });
      if (!fs.existsSync(abs)) return new Response('not found: ' + rel, { status: 404 });
      return net.fetch(pathToFileURL(abs).toString());
    } catch (e) {
      return new Response('error: ' + e.message, { status: 500 });
    }
  });
}

// ---------------------------------------------------------------- 拖拽
function dprLog(tag) {
  if (!win) return;
  win.webContents.executeJavaScript('JSON.stringify({dpr:devicePixelRatio,w:innerWidth,h:innerHeight,sx:screenX,sy:screenY})')
    .then(v => logf('[dpr]', tag, v)).catch(() => { });
}


// 可抓取范围：窗口底部（她站立的地方）必须留在屏幕内
// 左右按「她本人的可见包围盒」夹：窗口两侧有透明留白，按窗口夹会让她永远贴不到屏幕边
function clampToReachable(x, y, w, h) {
  const disp = screen.getDisplayNearestPoint({ x: x + w / 2, y: y + h / 2 });
  const db = disp.bounds;
  const body = petBox && petBox.w > 0 ? petBox : null;
  // 左：她的左边缘可以贴到屏幕左缘；右：她的右边缘可以贴到屏幕右缘
  const minX = body ? db.x - body.x : db.x - 60;
  const maxX = body ? db.x + db.width - (body.x + body.w) : db.x + db.width - 120;
  const minY = db.y - TOP_OVERHANG;             // 允许出屏一个气泡带，让她的头顶能贴到屏幕最顶
  const maxY = db.y + db.height - 160;          // 底部至少留 160px，保证身体可抓
  return {
    x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(y, minY), Math.max(minY, maxY))
  };
}

function beginDrag(pos) {
  if (dragStart) return;
  const b = win.getBounds();
  dragStart = {
    bx: b.x, by: b.y,
    // 按下时指针的绝对屏幕坐标：之后每一帧都按「起点 + 总位移」算目标位置，
    // 不再逐帧累加 dx —— Windows 会把 DIP 位置取整到物理像素，逐帧累加会让
    // 每帧漏掉 ~0.8 DIP，拖久了窗口就越跑越偏（"逐渐脱离鼠标"）
    cx0: pos && Number.isFinite(pos.sx) ? pos.sx : null,
    cy0: pos && Number.isFinite(pos.sy) ? pos.sy : null,
    // 指针相对「窗口底边中心」的位置。拖拽时窗口会被系统每帧撑大约 0.8px，
    // 而画布是贴窗口底的：按上边缘定位她会随着变高往下沉 —— 必须按底边定位
    bcx0: b.x + b.width / 2,
    bcy0: b.y + b.height,
    accX: 0, accY: 0,
    t0: Date.now(), lastT: Date.now(),
    shakeMs: 0, totalDist: 0,
    idleTimer: null
  };
  logf('[drag] begin window', b.x, b.y, 'cursor', dragStart.cx0, dragStart.cy0);
}

function endDrag() {
  logf('[main] drag end');
  let shakeMs = 0;
  let flung = false;
  let movedDist = 0;
  if (dragStart) {
    const b2 = win.getBounds();
    shakeMs = dragStart.shakeMs || 0;
    const dur = Math.max(100, Date.now() - dragStart.t0);
    const avgSpeed = (dragStart.totalDist || 0) / (dur / 1000);
    flung = !!dragStart.flinging;
    movedDist = Math.hypot(b2.x - dragStart.bx, b2.y - dragStart.by);
    logf('[main] drag stats windowDelta', b2.x - dragStart.bx, b2.y - dragStart.by,
         'dist', Math.round(dragStart.totalDist || 0), 'dur', dur,
         'avgSpeed', Math.round(avgSpeed), 'shakeMs', Math.round(shakeMs), 'flung', flung);
    if (dragStart.idleTimer) clearTimeout(dragStart.idleTimer);
  }
  dragStart = null;
  if (!win) return;
  if (movedDist > 40) onboardMilestone('drag');
  const dragInfo = { shakeMs: Math.round(shakeMs), flung };
  if (flung) {
    // 松手那一刻再续一次，保证尾迹从【松手】算 1 秒
    try { win.webContents.send('fling-hold', { avg: 0, release: true }); } catch (e) { }
    logf('[main] fling ended -> dizzy tail from release');
  }

  let b = win.getBounds();
  // 拖拽期间窗口会被系统逐帧撑大：先按「底边中心不动」收回标准尺寸，
  // 这样后面的夹取/吸附都按标准尺寸算，松手也不会弹一下
  const safeH0 = heightForSize(currentSize());
  if (Math.abs(b.width - WIN_W) > 0 || Math.abs(b.height - safeH0) > 0) {
    win.setBounds({
      x: Math.round(b.x + b.width / 2 - WIN_W / 2),
      y: Math.round(b.y + b.height - safeH0),
      width: WIN_W, height: safeH0
    }, false);
    WIN_H = safeH0;
    logf('[main] endDrag size normalized', b.width + 'x' + b.height, '->', WIN_W + 'x' + safeH0);
    b = win.getBounds();
  }
  const disp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const wa = disp.workArea;

  // 改成按"整块屏幕"限制：允许贴到屏幕边缘，但至少露出 MIN_VISIBLE
  const db = disp.bounds;
  const cl0 = clampToReachable(b.x, b.y, b.width, b.height);
  let nx = cl0.x;
  let ny = cl0.y;

  // 贴屏幕四边（8px 内吸附）。左右按她的可见边缘算，而不是窗口边缘
  const SNAP = 8;
  const body = petBox && petBox.w > 0 ? petBox : null;
  const leftDock = body ? db.x - body.x : db.x;
  const rightDock = body ? db.x + db.width - (body.x + body.w) : db.x + db.width - b.width;
  if (Math.abs(nx - leftDock) < SNAP) nx = leftDock;
  if (Math.abs(nx - rightDock) < SNAP) nx = rightDock;
  // 贴屏幕顶：吸附到「她真正贴顶」的位置（db.y - TOP_OVERHANG），而不是窗口 y=0
  // （y=0 时她头顶还空着一整个气泡带，看起来就是上不去）
  const topDock = db.y - TOP_OVERHANG;
  if (Math.abs(ny - topDock) < SNAP) ny = topDock;

  // 贴任务栏（保持 10px 内吸附，但不超过安全范围）
  const bottom = wa.y + wa.height - b.height;
  if (Math.abs(ny - bottom) < SNAP_DIST) ny = bottom;

  logf('[main] endDrag from', JSON.stringify({ x: b.x, y: b.y }), '->', JSON.stringify({ x: nx, y: ny }),
       'workArea', JSON.stringify(wa));

  // 尺寸已在上面归一，这里只移动，别碰尺寸（setBounds 带宽高会诱发撑大）
  win.setPosition(nx, ny, false);
  saveState({ x: nx, y: ny, size: currentSize() });
  if (dragInfo) {
    try { win.webContents.send('drag-end', dragInfo); } catch (e) { }
  }
}

// ---------------------------------------------------------------- 托盘
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  let img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('morichan');
  const rebuild = () => {
    // 所有设置项都已并入桌宠右键菜单的「设置」，托盘只保留一个入口
    const menu = Menu.buildFromTemplate([
      { label: '打开设置', click: () => showPetMenu() },
      { type: 'separator' },
      { label: '关闭桌宠', click: () => { logf('[tray] 关闭桌宠'); app.quit(); } }
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();
}

// ---------------------------------------------------------------- IPC
ipcMain.on('onboard', (_e, d) => {
  if (!d || !d.kind) return;
  onboardMilestone(d.kind);
});
ipcMain.on('mask', (_e, payload) => {
  if (!payload) return;
  alphaMask = Buffer.from(payload.bits);
  maskW = payload.w;
  maskH = payload.h;
});
ipcMain.on('set-ignore', (_e, ignore) => {
  // 穿透改由主进程轮询统一决定（避免两边打架），这里只记录渲染进程的意图
  if (win && win.__lastRendererIgnore !== !!ignore) {
    win.__lastRendererIgnore = !!ignore;
    logf('[ignore] renderer wants', !!ignore);
  }
});
ipcMain.on('probe', () => {
  if (win) logf('[main] probe ignore=', win.isIgnoringMouseEvents ? win.isIgnoringMouseEvents() : 'n/a');
});
ipcMain.on('drag-start', (_e, pos) => { rendererDragging = true; beginDrag(pos); });
// 之前只有 drag-start，没有 drag-end：松手靠 400ms 兜底才生效，
// 于是"按住停顿一下"就收尾、"再动"全被丢弃 —— 现在松手立刻收尾
ipcMain.on('drag-end', () => { rendererDragging = false; endDrag(); });
ipcMain.on('drag-by', (_e, d) => {
  if (!win || !d) return;
  const dx = Number(d.dx), dy = Number(d.dy);
  if (!isFinite(dx) || !isFinite(dy)) return;
  // 渲染进程只在左键按住时才会发 drag-by；如果拖拽中段被 400ms 兜底收尾了
  // （用户停顿了一下），这里以当前指针为新的基准重新接管，位移不会断
  if (!dragStart) {
    logf('[drag] resume after idle gap');
    // 基准退到本帧之前一格，这样"触发续拖的这一下位移"也算进去
    beginDrag({ sx: Number(d.sx) - dx, sy: Number(d.sy) - dy });
  }

  const now = Date.now();
  const dt = Math.max(8, now - dragStart.lastT) / 1000;
  dragStart.lastT = now;
  const speed = Math.hypot(dx, dy) / dt;
  dragStart.totalDist = (dragStart.totalDist || 0) + Math.hypot(dx, dy);

  // 滑动窗口（250ms）内的平均速度
  dragStart.samples = dragStart.samples || [];
  dragStart.samples.push({ t: now, d: Math.hypot(dx, dy) });
  while (dragStart.samples.length && now - dragStart.samples[0].t > 250) dragStart.samples.shift();
  let winD = 0;
  for (const smp of dragStart.samples) winD += smp.d;
  const winMs = Math.max(60, now - dragStart.samples[0].t);
  const avg = winD / (winMs / 1000);

  // 速度窗口（250ms）+ 持续性：只有连续 180ms 都超过阈值才算甩飞，单帧尖峰不算
  if (avg > FLING_ENTER) {
    if (!dragStart.fastSince) dragStart.fastSince = now;
  } else {
    dragStart.fastSince = 0;
  }
  const fastFor = dragStart.fastSince ? now - dragStart.fastSince : 0;

  if (!dragStart.flinging &&
      (dragStart.totalDist || 0) > FLING_MIN_TOTAL &&
      winD > FLING_MIN_WIN_D &&
      avg > FLING_ENTER &&
      fastFor >= FLING_HOLD_MS) {
    dragStart.flinging = true;
    dragStart.lastHold = now;
    try { win.webContents.send('fling-hold', { avg: Math.round(avg) }); } catch (e) { }
    logf('[fling] enter avg', Math.round(avg), 'winD', Math.round(winD), 'fastFor', fastFor, 'total', Math.round(dragStart.totalDist));
  } else if (dragStart.flinging) {
    if (avg < FLING_EXIT) {
      dragStart.flinging = false;
      dragStart.fastSince = 0;
      logf('[fling] exit avg', Math.round(avg));
    } else if (now - (dragStart.lastHold || 0) > 120) {
      dragStart.lastHold = now;
      try { win.webContents.send('fling-hold', { avg: Math.round(avg) }); } catch (e) { }
    }
  }

  // 兜底：如果 mouseup 丢了（窗口失焦等），静默 400ms 后自动收尾
  if (dragStart.idleTimer) clearTimeout(dragStart.idleTimer);
  dragStart.idleTimer = setTimeout(() => {
    if (dragStart) { logf('[drag] idle end'); endDrag(); }
  }, 400);

  const b = win.getBounds();
  let nx, ny;
  const sx = Number(d.sx), sy = Number(d.sy);
  if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(dragStart.cx0)) {
    // 绝对定位 + 底边锚定：目标 = 指针位置 - 按下时指针相对底边中心的偏移
    const offX = dragStart.cx0 - dragStart.bcx0;
    const offY = dragStart.cy0 - dragStart.bcy0;
    const wantCX = sx - offX;        // 期望的水平中心
    const wantBottom = sy - offY;    // 期望的底边
    const safeH = heightForSize(currentSize());
    const cl = clampToReachable(wantCX - WIN_W / 2, wantBottom - safeH, WIN_W, safeH);
    const wxr = Math.round(cl.x);
    const wyr = Math.round(cl.y);
    if (wxr !== b.x || wyr !== b.y || b.width !== WIN_W || b.height !== safeH) {
      // 位置和尺寸一起写：只调 setPosition 时窗口会被系统逐帧撑大（实测 640→656），
      // 撑大后画布虽然贴底但"限位/归一"会把它拉回来，表现为拖着往上走、松手往下掉
      win.setBounds({ x: wxr, y: wyr, width: WIN_W, height: safeH }, false);
    }
    return;
  } else {
    nx = b.x + dx + dragStart.accX;
    ny = b.y + dy + dragStart.accY;
  }

  const cl = clampToReachable(nx, ny, b.width, b.height);
  nx = cl.x; ny = cl.y;

  const rx = Math.round(nx), ry = Math.round(ny);
  dragStart.accX = nx - rx;
  dragStart.accY = ny - ry;
  if (rx !== b.x || ry !== b.y) win.setPosition(rx, ry, false);
});

ipcMain.on('drag-move', () => { /* 已改用 movement 增量 */ });

ipcMain.on('quit', () => app.quit());

ipcMain.on('ui-rects', (_e, d) => {
  if (!d) return;
  uiCanvas = d.canvas || null;
  uiDialog = d.dialog || null;
});
ipcMain.on('pet-box', (_e, b) => {
  if (!b || !(Number(b.w) > 0) || !(Number(b.h) > 0)) return;
  const next = { x: Number(b.x) || 0, y: Number(b.y) || 0, w: Number(b.w), h: Number(b.h) };
  const prev = petBox;
  petBox = next;
  // 呼吸/尾巴会让包围盒几像素抖动，只在明显变化时记日志
  if (!prev || Math.abs(prev.x - next.x) > 4 || Math.abs(prev.y - next.y) > 4 ||
      Math.abs(prev.w - next.w) > 4 || Math.abs(prev.h - next.h) > 4) {
    logf('[box] pet visible box', JSON.stringify(petBox));
  }
});

ipcMain.on('motions', (_e, list) => {
  motionCatalog = Array.isArray(list) ? list : [];
  logf('[menu] catalog received:', motionCatalog.length);
});

// 读取打包进安装包的署名文件（开发态回退到仓库根目录）
function attributionText() {
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'ATTRIBUTION.txt'));
  try { cands.push(path.join(app.getAppPath(), 'ATTRIBUTION.txt')); } catch (e) { }
  cands.push(path.join(__dirname, '..', 'ATTRIBUTION.txt'));
  for (const p of cands) {
    try {
      const t = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      if (t.trim()) return t.trim();
    } catch (e) { }
  }
  return '模型、动作、台词来自《狐姬零》(AsicxArt)';
}

function showAbout() {
  const body = attributionText();
  logf('[menu] 关于');
  try {
    dialog.showMessageBox(win || undefined, {
      type: 'info',
      title: '关于 灵狐召唤器',
      message: '灵狐召唤器 v' + app.getVersion(),
      detail: body,
      buttons: ['好'],
      noLink: true
    });
  } catch (e) { logerr('[menu] 关于失败', e.message); }
}

// 组装桌宠右键菜单（托盘里的「打开设置」也复用它）
function petMenuTemplate() {
  const groups = new Map();
  for (const m of motionCatalog) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  const order = ['Idle', 'TapHead', 'TapBody', 'TapTail', 'TapFace', 'Story'];
  const titleOf = {
    Idle: '待机', TapHead: '摸头', TapBody: '戳身体',
    TapTail: '拽尾巴', TapFace: '表情 / 特殊', Story: '剧情动作'
  };
  const template = [];
  for (const g of order) {
    if (!groups.has(g)) continue;
    template.push({
      label: titleOf[g] || g,
      submenu: groups.get(g).map(m => ({
        label: m.label,
        click: () => { try { win.webContents.send('play-motion', m); } catch (e) { } }
      }))
    });
  }
  template.push({ type: 'separator' });

  const opacityItem = (v, label) => ({
    label, type: 'radio',
    checked: Math.abs(petOpacity - v) < 0.01,
    click: () => setOpacity(v)
  });

  // 「设置」：尺寸 / 透明度 + 原托盘菜单的全部条目
  template.push({
    label: '设置',
    submenu: [
      {
        label: '大小',
        submenu: [
          { label: '小（75%）', click: () => applySize(0.75) },
          { label: '正常（100%）', click: () => applySize(1) },
          { label: '大（125%）', click: () => applySize(1.25) },
          { label: '超大（150%）', click: () => applySize(1.5) },
          { type: 'separator' },
          { label: '更小（60%）', click: () => applySize(0.6) },
          { label: '更大（175%）', click: () => applySize(1.75) }
        ]
      },
      {
        label: '透明度',
        submenu: [
          opacityItem(0.25, '25%'),
          opacityItem(0.5, '50%'),
          opacityItem(0.75, '75%'),
          opacityItem(1, '100%')
        ]
      },
      { type: 'separator' },
      {
        label: '置顶', type: 'checkbox', checked: alwaysOnTop,
        click: (item) => { alwaysOnTop = item.checked; if (win) win.setAlwaysOnTop(alwaysOnTop, 'screen-saver'); }
      },
      {
        label: '眨眼', type: 'checkbox', checked: !win || !win.__noBlink,
        click: (item) => {
          if (!win) return;
          win.__noBlink = !item.checked;
          win.webContents.executeJavaScript('window.__noBlink = ' + JSON.stringify(!!win.__noBlink) + '; String(window.__noBlink)')
            .then(v => logf('[tray] noBlink =', v)).catch(e => logerr('[tray]', e.message));
        }
      },
      {
        label: '开机自启', type: 'checkbox', checked: !!(settings && settings.autoLaunch),
        click: (item) => {
          const want = !!item.checked;
          saveSettings({ autoLaunch: want });
          const real = syncAutoLaunch(want);
          item.checked = want;
          if (real !== want) logerr('[autolaunch] 已记录为', want, '但系统注册表未生效');
        }
      },
      {
        label: '是否打开节能模式', type: 'checkbox', checked: !!(settings && settings.powerSave),
        click: (item) => setPowerSave(item.checked)
      },
      { type: 'separator' },
      { label: '把她叫回任务栏（救回）', click: () => rescueWindow('tray') },
      {
        label: '新手引导', click: () => {
          if (!win) return;
          onboardStart(600);
          win.showInactive();
        }
      },
      { label: '重新载入', click: () => win && win.reload() },
      { label: '开发者工具', click: () => win && win.webContents.openDevTools({ mode: 'detach' }) },
      { label: '关于', click: () => showAbout() },
      { type: 'separator' },
      { label: '关闭桌宠', click: () => { logf('[menu] 关闭桌宠'); app.quit(); } }
    ]
  });

  template.push({ label: '喂她吃东西', click: () => { try { win.webContents.send('play-line', 'eat'); } catch (e) { } } });
  template.push({ label: '剧情模式（说一句重话）', click: () => { try { win.webContents.send('play-line', 'story'); } catch (e) { } } });
  template.push({
    label: '重启', click: () => {
      logf('[menu] 重启');
      app.relaunch();
      app.quit();
    }
  });
  template.push({ type: 'separator' });
  template.push({ label: '关闭桌宠', click: () => { logf('[menu] 关闭桌宠'); app.quit(); } });
  template.push({ label: '关闭菜单', enabled: false });
  return template;
}

function showPetMenu() {
  if (!win) return;
  Menu.buildFromTemplate(petMenuTemplate()).popup({ window: win });
  logf('[menu] opened with', motionCatalog.length, 'items');
}

ipcMain.on('open-menu', () => {
  if (!win) return;
  onboardMilestone('menu');
  showPetMenu();
});
ipcMain.on('debug-drag-start', () => beginDrag());
ipcMain.on('debug-drag-end', () => endDrag());
ipcMain.on('log', (_e, msg) => logf('[pet]', msg));
ipcMain.on('show-menu-dev', () => {});
ipcMain.handle('get-size', () => currentSize());
ipcMain.handle('get-opacity', () => petOpacity);
ipcMain.handle('get-power-save', () => !!(settings && settings.powerSave));

ipcMain.handle('get-config', () => ({
  modelUrl: 'l2d://local/' + MODEL_ENTRY.split('/').map(encodeURIComponent).join('/'),
  modelRoot: MODEL_ROOT
}));

// ---------------------------------------------------------------- lifecycle
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

app.whenReady().then(() => {
  registerModelProtocol();
  createWindow();

  // 全局热键：Ctrl+Alt+M 开关她（隐藏/显示）
  try {
    globalShortcut.register('Control+Alt+M', () => toggleVisible());
    globalShortcut.register('Control+Alt+R', () => rescueWindow('hotkey'));
    logf('[hotkey] Control+Alt+M registered, Control+Alt+R rescue');
  } catch (e) { logerr('[hotkey]', e.message); }

  createTray();
  logf('[main] model root =', MODEL_ROOT);
  logf('[main] model entry =', MODEL_ENTRY);

  // 内存基线：每 5 分钟记一次主进程 RSS + 渲染进程 JS 堆，方便 8 小时长跑观察是否增长
  setInterval(() => {
    try {
      const rss = Math.round(process.memoryUsage().rss / 1048576);
      logf('[mem] main rss=' + rss + 'MB');
    } catch (e) { }
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.executeJavaScript(
          'JSON.stringify({heapMB: (performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1)})'
        ).then(v => logf('[mem] renderer', v)).catch(() => { });
      }
    } catch (e) { }
  }, 5 * 60 * 1000);

  // 开机自启：把 OS 状态对齐到 settings
  syncAutoLaunch(!!(settings && settings.autoLaunch));

  // 首启引导：等召唤演出结束再说第一句
  if (settings && !settings.onboardingDone) {
    win.webContents.once('did-finish-load', () => onboardStart(3200));
  }

  // 自检截图：MORI_SHOT=<png 路径> 时延迟截取窗口内容（不受窗口遮挡影响）
  if (process.env.MORI_PARAMDUMP) {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript('JSON.stringify(window.__dumpParams ? window.__dumpParams() : null)');
        logf('[params]', r);
      } catch (e) { logerr('[params]', e.message); }
    }, 7000);
  }

  if (process.env.MORI_BURST) {
    const prefix = process.env.MORI_BURST;
    setTimeout(async () => {
      for (let i = 0; i < 6; i++) {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(prefix + '_' + i + '.png', img.toPNG());
        } catch (e) { logerr('[burst] fail', e.message); }
        await new Promise(r => setTimeout(r, 130));
      }
      logf('[burst] done', prefix);
    }, Number(process.env.MORI_BURST_DELAY || 9000));
  }

  if (process.env.MORI_DRAGTEST) {
    setTimeout(() => {
      logf('[dragtest] before', JSON.stringify(win.getBounds()));
      beginDrag();
      logf('[dragtest] begin, cursor', JSON.stringify(screen.getCursorScreenPoint()));
    }, 8000);
    setTimeout(() => {
      logf('[dragtest] during', JSON.stringify(win.getBounds()), 'cursor', JSON.stringify(screen.getCursorScreenPoint()));
    }, 10500);
    setTimeout(() => {
      endDrag();
      logf('[dragtest] after', JSON.stringify(win.getBounds()));
    }, 12500);
  }

  if (process.env.MORI_TESTREACT) {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript('window.__react && window.__react(' + JSON.stringify(process.env.MORI_TESTREACT) + '); "ok"');
        logf('[testreact]', process.env.MORI_TESTREACT, r);
      } catch (e) { logerr('[testreact]', e.message); }
    }, 8000);
  }

  if (process.env.MORI_SYNTHMOVE) {
    setTimeout(async () => {
      try {
        const before = win.getBounds();
        logf('[synth2] before', JSON.stringify(before));
        const script = `(() => {
          const cv = document.querySelector('#stage canvas');
          const r = cv.getBoundingClientRect();
          const x = r.left + r.width * 0.5;
          const y = r.top + r.height * 0.72;
          const mk = (type, extra) => new MouseEvent(type, Object.assign({
            bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1
          }, extra || {}));
          window.dispatchEvent(mk('mousedown'));
          for (let i = 0; i < 12; i++) {
            window.dispatchEvent(mk('mousemove', { movementX: 30, movementY: 12 }));
          }
          window.dispatchEvent(mk('mouseup', { buttons: 0 }));
          return JSON.stringify({ x, y });
        })()`;
        const r = await win.webContents.executeJavaScript(script);
        logf('[synth2] dispatched at', r);
        setTimeout(() => logf('[synth2] after', JSON.stringify(win.getBounds())), 600);
      } catch (e) { logerr('[synth2]', e.message); }
    }, 8500);
  }

  if (process.env.MORI_SYNTHDRAG) {
    setTimeout(() => {
      try {
        const before = win.getBounds();
        logf('[synth] before', JSON.stringify(before));
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 190, y: 300 });
        setTimeout(() => win.webContents.sendInputEvent({ type: 'mouseDown', x: 190, y: 300, button: 'left', clickCount: 1 }), 100);
        let i = 0;
        const timer = setInterval(() => {
          i++;
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 190 + i * 10, y: 300 + i * 7, button: 'left' });
          if (i >= 15) {
            clearInterval(timer);
            win.webContents.sendInputEvent({ type: 'mouseUp', x: 190 + i * 10, y: 300 + i * 7, button: 'left', clickCount: 1 });
            setTimeout(() => logf('[synth] after', JSON.stringify(win.getBounds())), 500);
          }
        }, 40);
      } catch (e) { logerr('[synth]', e.message); }
    }, 8000);
  }

  if (process.env.MORI_UIPROBE) {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(`(() => {
          const st = document.getElementById('stage');
          const cs = getComputedStyle(st);
          const el = document.elementFromPoint(190, window.innerHeight - 100);
          const cv = document.querySelector('#stage canvas');
          return JSON.stringify({
            stageRegion: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
            stageRect: st.getBoundingClientRect().toJSON(),
            canvasRegion: cv ? (getComputedStyle(cv).webkitAppRegion || 'none') : 'no canvas',
            elemAt: el ? (el.id || el.tagName) : 'none',
            elemRegion: el ? (getComputedStyle(el).webkitAppRegion || 'none') : '-',
            innerSize: [innerWidth, innerHeight]
          });
        })()`);
        logf('[uiprobe]', r);
      } catch (e) { logerr('[uiprobe]', e.message); }
    }, 8000);
  }

  if (process.env.MORI_RESCUE) {
    setTimeout(() => {
      try { rescueWindow('test'); } catch (e) { logerr('[rescue test]', e.message); }
    }, 7000);
  }

  if (process.env.MORI_TESTSIZE) {
    setTimeout(() => {
      applySize(Number(process.env.MORI_TESTSIZE)); logf('[test] size', process.env.MORI_TESTSIZE);
    }, 8000);
  }

  if (process.env.MORI_TESTPLAY) {
    setTimeout(() => {
      const parts = String(process.env.MORI_TESTPLAY).split(':');
      const g = parts[0]; const i = parts[1]; const dd = Number(parts[2] ? parts[2] : 2.5);
      try { win.webContents.send('play-motion', { group: g, idx: Number(i), dur: dd, label: 'test' }); logf('[test] play', g, i); } catch (e) { logerr('[test]', e.message); }
    }, 8000);
  }

  if (process.env.MORI_SELFTEST) {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript('window.__selftest ? window.__selftest() : {err:"no hook"}');
        logf('[selftest]', JSON.stringify(r));
      } catch (e) { logerr('[selftest]', e.message); }
    }, 7000);
  }

  if (process.env.MORI_SHOT) {
    const delay = Number(process.env.MORI_SHOT_DELAY || 6000);
    const shoot = async (path) => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path, img.toPNG());
      logf('[main] shot saved', path, JSON.stringify(img.getSize()));
    };
    setTimeout(async () => {
      try {
        await shoot(process.env.MORI_SHOT);
        if (process.env.MORI_SHOT_B) {
          setTimeout(async () => {
            try { await shoot(process.env.MORI_SHOT_B); } catch (e) { logerr('[main] shotB failed', e.message); }
          }, 400);
        }
      } catch (e) {
        logerr('[main] shot failed', e.message);
      }
    }, delay);
  }
});


// ---------------------------------------------------------------- 原生拖拽监测
// #stage 上有 -webkit-app-region: drag，窗口由 Windows 直接移动（1:1，无延迟）。
// 代价：渲染进程收不到 mousedown/mouseup，所以这里用"窗口是否真的移动"来区分
// 拖拽 / 点击，并在静止 200ms 后收尾。
const nativeDrag = { on: false, startX: 0, startY: 0, lastMoveAt: 0, lastB: null, lastT: 0, shakeMs: 0 };

function onWindowMove() {
  if (!win) return;
  const b = win.getBounds();
  if (!nativeDrag.on) {
    nativeDrag.on = true;
    nativeDrag.startX = b.x;
    nativeDrag.startY = b.y;
    logf('[native] drag start at', b.x, b.y);
  }
  nativeDrag.lastMoveAt = Date.now();

  // 摇晃检测：窗口位移速度（DIP/秒）
  const now = Date.now();
  if (nativeDrag.lastB) {
    const dx = b.x - nativeDrag.lastB.x;
    const dy = b.y - nativeDrag.lastB.y;
    const dt = Math.max(16, now - nativeDrag.lastT) / 1000;
    const speed = Math.hypot(dx, dy) / dt;
    if (speed > 1200) nativeDrag.shakeMs += dt * 1000;
    else nativeDrag.shakeMs = Math.max(0, nativeDrag.shakeMs - dt * 200);
  }
  nativeDrag.lastB = { x: b.x, y: b.y };
  nativeDrag.lastT = now;
}

function finishNativeDrag(reason) {
  if (!nativeDrag.on) return;
  nativeDrag.on = false;
  const shakeMs = nativeDrag.shakeMs;
  nativeDrag.shakeMs = 0;
  nativeDrag.lastB = null;
  const b = win.getBounds();
  const dx = b.x - nativeDrag.startX;
  const dy = b.y - nativeDrag.startY;
  const dist = Math.hypot(dx, dy);
  logf('[native] drag end', reason, 'dist', Math.round(dist));

  if (dist < 6) {
    // 基本没动 → 当作点击，把"窗口内相对位置（比例，单位无关）"回传给渲染进程
    const c = screen.getCursorScreenPoint();
    const fx = (c.x - b.x) / b.width;
    const fy = (c.y - b.y) / b.height;
    if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
      try { win.webContents.send('tap', { fx, fy }); } catch (e) { }
      logf('[native] tap at', fx.toFixed(3), fy.toFixed(3));
    }
  } else {
    if (shakeMs > 300) {
      try { win.webContents.send('shake-dizzy', { ms: Math.round(Math.min(shakeMs, 4600)) }); } catch (e) { }
      logf('[native] shake dizzy', Math.round(shakeMs), 'ms');
    }
    // 拖拽结束：夹回屏幕 + 记住位置
    const disp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const db = disp.bounds;
    const nx = Math.min(Math.max(b.x, db.x - (b.width - MIN_VISIBLE)), db.x + db.width - MIN_VISIBLE);
    const ny = Math.min(Math.max(b.y, db.y - (b.height - MIN_VISIBLE)), db.y + db.height - MIN_VISIBLE);
    if (nx !== b.x || ny !== b.y) win.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
    saveState(Object.assign({ x: nx, y: ny }, { size: currentSize() }));
  }
}

// 原生拖拽方案已弃用（透明窗口不支持 app-region 拖拽），保留函数但不再触发
function nativeDisabled() { }

setInterval(watchdog, 800);

// 光标轮询：只负责【视线跟随】。穿透由渲染进程用 clientX 判定（同一坐标系，不会错位）
let lastCursor = { x: -1, y: -1 };
setInterval(() => {
  try {
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    if (c.x !== lastCursor.x || c.y !== lastCursor.y) {
      lastCursor = c;
      win.webContents.send('cursor', { x: c.x - b.x, y: c.y - b.y, w: b.width, h: b.height });
    }

    // 穿透：光标在窗口矩形内（留 2px 余量）就接收鼠标事件；按住拖动期间一律保持接收
    const M = 2;
    const inside = c.x >= b.x - M && c.x <= b.x + b.width + M && c.y >= b.y - M && c.y <= b.y + b.height + M;
    const wantIgnore = !inside && !rendererDragging;
    if (win.__ignoreState !== wantIgnore) {
      win.__ignoreState = wantIgnore;
      win.setIgnoreMouseEvents(wantIgnore, { forward: true });
      logf('[ignore]', wantIgnore ? 'pass-through' : 'receive', 'cursor', c.x, c.y, 'win', b.x, b.y, b.width, b.height);
    }
  } catch (e) {
    logerr('[poll]', e && e.message ? e.message : String(e));
  }
}, 60);

// 外部触发截图：写一个文本文件到 .tmp/shoot.req（内容为目标路径），主进程截图后删除
setInterval(async () => {
  if (!win || win.isDestroyed()) return;
  const reqFile = path.join(__dirname, '..', '.tmp', 'shoot.req');
  try {
    if (!fs.existsSync(reqFile)) return;
    const target = fs.readFileSync(reqFile, 'utf8').trim();
    fs.unlinkSync(reqFile);
    if (!target) return;
    const img = await win.webContents.capturePage();
    fs.writeFileSync(target, img.toPNG());
    logf('[shoot] saved', target);
  } catch (e) {
    try { fs.unlinkSync(path.join(__dirname, '..', '.tmp', 'shoot.req')); } catch { }
    logerr('[shoot]', e.message);
  }
}, 250);

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (e) { }
});

app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (e) => {
  logerr('[main] uncaught', e && (e.stack || String(e)));
  dumpCrash(e, 'uncaughtException');
});
process.on('unhandledRejection', (e) => {
  logerr('[main] unhandledRejection', e && (e.stack || String(e)));
  dumpCrash(e, 'unhandledRejection');
});
