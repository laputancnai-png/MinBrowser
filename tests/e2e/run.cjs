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
    if (url.pathname === '/links')
      return html(page('Links Page', '<p><a id="l" href="/page/41" style="display:block;width:200px;height:40px">Go to page 41</a></p><p><input id="f" style="width:200px;height:30px"></p><p id="t">plain text here</p>'));
    if (url.pathname === '/login2') return html(page('Two Step Login', '<form action="/login2/pw" method="get"><input type="email" name="email" id="e" autocomplete="username" placeholder="邮箱"><button id="next">下一步</button></form>'));
    if (url.pathname === '/login2/pw') return html(page('Two Step Password', `<p>账号：${(url.searchParams.get('email') || '').replace(/[<>&"]/g, '')}</p><form method="post" action="/welcome"><input type="password" id="p" autocomplete="current-password"><button id="go">登录</button></form>`));
    if (url.pathname === '/login4') return html(page('Aeries Style', '<form method="post" action="/welcome"><input type="text" id="portalAccountUsername" name="portalAccountUsername" placeholder="Email Address"><a href="#" id="next" onclick="document.getElementById(&quot;pwSection&quot;).style.display=&quot;block&quot;;this.style.display=&quot;none&quot;;return false">Next</a><div id="pwSection" style="display:none"><input type="password" id="portalAccountPassword" name="portalAccountPassword"><button id="LoginButton">Sign In</button></div></form>'));
    if (url.pathname === '/embed-internal') return html(page('Embed Internal', '<iframe id="f" src="min://passwords/" width="400" height="300"></iframe><iframe id="g" src="/page/1" width="200" height="100"></iframe>'));
    if (url.pathname === '/persist') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'keep=SECRETSESSIONTOKEN; Max-Age=3600; Path=/' });
      return res.end('<title>Persist</title>ok');
    }
    if (url.pathname === '/login3') return html(page('One Page Steps', '<div><input type="text" id="u" placeholder="Email or phone"><button id="next" type="button">Next</button></div><div id="step2" style="display:none"><input type="password" id="p" readonly><button id="go" type="button">Sign in</button></div><script>next.onclick=()=>{step2.style.display="block"};p.onfocus=()=>p.removeAttribute("readonly");go.onclick=()=>{location.href="/welcome"}</script>'));
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
  // The browser UI page (other views, like the split-view layers, are pages too).
  let ui = null;
  for (let i = 0; i < 100 && !ui; i++) {
    ui = app.windows().find((w) => w.url() === 'app://ui/index.html') ?? null;
    if (!ui) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ui) throw new Error('browser UI page not found');
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

  // Drag and drop in the bookmark manager, with a real pointer drag.
  await inTab('min://bookmarks', 'location.reload()');
  await wait(1200);
  const bm = app.windows().find((p) => p.url().startsWith('min://bookmarks'));
  const barTitles = () => bm.$$eval('.item .title', (e) => e.map((x) => x.textContent));
  const startOrder = await barTitles();
  check('manager lists the bookmarks bar', startOrder.join('|') === 'Tracked Page 隐私测试|Chrome Bar Link|Dev', startOrder.join('|'));
  const firstBox = await (await bm.$('.item >> nth=0')).boundingBox();
  await bm.dragAndDrop('.item:has-text("Chrome Bar Link")', '.item >> nth=0', { targetPosition: { x: firstBox.width / 2, y: 4 } });
  await wait(800);
  const reordered = (await barTitles()).join('|');
  check('dragging reorders bookmarks', reordered === 'Chrome Bar Link|Tracked Page 隐私测试|Dev', reordered);
  check('bookmarks bar follows the new order', (await ui.$$eval('.bar-item', (b) => b.map((x) => x.textContent)))[0] === 'Chrome Bar Link');
  await bm.dragAndDrop('.item:has-text("Tracked Page")', '.tnode-row:has-text("其他收藏")', { targetPosition: { x: 80, y: 15 } });
  await wait(800);
  check('dragging onto a folder in the tree moves it', !(await barTitles()).some((t) => t.startsWith('Tracked Page')));
  const other = await inTab('min://bookmarks', "window.min.call('bookmarks.tree')");
  check('moved bookmark is saved in its new folder', other[1].children.some((c) => c.title.startsWith('Tracked Page')));

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
  const { app, ui, cmd, inTab, go } = await launch();
  await ui.waitForSelector('#unlock:not([hidden])');
  check('restart opens the lock screen', (await ui.textContent('#unlock-dir')) === DATA);
  await ui.fill('#unlock-pw', PW);
  await ui.click('#unlock-btn');
  await ui.waitForSelector('#chrome:not([hidden])', { timeout: 15000 });
  await wait(500);
  check('bookmarks persisted', (await ui.textContent('#bookmarks-bar')).includes('Chrome Bar Link'));
  await go(`${SITE}/login`, 1500);
  check('saved login filled automatically', (await inTab('/login', "u.value + '|' + p.value")) === 'alice|s3cret-pass-XYZ');
  await cmd('openPage', 'settings');
  await wait(1000);
  await inTab('min://settings', "window.min.call('settings.set', { autofillPasswords: false })");
  await go(`${SITE}/login`, 1500);
  check('autofill can be turned off', (await inTab('/login', "u.value + '|' + p.value")) === '|');
  await cmd('openPage', 'settings');
  await wait(800);
  await inTab('min://settings', "window.min.call('settings.set', { autofillPasswords: true })");
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

