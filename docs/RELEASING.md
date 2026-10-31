# 打包、发布与升级

## 本地打包

```bash
npm ci
npm run dist:mac     # 在 Mac 上运行：生成 out/MinBrowser-<版本>-arm64.dmg 和 x64.dmg
npm run dist:linux   # 在 Linux 上运行：生成 out/MinBrowser-<版本>.AppImage 和 .deb
```

dmg 只能在 macOS 上生成。也可以在 GitHub 上运行 **Actions → Build → Run workflow**，
或者推送一个 `v0.2.0` 这样的标签，两个平台的安装包会出现在这次运行的 Artifacts 里。

### macOS：未签名的应用

默认构建没有签名（签名需要付费的 Apple 开发者账号）。第一次打开时 macOS 会拦截：

- 在“访达”里右键点击 MinBrowser →“打开”→ 再点“打开”；或者
- 终端执行 `xattr -dr com.apple.quarantine /Applications/MinBrowser.app`

如果有开发者账号，设置环境变量 `CSC_LINK`（.p12 证书）和 `CSC_KEY_PASSWORD`，
并删除 `electron-builder.yml` 里的 `identity: null`，就会自动签名。

### Linux

- AppImage：`chmod +x MinBrowser-*.AppImage` 后直接运行
- deb：`sudo apt install ./minbrowser_*_amd64.deb`
- Cookie 加密使用系统密钥环（GNOME Keyring / KWallet）。没有密钥环的系统上，
  Chromium 会退回到固定密钥，此时 Cookie 实际上没有加密（浏览记录、收藏夹、密码
  不受影响，它们始终由主密码加密）。

## 安装包的安全加固（Electron fuses）

`electron-builder.yml` 里的 `electronFuses` 会在打包时写入二进制：

| 开关 | 设置 | 作用 |
|---|---|---|
| runAsNode | 关 | 不能用 `ELECTRON_RUN_AS_NODE` 把浏览器当成 Node 来运行任意代码 |
| enableNodeOptionsEnvironmentVariable | 关 | 忽略 `NODE_OPTIONS` 注入 |
| enableNodeCliInspectArguments | 关 | 不能用 `--inspect` 附加调试器读取内存中的密钥 |
| enableCookieEncryption | 开 | Cookie 用系统钥匙串/密钥环中的密钥加密 |
| enableEmbeddedAsarIntegrityValidation | 开 | 程序文件被篡改就拒绝启动 |
| onlyLoadAppFromAsar | 开 | 只从校验过的 app.asar 加载代码 |

### 测试安装包

因为调试开关被关掉了，自动化测试不能直接驱动正式安装包。打一个只打开调试开关的测试包来跑端到端测试：

```bash
npx electron-builder --linux dir -c.electronFuses.enableNodeCliInspectArguments=true -c.directories.output=out-test
PACKAGED=out-test/linux-unpacked/minbrowser xvfb-run -a npm run test:e2e
# macOS: npx electron-builder --mac dir ... ，然后
# PACKAGED=out-test/mac-arm64/MinBrowser.app/Contents/MacOS/MinBrowser npm run test:e2e
```

## 升级 Electron（安全更新）

浏览器的安全性取决于 Chromium 内核是否及时更新。Electron 大约每 8 周发布一个大版本，
中间还有安全补丁版本。建议**每个月**检查一次：

```bash
npm outdated electron          # 看有没有新版本
npm install -D electron@latest
npm run typecheck && npm test
xvfb-run -a npm run test:e2e   # macOS 上不需要 xvfb-run
npm run dist:mac               # 或 dist:linux，重新打包
```

升级大版本前，读一下 Electron 的 [Breaking Changes](https://www.electronjs.org/docs/latest/breaking-changes)。
这个项目用到的、最可能受影响的 API：`WebContentsView`、`session.fromPath`、
`webRequest`、`protocol.handle`、`node:sqlite`（Electron 自带的 Node 版本）。

因为没有原生模块，升级 Electron 不需要重新编译任何依赖。

## 数据备份

数据文件夹里的文件都是加密的，可以直接复制到 U 盘、NAS 或网盘备份。
恢复时，在 MinBrowser 的锁定界面点击“使用其他数据文件夹”选择备份的文件夹，用原来的主密码解锁。
不要在 MinBrowser 运行时让两台电脑同时使用同一个数据文件夹。
