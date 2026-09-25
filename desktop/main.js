/* Gather desktop apps – a window onto https://gathercall.uk (or letsquiz.uk).
 *
 * Three apps come from this one file (see builder-*.json):
 *   - Gather (Windows): the whole site, for hosting calls and quiz night;
 *   - Let's Quiz (Windows and Mac): straight onto the join-only quiz page;
 *   - Let's Quiz Host (Windows): the quiz builder and host screen at
 *     https://letsquiz.uk. Its "Launch the quiz call" button shares this
 *     window and its sound into the quiz call with no picker: one click.
 *
 * The site does the work. This wrapper adds what a browser tab can't:
 *   - its own screen picker (Electron has none built in), with an option to
 *     send the computer's sound along, so quiz music and videos are heard;
 *   - camera and microphone allowed for gathercall.uk only, without prompts;
 *   - links to anywhere else (and file downloads) open in the normal browser;
 *   - a menu with Home and Quiz night (host), and one window at a time.
 */
'use strict';
const { app, BrowserWindow, Menu, session, desktopCapturer, shell, ipcMain, systemPreferences } = require('electron');
const path = require('path');

// The quiz and host builds set gatherApp.quiz / gatherApp.host in their packaged package.json.
const FLAGS = require('./package.json').gatherApp || {};
const HOST = !!FLAGS.host;
const QUIZ = !HOST && !!FLAGS.quiz;
const NAME = HOST ? 'Let\'s Quiz Host' : QUIZ ? 'Let\'s Quiz' : 'Gather';
const SITE = HOST ? 'https://letsquiz.uk' : 'https://gathercall.uk';
const OWN = HOST ? [SITE, 'https://www.letsquiz.uk'] : [SITE];
const HOME = SITE + (HOST ? '/' : QUIZ ? '/quiz/' : '/');
const QUIZ_HOST = 'https://gathercall.uk/?room=lets-quiz';
const ICON = path.join(__dirname, HOST ? 'host-icon.ico' : QUIZ ? 'quiz-icon.ico' : 'icon.ico');
const MAC = process.platform === 'darwin';
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

const isOwn = url => { try { return OWN.includes(new URL(url).origin); } catch { return false; } };

// What the app's own site may use. Everything else, and every other site, is refused.
const ALLOWED = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read', 'notifications', 'wake-lock', 'screen-wake-lock', 'speaker-selection']);

function offlinePage() {
  const html = '<!doctype html><meta charset="utf-8"><title>' + NAME + '</title><style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0f1412;color:#fff;font:16px "Segoe UI",sans-serif;text-align:center}button{margin-top:18px;padding:12px 22px;border:0;border-radius:12px;background:#12805f;color:#fff;font:600 16px "Segoe UI",sans-serif;cursor:pointer}p{color:#9aa39e}</style>' +
    '<div><h1>' + NAME + ' can\'t connect</h1><p>Check the internet connection, then try again.</p><button onclick="location.href=\'' + HOME + '\'">Try again</button></div>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

const WINDOW_OPTIONS = () => ({
  width: 1280, height: 820, minWidth: 360, minHeight: 520,
  title: NAME,
  backgroundColor: HOST ? '#1a0f3d' : '#0f1412',
  icon: MAC ? undefined : ICON,
  autoHideMenuBar: true,
  // The quiz timers and the shared picture must keep going when the window is behind others.
  webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false }
});