async function unlockWith(ui, pw) {
  await ui.waitForSelector('#unlock:not([hidden])');
  await ui.fill('#unlock-pw', pw);
  await ui.click('#unlock-btn');
  await ui.waitForSelector('#chrome:not([hidden])', { timeout: 15000 });
  await wait(800);
}

const tabTitles = (ui) => ui.$$eval('.tab-title', (t) => t.map((x) => x.textContent));
const activeTitle = (ui) => ui.$eval('.tab.active .tab-title', (t) => t.textContent);
/** URLs actually loaded in tab processes (deferred tabs have none yet). */
const loadedUrls = (app) => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));

async function crashRecovery() {
  // 1. The previous run quit normally with internal pages open: they come back.
  let { app, ui, cmd, inTab, go } = await launch();
  await unlockWith(ui, PW2);
  check('tabs come back after a normal quit', (await tabTitles(ui)).includes('设置'), JSON.stringify(await tabTitles(ui)));

  // 2. Open some pages, then kill the browser outright.
  await go(`${SITE}/page/5`);
  await cmd('newTab');
  await go(`${SITE}/tracked`);
  await cmd('newTab');
  await go(`${SITE}/login`);
  await ui.click('.tab:has-text("Tracked Page")');
  await wait(1500);
  await cmd('openPage', 'history');
  await wait(1000);
  const visitsBefore = (await inTab('min://history', "window.min.call('history.search', {})")).length;
  await ui.click('.tab:has-text("Tracked Page")');
  await wait(1500); // let the debounced save run
  app.process().kill('SIGKILL');
  await wait(1000);

  // 3. Start again: everything is back, the same tab is in front.
  ({ app, ui, cmd, inTab, go } = await launch());
  await unlockWith(ui, PW2);
  const titles = await tabTitles(ui);
  check('tabs restored after a crash', ['Page 5', 'Tracked Page 隐私测试', 'Login Page', '历史记录'].every((t) => titles.includes(t)), JSON.stringify(titles));
  check('the same tab is active again', (await activeTitle(ui)) === 'Tracked Page 隐私测试');
  check('background tabs wait until opened', !(await loadedUrls(app)).some((u) => u.includes('/login')));
  await ui.click('.tab:has-text("Login Page")');
  await wait(1200);
  check('a restored tab loads when opened', (await loadedUrls(app)).some((u) => u.includes('/login')));
  await ui.click('.tab:has-text("历史记录")');
  await wait(1200);
  const visitsAfter = (await inTab('min://history', "window.min.call('history.search', {})")).length;
  check('restoring does not add history visits', visitsAfter === visitsBefore, `${visitsBefore} -> ${visitsAfter}`);

  // 4. A single page crashing shows an error page; reload brings it back.
  await ui.click('.tab:has-text("Page 5")');
  await wait(800);
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes('/page/5')).forcefullyCrashRenderer());
  await wait(1500);
  check('a crashed page shows the crash page', (await activeTitle(ui)) === '这个网页崩溃了', await activeTitle(ui));
  check('the address bar keeps the crashed page address', (await ui.inputValue('#address')).includes('/page/5'));
  await ui.click('#reload');
  await wait(1500);
  check('reload brings the crashed page back', (await activeTitle(ui)) === 'Page 5');

  // 5. With the setting off, nothing is restored.
  await cmd('openPage', 'settings');
  await wait(1000);
  await inTab('min://settings', "window.min.call('settings.set', { restoreSession: false })");
  await wait(1200);
  await app.close();
  ({ app, ui } = await launch());
  await unlockWith(ui, PW2);
  check('no restore when turned off', JSON.stringify(await tabTitles(ui)) === '["新标签页"]', JSON.stringify(await tabTitles(ui)));
  await app.close();
}

