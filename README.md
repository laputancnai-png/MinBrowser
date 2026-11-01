# MinBrowser

一个注重隐私的个人浏览器：不收集任何数据，浏览记录、收藏夹、密码都加密保存在你自己指定的本地文件夹。

完整方案见 [docs/DESIGN.md](docs/DESIGN.md)。

## 版本

当前版本见 [CHANGELOG.md](CHANGELOG.md)，在设置页、新标签页底部和“关于 MinBrowser”里也能看到。
版本号格式是 vN.N：每次修改升 0.1（`npm run version:minor -- "改了什么"`），大改版升 1.0（`npm run version:major -- "改了什么"`）。

## 运行

需要 Node.js 20+。

```bash
npm install
npm start          # 构建并启动
npm test           # 单元测试
npm run test:e2e   # 端到端测试（驱动真实的浏览器窗口；无图形界面的 Linux 上用 xvfb-run -a）
npm run typecheck  # 类型检查
```

打包安装文件（dmg / AppImage / deb）、macOS 未签名应用的打开方法、升级 Electron
的步骤，见 [docs/RELEASING.md](docs/RELEASING.md)。

## Linux：任务栏和应用菜单里的图标

开发时用 `npm start` 运行，GNOME / KDE 的任务栏可能显示一个通用图标。执行一次：

```bash
npm run install-desktop
```

就会把 MinBrowser 加进应用菜单，任务栏也会显示 MinBrowser 的图标（第一次可能需要注销再登录）。
安装 `.deb` 包时会自动完成这一步。

图标源文件是 `build/icon.svg`，打包用的 `build/icon.png` 和程序里用的 `src/assets/icon.png` 都由它导出。

## Linux：启动时报 chrome-sandbox 错误

如果 `npm start` 报 `The SUID sandbox helper binary was found, but is not configured correctly`，
说明系统限制了普通用户创建沙箱（Ubuntu 23.10 及以后的版本默认如此）。
给开发用的 Electron 设置一次沙箱权限即可（重新 `npm install` 后需要再执行一次）：

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

不要用 `--no-sandbox` 绕过：那会关掉网页进程的沙箱，恶意网页更容易攻击到你的电脑。
安装 `.deb` 包时安装脚本会自动处理这个问题。

## 收藏网页

- 点地址栏右边的 ☆：立即收藏到上次用的文件夹，并弹出小窗口，可以改名称、选文件夹、写描述
- 或者按住地址栏左边的图标（🔒 / 🌐），拖到收藏夹栏：拖到文件夹上就放进那个文件夹，拖到两个收藏之间就插在那里
- 网页里的链接也可以直接拖到收藏夹栏上

## 分屏

大屏幕上可以左右或上下同时看两个网页：

- 在标签上点右键 →“在右侧分屏打开”或“在下方分屏打开”
- 或者按住标签往下拖进网页区域，拖到右边缘（左右分屏）或下边缘（上下分屏），出现橙色预览后松手
- 拖动中间的分隔条调整两边大小；右键分屏中的标签可以切换左右/上下、交换两侧、退出分屏
- 地址栏、收藏、密码等都跟着你最后点的那一边（有橙色边框的一边）
- 分屏时点其他标签，会替换当前那一边；关掉其中一边就退出分屏
- 分屏状态会在重启或崩溃后恢复

## 第一次使用

1. 选择一个文件夹存放数据（之后可以直接复制这个文件夹备份）
2. 设置主密码，并输入确认语句。**忘记主密码，数据将无法恢复。**
3. 想从 Chrome 搬过来？打开 菜单 ⋯ → 收藏夹 → “从 Chrome 导入”

## 进度

- [x] P1 骨架：多标签页、地址栏、导航、DuckDuckGo 搜索、浅色/深色主题、基础隐私设置
- [x] P2 加密存储：主密码、解锁/锁定、自动锁定、整库加密
- [x] P3 浏览记录：记录轨迹、暂停开关、历史页面（搜索、删除、导出）
- [x] P4 收藏夹：收藏夹栏、管理页面、Chrome 导入
- [x] P5 密码管理：保存、填充、生成、管理页面
- [x] P6 广告追踪拦截、下载管理
- [x] P7 打包：dmg / AppImage / deb，安全加固，GitHub Actions 自动构建

## 快捷键

| 操作 | macOS | Linux |
|---|---|---|
| 新建标签页 | ⌘T | Ctrl+T |
| 关闭标签页 | ⌘W | Ctrl+W |
| 地址栏 | ⌘L | Ctrl+L |
| 重新加载 | ⌘R | Ctrl+R |
| 后退 / 前进 | ⌘[ / ⌘] | Alt+← / Alt+→ |
| 切换标签页 | Ctrl+Tab、⌘1–9 | Ctrl+Tab、Ctrl+1–9 |
| 标签页左移 / 右移（也可以直接拖动标签） | Ctrl+Shift+PageUp / PageDown | Ctrl+Shift+PageUp / PageDown |
| 收藏此页（弹出窗口里选文件夹） | ⌘D | Ctrl+D |
| 历史记录 | ⌘Y | Ctrl+H |
| 暂停 / 恢复记录 | ⌘⇧P | Ctrl+Shift+P |
| 收藏夹栏 | ⌘⇧B | Ctrl+Shift+B |
| 下载 | ⌘⇧J | Ctrl+J |
| 立即锁定 | ⌘⇧L | Ctrl+Shift+L |