// Links: the app's own pages stay in the app, everything else opens in the
// normal browser. In the host app the builder opens the host screen as a new
// tab, which becomes a second app window (put it on the TV or a second screen).
function guard(wc, own) {
  wc.setWindowOpenHandler(({ url }) => {
    if (HOST && isOwn(url)) return { action: 'allow', overrideBrowserWindowOptions: Object.assign(WINDOW_OPTIONS(), { width: 1400, height: 860 }) };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', child => {
    child.setMenuBarVisibility(false);
    guard(child.webContents, child);
  });
  wc.on('will-navigate', (e, url) => {
    if (isOwn(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3 && !own.isDestroyed()) own.loadURL(offlinePage()); // -3 is a cancelled load, not a failure
  });
}

function createWindow() {
  win = new BrowserWindow(WINDOW_OPTIONS());
  win.loadURL(HOME);
  guard(win.webContents, win);
  win.on('closed', () => { win = null; });
}

// ---------- screen picker ----------
function pickSource(audioRequested) {
  return new Promise(async resolve => {
    let sources;
    try { sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } }); }
    catch { return resolve(null); }
    const list = sources
      .filter(s => !win || win.isDestroyed() || s.id !== win.getMediaSourceId()) // not this window itself
      .map(s => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL() }));
    const picker = new BrowserWindow({
      parent: win, modal: true, show: false,
      width: 820, height: 600, minWidth: 520, minHeight: 420,
      minimizable: false, maximizable: false,
      title: 'Share your screen', backgroundColor: '#0f1412', autoHideMenuBar: true,
      icon: MAC ? undefined : ICON,
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true }
    });
    picker.setMenu(null);
    let done = false;
    const finish = choice => {
      if (done) return;
      done = true;
      ipcMain.removeHandler('picker:sources');
      ipcMain.removeAllListeners('picker:choose');
      if (!picker.isDestroyed()) picker.close();
      resolve(choice);
    };
    ipcMain.handle('picker:sources', () => ({ list, sound: !!audioRequested && process.platform === 'win32' }));
    ipcMain.on('picker:choose', (e, id, sound) => {
      const s = sources.find(x => x.id === id);
      finish(s ? { source: s, sound: !!sound } : null);
    });
    picker.on('closed', () => finish(null));
    picker.once('ready-to-show', () => picker.show());
    picker.loadFile(path.join(__dirname, 'picker.html'));
  });
}

app.whenReady().then(async () => {
  // A Mac asks the person once for the camera and microphone, for the app itself.
  if (MAC) {
    for (const kind of ['camera', 'microphone']) {
      try { await systemPreferences.askForMediaAccess(kind); } catch {}
    }
  }
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(isOwn((details && details.requestingUrl) || wc.getURL()) && ALLOWED.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => isOwn(origin) && ALLOWED.has(permission));
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!isOwn(request.securityOrigin)) return callback(null);
    // The host app only ever shares itself: the quiz screen and its own sound
    // (music, sound effects), never the rest of the computer. No picker.
    if (HOST) {
      const frame = request.frame;
      if (!frame) return callback(null);
      return callback(request.audioRequested ? { video: frame, audio: frame } : { video: frame });
    }
    pickSource(request.audioRequested).then(choice => {
      if (!choice) return callback(null); // closed or cancelled: the page carries on without sharing
      const streams = { video: choice.source };
      // Windows can send everything the computer plays ("loopback").
      if (choice.sound && request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    }).catch(() => callback(null));
  });

  const siteItems = HOST ? [
    { label: 'Quiz builder', accelerator: 'Alt+Home', click: () => win && win.loadURL(HOME) },
    { label: 'Open the quiz call page', click: () => shell.openExternal('https://gathercall.uk/quiz/') },
    { type: 'separator' }
  ] : QUIZ ? [] : [
    { label: 'Home', accelerator: 'Alt+Home', click: () => win && win.loadURL(HOME) },
    { label: 'Quiz night (host)', click: () => win && win.loadURL(QUIZ_HOST) },
    { type: 'separator' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(MAC ? [{ role: 'appMenu' }] : []),
    {
      label: MAC ? 'View' : NAME,
      submenu: [
        ...siteItems,
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        ...(MAC ? [] : [{ type: 'separator' }, { role: 'quit', accelerator: 'Alt+F4' }])
      ]
    },
    { role: 'editMenu' },
    ...(MAC ? [{ role: 'windowMenu' }] : [])
  ]));

  createWindow();
});

app.on('window-all-closed', () => app.quit());