async function tabReorder() {
  const { app, ui, cmd, go } = await launch();
  await unlockWith(ui, PW2);
  await go(`${SITE}/page/1`);
  for (const n of [2, 3]) {
    await cmd('newTab');
    await go(`${SITE}/page/${n}`);
  }
  await wait(500);
  check('three tabs to reorder', (await tabTitles(ui)).join(',') === 'Page 1,Page 2,Page 3', (await tabTitles(ui)).join(','));
  // Drag "Page 1" past "Page 3" at a human pace.
  const a = await (await ui.$('.tab:has-text("Page 1")')).boundingBox();
  const c = await (await ui.$('.tab:has-text("Page 3")')).boundingBox();
  await ui.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await ui.mouse.down();
  await ui.mouse.move(c.x + c.width * 0.75, a.y + a.height / 2, { steps: 15 });
  await wait(200);
  await ui.mouse.up();
  await wait(600);
  check('dragging a tab reorders the tabs', (await tabTitles(ui)).join(',') === 'Page 2,Page 3,Page 1', (await tabTitles(ui)).join(','));
  await ui.click('.tab:has-text("Page 2")');
  await wait(300);
  check('clicking a tab does not move it', (await tabTitles(ui)).join(',') === 'Page 2,Page 3,Page 1');
  await app.close();
}

async function bookmarkBubble() {
  const { app, ui, go, inTab, cmd } = await launch();
  await unlockWith(ui, PW2);
  const bubble = async () => {
    for (let i = 0; i < 50; i++) {
      const p = app.windows().find((w) => w.url().endsWith('bookmark-popup.html'));
      if (p) {
        await p.waitForSelector('#folder option', { state: 'attached' });
        return p;
      }
      await wait(100);
    }
    return null;
  };
  const bubbleOpen = () => app.windows().some((w) => w.url().endsWith('bookmark-popup.html'));
  const treeNow = async () => {
    await cmd('openPage', 'bookmarks');
    await wait(1000);
    return inTab('min://bookmarks', "window.min.call('bookmarks.tree')");
  };
  const pathOf = (nodes, url, path = []) => {
    for (const n of nodes || []) {
      if (n.url === url) return [...path];
      const r = pathOf(n.children, url, [...path, n.title]);
      if (r) return r;
    }
    return null;
  };

  // The star bookmarks the page and opens the bubble to pick a folder.
  await go(`${SITE}/page/21`);
  await ui.click('#star');
  let pop = await bubble();
  check('star opens the bookmark bubble', !!pop && (await pop.inputValue('#title')) === 'Page 21');
  const dev = await pop.$$eval('#folder option', (o) => o.find((x) => x.textContent.trim() === 'Dev').value);
  await pop.selectOption('#folder', dev);
  await pop.fill('#desc', '气泡里写的描述');
  await pop.click('#done').catch(() => {});
  await wait(500);
  check('bubble closes on done', !bubbleOpen());
  let tree = await treeNow();
  check('bubble puts the bookmark in the chosen folder', (pathOf(tree, `http://${SITE}/page/21`) || []).join('/') === '收藏夹栏/Dev');

  // Drag the site icon from the address bar onto a folder in the bookmarks bar.
  await ui.click('.tab:has-text("Page 21")');
  await go(`${SITE}/page/22`);
  await ui.dragAndDrop('#site', '.bar-item:has-text("Dev")');
  pop = await bubble();
  check('dropping the site icon on a bar folder opens the bubble there', !!pop && (await pop.$eval('#folder', (s) => s.selectedOptions[0].textContent.trim())) === 'Dev');
  await pop.keyboard.press('Escape').catch(() => {});
  await wait(400);
  tree = await treeNow();
  check('dropped page is bookmarked in that folder', (pathOf(tree, `http://${SITE}/page/22`) || []).join('/') === '收藏夹栏/Dev');
  await app.close();
}

