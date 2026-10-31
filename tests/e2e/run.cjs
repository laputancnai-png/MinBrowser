// End-to-end test: drives the real app through first-run setup, browsing,
// history, bookmarks, passwords, ad blocking, downloads, Chrome import,
// locking, restart and password change.
//
//   npm run test:e2e                     # against the dev build
//   PACKAGED=out/linux-unpacked/minbrowser npm run test:e2e
//                                        # against a package built with the
//                                        # inspect fuse on (see docs/RELEASING.md)
//
// On Linux without a display, wrap it: xvfb-run -a npm run test:e2e
const { _electron } = require('playwright-core');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'minbrowser-e2e-'));
const HOME = path.join(TMP, 'home');
const DATA = path.join(TMP, 'data');
const DL = path.join(TMP, 'downloads');
const PORT = 8790 + Math.floor(Math.random() * 100);
const SITE = `localhost:${PORT}`;
const PW = 'correct horse battery staple';
const PW2 = 'new master password 2026';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let total = 0;
function check(name, ok, detail = '') {
  total++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------------ fixtures

function startServer() {
  const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = (s) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(s);
    };
    if (url.pathname === '/login')
      return html(page('Login Page', '<form method="post" action="/welcome"><input name="user" autocomplete="username" id="u"><input type="password" name="pw" id="p"><button id="go">Sign in</button></form>'));
    if (url.pathname === '/welcome') {
      req.resume();
      return req.on('end', () => html(page('Welcome', '<h1>Welcome</h1>')));
    }
    if (url.pathname === '/tracked')
      return html(page('Tracked Page 隐私测试', '<img src="https://www.google-analytics.com/collect?v=1"><script src="https://connect.facebook.net/en_US/fbevents.js"></script><img src="https://stats.g.doubleclick.net/x.gif">'));
    if (url.pathname === '/file') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"' });
      return res.end('downloaded-content');
    }
    if (url.pathname.startsWith('/page/')) {
      const n = Number(url.pathname.split('/')[2]);
      return html(page(`Page ${n}`, `<a id="next" href="/page/${n + 1}?utm_source=test&keep=1">next</a>`));
    }
    html(page('Home', 'home'));
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

function fakeChromeProfile() {
  const base = process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome') : path.join(HOME, '.config', 'google-chrome');
  fs.mkdirSync(path.join(base, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(base, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: '个人' } } } }));
  fs.writeFileSync(
    path.join(base, 'Default', 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: { children: [{ type: 'url', name: 'Chrome Bar Link', url: 'https://bar.example/' }, { type: 'folder', name: 'Dev', children: [{ type: 'url', name: 'MDN', url: 'https://developer.mozilla.org/' }] }] },
        other: { children: [{ type: 'url', name: 'Other Link', url: 'https://other.example/' }] },
      },
    }),
  );
}

// ------------------------------------------------------------------ driver

async function launch() {
  const packaged = process.env.PACKAGED;
  const args = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const app = await _electron.launch({
    executablePath: packaged ? path.resolve(packaged) : require(path.join(ROOT, 'node_modules', 'electron')),
    args: packaged ? args : [...args, ROOT],
    // A throwaway HOME keeps the test away from your real data and Chrome profile.
    env: { ...process.env, HOME, XDG_CONFIG_HOME: path.join(HOME, '.config') },
  });
  const ui = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1280, height: 800 }));
  const cmd = (name, ...a) => ui.evaluate(([n, x]) => window.minbrowser.command(n, ...x), [name, a]);
  const inTab = (part, js) =>
    app.evaluate(
      async ({ webContents }, [part, js]) => {
        const w = webContents.getAllWebContents().find((w) => w.getURL().includes(part) && !w.getURL().startsWith('file:'));
        return w ? w.executeJavaScript(js, true) : '__no_tab__';
      },
      [part, js],
    );
  const go = async (url, ms = 1200) => {
    await ui.fill('#address', url);
    await ui.press('#address', 'Enter');
    await wait(ms);
  };
  const mockDialog = (dir) =>
    app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, dir);
  const captureMenus = () =>
    app.evaluate(({ Menu }) => {
      const orig = Menu.buildFromTemplate;
      Menu.buildFromTemplate = (t) => {
        const m = orig.call(Menu, t);
        globalThis.__menu = { t, m };
        return m;
      };
    });
  const clickMenuItem = (i) =>
    app.evaluate((_, i) => {
      const { t, m } = globalThis.__menu;
      m.closePopup();
      t[i].click();
      return t.map((x) => x.label);
    }, i);
  return { app, ui, cmd, inTab, go, mockDialog, captureMenus, clickMenuItem };
}

