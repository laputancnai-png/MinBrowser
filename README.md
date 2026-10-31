# MinBrowser

一个注重隐私的个人浏览器：不收集任何数据，浏览记录、收藏夹、密码都加密保存在你自己指定的本地文件夹。

完整方案见 [docs/DESIGN.md](docs/DESIGN.md)。

## 运行

需要 Node.js 20+。

```bash
npm install
npm start          # 构建并启动
npm test           # 单元测试
npm run typecheck  # 类型检查
```

## 进度

- [x] P1 骨架：多标签页、地址栏、导航、DuckDuckGo 搜索、浅色/深色主题、基础隐私设置
- [ ] P2 加密存储：主密码、解锁/锁定、SQLCipher
- [ ] P3 浏览记录：记录轨迹、暂停开关、历史页面
- [ ] P4 收藏夹：收藏夹栏、管理页面、Chrome 导入
- [ ] P5 密码管理
- [ ] P6 广告追踪拦截、下载管理
- [ ] P7 打包（dmg / AppImage）

## 快捷键

| 操作 | macOS | Linux |
|---|---|---|
| 新建标签页 | ⌘T | Ctrl+T |
| 关闭标签页 | ⌘W | Ctrl+W |
| 地址栏 | ⌘L | Ctrl+L |
| 重新加载 | ⌘R | Ctrl+R |
| 后退 / 前进 | ⌘[ / ⌘] | Alt+← / Alt+→ |
| 切换标签页 | Ctrl+Tab、⌘1–9 | Ctrl+Tab、Ctrl+1–9 |