async function multiStepLogin() {
  const { app, ui, go, inTab } = await launch();
  await unlockWith(ui, PW2);
  const val = (part, id) => inTab(part, `document.getElementById('${id}').value`);
  // Username on one page, password on the next: saved as one login.
  await go(`${SITE}/login2`, 1500);
  await inTab('/login2', "e.value = 'dora@example.com'; next.click()");
  await wait(1500);
  await inTab('/login2/pw', "p.value = 'dora-pass'; go.click()");
  await wait(1200);
  check('two-step login: save prompt includes the username', (await ui.textContent('#infobar-text')).includes('dora@example.com'));
  await ui.click('#pw-save');
  await wait(300);
  // Next time both steps are filled in.
  await go(`${SITE}/login2`, 1800);
  check('two-step login: username step filled', (await val('/login2', 'e')) === 'dora@example.com', await val('/login2', 'e'));
  await inTab('/login2', 'next.click()');
  await wait(1800);
  check('two-step login: password step filled', (await val('/login2/pw', 'p')) === 'dora-pass');
  // Password appears later on the same page, read-only until focused.
  await go(`${SITE}/login3`, 1500);
  await inTab('/login3', "u.value = 'dora@example.com'; next.click()");
  await wait(1500);
  check('one-page steps: read-only password field filled after Next', (await val('/login3', 'p')) === 'dora-pass', await val('/login3', 'p'));
  // "Next" is a link (as on Aeries), and the email is typed in different case.
  await go(`${SITE}/login4`, 1500);
  await inTab('/login4', "{ const f = document.getElementById('portalAccountUsername'); f.value = 'DORA@Example.com'; f.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('next').click(); 1 }");
  await wait(1500);
  check('link-style Next and different case still fill the password', (await val('/login4', 'portalAccountPassword')) === 'dora-pass', await val('/login4', 'portalAccountPassword'));
  await app.close();
}

async function splitView() {
  const { app, ui, cmd, go } = await launch();
  await unlockWith(ui, PW2);
  const panes = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.map((v) => ({ url: v.webContents.getURL(), b: v.getBounds() }))
        .filter((p) => p.url.startsWith('http')),
    );
  await go(`${SITE}/page/31`);
  await cmd('newTab');
  await go(`${SITE}/page/32`);
  // Drag a tab out of the strip to the right edge of the page.
  const t = await (await ui.$('.tab:has-text("Page 31")')).boundingBox();
  await ui.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await ui.mouse.down();
  await ui.mouse.move(t.x + t.width / 2, 300, { steps: 6 });
  await ui.mouse.move(1150, 400, { steps: 10 });
  await wait(300);
  await ui.mouse.up();
  await wait(800);
  let p = await panes();
  check('dragging a tab to the right edge splits the view', p.length === 2 && p.find((x) => x.b.x > 300)?.url.endsWith('/page/31'), JSON.stringify(p.map((x) => x.url)));
  // Drag the divider (a transparent layer over the gap that owns the drag).
  let handle = null;
  for (const w of app.windows()) {
    if (w.url().endsWith('split-shield.html') && (await w.evaluate(() => document.body.className)).includes('handle')) handle = w;
  }
  const [hw, hh] = await handle.evaluate(() => [innerWidth, innerHeight]);
  await handle.mouse.move(hw / 2, hh / 2);
  await handle.mouse.down();
  await wait(300);
  await handle.mouse.move(400, hh / 2, { steps: 8 });
  await handle.mouse.up();
  await wait(500);
  p = await panes();
  check('dragging the divider resizes both sides', Math.abs((p.find((x) => x.b.x < 300)?.b.width ?? 0) - 400) < 30, JSON.stringify(p.map((x) => x.b)));
  await cmd('splitOrientation', 'vertical');
  await wait(400);
  p = await panes();
  check('split switches to top/bottom', p.length === 2 && Math.abs(p[0].b.x - p[1].b.x) < 2);
  await cmd('unsplit');
  await wait(400);
  check('exiting the split shows one page', (await panes()).length === 1);
  await app.close();
}