function plaintextLeaks(needles) {
  const leaks = [];
  for (const f of fs.readdirSync(DATA)) {
    const p = path.join(DATA, f);
    if (!fs.statSync(p).isFile()) continue;
    const buf = fs.readFileSync(p);
    for (const n of needles) if (buf.includes(n)) leaks.push(`${f}:${n}`);
  }
  return leaks;
}

// ------------------------------------------------------------------ scenarios

async function firstRun() {
  const { app, ui, cmd, inTab, go, mockDialog, captureMenus, clickMenuItem } = await launch();
  await ui.waitForSelector('#setup:not([hidden])');
  check('first run shows setup', true);

  await mockDialog(DATA);
  await ui.click('#setup-choose');
  await ui.waitForSelector('#setup-form:not([hidden])');
  await ui.fill('#setup-pw', PW);
  await ui.fill('#setup-pw2', PW);
  await ui.fill('#setup-phrase', '我明白');
  await ui.click('#setup-create');
  await wait(300);
  check('wrong confirmation phrase rejected', (await ui.textContent('#setup-error')).includes('以确认'));
  await ui.fill('#setup-phrase', '我明白忘记密码将无法恢复');
  await ui.click('#setup-create');
  await ui.waitForSelector('#chrome:not([hidden])', { timeout: 15000 });
  check('vault created and browser unlocked', fs.existsSync(path.join(DATA, 'vault.meta')));

  await go(`${SITE}/page/1`);
  await inTab('/page/1', "document.getElementById('next').click()");
  await wait(1200);
  await go(`${SITE}/tracked`, 2000);
  check('trackers blocked and counted', Number(await ui.textContent('#shield .badge')) >= 3);
  await ui.click('#star');
  await wait(300);
  check('star bookmarks the page', await ui.$eval('#star', (b) => b.classList.contains('on')));
  check('bookmark shows in the bar', (await ui.textContent('#bookmarks-bar')).includes('Tracked Page'));

  await go(`${SITE}/login`);
  check('key button shown on login form', !(await ui.$eval('#key', (b) => b.hidden)));
  await inTab('/login', "u.value='alice'; p.value='s3cret-pass-XYZ'; go.click()");
  await wait(1500);
  check('save-password bar appears', !(await ui.$eval('#infobar', (b) => b.hidden)));
  await ui.click('#pw-save');
  await wait(300);

  await go(`${SITE}/login`);
  await captureMenus();
  await cmd('passwordMenu', 10, 10);
  await wait(300);
  const labels = await clickMenuItem(0);
  await wait(400);
  check('password menu lists the saved login', labels[0] === '填充 alice', JSON.stringify(labels));
  check('saved login filled', (await inTab('/login', "u.value + '|' + p.value")) === 'alice|s3cret-pass-XYZ');
  check('web pages get no internal API', (await inTab('/login', 'typeof window.min')) === 'undefined');

  await cmd('toggleRecording');
  await wait(200);
  check('paused indicator visible', (await ui.textContent('#record')).includes('已暂停'));
  await go(`${SITE}/page/99`);
  await cmd('toggleRecording');

  await cmd('openPage', 'settings');
  await wait(1200);
  fs.mkdirSync(DL, { recursive: true });
  await mockDialog(DL);
  await inTab('min://settings', "window.min.call('settings.chooseDownloadDir')");
  await go(`${SITE}/file`, 2000);
  const file = path.join(DL, 'report.txt');
  check('download saved to the chosen folder', fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'downloaded-content');

  await cmd('openPage', 'bookmarks');
  await wait(1200);
  const profiles = await inTab('min://bookmarks', "window.min.call('bookmarks.profiles')");
  check('Chrome profile detected', profiles.length === 1 && profiles[0].profile === '个人', JSON.stringify(profiles));
  const imported = await inTab('min://bookmarks', "window.min.call('bookmarks.importProfile', 0)");
  check('Chrome bookmarks imported', imported.links === 3, JSON.stringify(imported));
  const again = await inTab('min://bookmarks', "window.min.call('bookmarks.importProfile', 0)");
  check('re-import adds no duplicates', again.links === 0);
  await wait(300);
  check('imported links on the bookmarks bar', (await ui.textContent('#bookmarks-bar')).includes('Chrome Bar Link'));

  await cmd('openPage', 'history');
  await wait(1500);
  const visits = await inTab('min://history', "window.min.call('history.search', {})");
  const titles = visits.map((v) => v.title);
  check('history has visited pages', ['Page 1', 'Page 2', 'Tracked Page 隐私测试', 'Login Page'].every((t) => titles.includes(t)), JSON.stringify(titles));
  check('paused visit not recorded', !titles.includes('Page 99'));
  const p1 = visits.find((v) => v.title === 'Page 1');
  const p2 = visits.find((v) => v.title === 'Page 2');
  check('tracking params stripped', p2?.url === `http://${SITE}/page/2?keep=1`, p2?.url);
  check('referrer and transition recorded', p2?.referrer_id === p1?.id && p2?.transition === 'link' && p1?.transition === 'typed');
  check('duration recorded', p1?.duration_ms > 500);
  check('Chinese search', (await inTab('min://history', "window.min.call('history.search', {query: '隐私测试'})")).length === 1);
  check('page cannot use another page\'s API', (await inTab('min://history', "window.min.call('passwords.list').then(() => 'allowed', () => 'denied')")) === 'denied');

  // Click like a person: a pause between press and release must not lose the click.
  const humanClick = async (sel) => {
    const box = await (await ui.$(sel)).boundingBox();
    await ui.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await ui.mouse.down();
    await wait(300);
    await ui.mouse.up();
    await wait(400);
  };
  const tabCount = () => ui.$$eval('.tab', (t) => t.length);
  const before = await tabCount();
  await humanClick('.tab:not(.active) .tab-close');
  check('close button closes an inactive tab', (await tabCount()) === before - 1);
  await humanClick('.tab.active .tab-close');
  check('close button closes the active tab', (await tabCount()) === before - 2);

  await cmd('lock');
  await ui.waitForSelector('#unlock:not([hidden])');
  const leaks = plaintextLeaks(['alice', 's3cret-pass', SITE, 'Tracked Page', 'Chrome Bar Link']);
  check('no plaintext in data files', leaks.length === 0, leaks.join(', '));
  check('lock hides pages', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length)) === 0);
  await ui.fill('#unlock-pw', 'wrong password');
  await ui.click('#unlock-btn');
  await wait(1500);
  check('wrong password rejected', (await ui.textContent('#unlock-error')).includes('不正确'));
  await ui.fill('#unlock-pw', PW);
  await ui.click('#unlock-btn');
  await ui.waitForSelector('#chrome:not([hidden])', { timeout: 15000 });
  check('right password unlocks', true);
  await app.close();
}