async function contextMenu() {
  const { app, ui, cmd, captureMenus, go } = await launch();
  await unlockWith(ui, PW2);
  await captureMenus();
  await go(`${SITE}/links`);
  // A real right-click in the page, at the middle of an element.
  const rightClick = (id) =>
    app.evaluate(async ({ webContents }, id) => {
      const w = webContents.getAllWebContents().find((w) => w.getURL().includes('/links'));
      const [x, y] = await w.executeJavaScript(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
      globalThis.__menu = null;
      w.focus();
      w.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
      w.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
      for (let i = 0; i < 30 && !globalThis.__menu; i++) await new Promise((r) => setTimeout(r, 50));
      return globalThis.__menu ? globalThis.__menu.t.map((x) => x.label ?? '---') : null;
    }, id);
  const choose = (label) =>
    app.evaluate((_, label) => {
      const { t, m } = globalThis.__menu;
      m.closePopup();
      t.find((x) => x.label === label).click();
    }, label);
  const tabs = () => ui.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => ({ title: t.textContent, active: t.classList.contains('active') })));

  const start = await tabs();
  const at = start.findIndex((x) => x.active);
  let labels = await rightClick('l');
  check('right-clicking a link offers "open in new tab"', labels?.includes('在新标签页中打开链接'), JSON.stringify(labels));
  await choose('在新标签页中打开链接');
  await wait(1200);
  let t = await tabs();
  check('link opens in a new background tab next to the page', t.length === start.length + 1 && t[at + 1].title.includes('Page 41') && t[at].active, JSON.stringify(t));

  labels = await rightClick('f');
  check('right-clicking a text field offers paste', labels?.includes('粘贴') && labels?.includes('全选'), JSON.stringify(labels));
  labels = await rightClick('t');
  check('right-clicking the page offers back/forward/reload', labels?.includes('重新加载'), JSON.stringify(labels));

  await rightClick('l');
  await choose('复制链接地址');
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  check('copy link address', copied === `http://${SITE}/page/41`, copied);

  await rightClick('l');
  await choose('在分屏中打开链接');
  await wait(1200);
  const panes = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.map((v) => v.webContents.getURL()).filter((u) => u.startsWith('http')),
  );
  check('link opens in the split view', panes.length === 2 && panes.some((u) => u.endsWith('/links')) && panes.some((u) => u.endsWith('/page/41')), JSON.stringify(panes));
  await cmd('unsplit');

  // Middle-click opens a background tab without any menu.
  const before = (await tabs()).length;
  await app.evaluate(async ({ webContents }) => {
    const w = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/links'));
    const [x, y] = await w.executeJavaScript(`(() => { const r = document.getElementById('l').getBoundingClientRect(); return [Math.round(r.x + 20), Math.round(r.y + 10)]; })()`);
    w.sendInputEvent({ type: 'mouseDown', x, y, button: 'middle', clickCount: 1 });
    w.sendInputEvent({ type: 'mouseUp', x, y, button: 'middle', clickCount: 1 });
  });
  await wait(1200);
  check('middle-click opens a link in a new tab', (await tabs()).length === before + 1);
  await app.close();
}

async function securityChecks() {
  const { app, ui, go } = await launch();
  await unlockWith(ui, PW2);
  const chromiumDir = path.join(DATA, 'chromium');
  check('website data folder is private', (fs.statSync(chromiumDir).mode & 0o777) === 0o700, (fs.statSync(chromiumDir).mode & 0o777).toString(8));
  await go(`${SITE}/persist`, 1500);
  const policy = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes('/persist')).getWebRTCIPHandlingPolicy());
  check('WebRTC does not reveal local network addresses', policy === 'default_public_interface_only', policy);
  await go(`${SITE}/embed-internal`, 2000);
  const frames = await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().find((w) => w.getURL().includes('/embed-internal')).mainFrame.frames.map((f) => f.url),
  );
  check('web pages cannot embed internal pages', !frames.some((u) => u.startsWith('min:')), JSON.stringify(frames));
  await app.close();
  await wait(500);
  // Cookie encryption comes from an Electron fuse (scripts/dev-fuses.mjs for development builds).
  const cookies = fs.readFileSync(path.join(chromiumDir, 'Cookies'));
  check('cookies are not stored in plain text', cookies.length > 0 && !cookies.includes('SECRETSESSIONTOKEN'));
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  fakeChromeProfile();
  const server = await startServer();
  try {
    await firstRun();
    await restart();
    await crashRecovery();
    await tabReorder();
    await bookmarkBubble();
    await multiStepLogin();
    await splitView();
    await contextMenu();
    await securityChecks();
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