async function restart() {
  const { app, ui, cmd, inTab } = await launch();
  await ui.waitForSelector('#unlock:not([hidden])');
  check('restart opens the lock screen', (await ui.textContent('#unlock-dir')) === DATA);
  await ui.fill('#unlock-pw', PW);
  await ui.click('#unlock-btn');
  await ui.waitForSelector('#chrome:not([hidden])', { timeout: 15000 });
  await wait(500);
  check('bookmarks persisted', (await ui.textContent('#bookmarks-bar')).includes('Chrome Bar Link'));
  await cmd('openPage', 'passwords');
  await wait(1000);
  const creds = await inTab('min://passwords', "window.min.call('passwords.list')");
  check('passwords persisted', creds.length === 1 && creds[0].username === 'alice');
  check('password decrypts', (await inTab('min://passwords', `window.min.call('passwords.reveal', ${creds[0]?.id})`)) === 's3cret-pass-XYZ');
  await cmd('openPage', 'history');
  await wait(1000);
  check('history persisted', (await inTab('min://history', "window.min.call('history.search', {})")).length >= 5);

  await cmd('openPage', 'settings');
  await wait(1000);
  const changed = await inTab('min://settings', `window.min.call('settings.changePassword', '${PW}', '${PW2}').then(() => 'ok', (e) => e.message)`);
  check('master password changed', changed === 'ok', changed);
  await cmd('lock');
  await ui.waitForSelector('#unlock:not([hidden])');
  await ui.fill('#unlock-pw', PW);
  await ui.click('#unlock-btn');
  await wait(1500);
  check('old password stops working', (await ui.textContent('#unlock-error')).includes('不正确'));
  await ui.fill('#unlock-pw', PW2);
  await ui.click('#unlock-btn');
  await ui.waitForSelector('#chrome:not([hidden])', { timeout: 15000 });
  check('new password unlocks', true);
  await app.close();
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  fakeChromeProfile();
  const server = await startServer();
  try {
    await firstRun();
    await restart();
  } finally {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
