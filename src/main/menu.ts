import { Menu, MenuItemConstructorOptions } from 'electron';
import type { BrowserApp } from './app';
import type { TabManager } from './tabs';

/**
 * The menu carries the keyboard shortcuts, so they work whether focus is in
 * the browser UI or inside a web page. Nothing works while locked.
 */
export function buildMenu(app: BrowserApp): Menu {
  const isMac = process.platform === 'darwin';
  const unlocked = () => app.phase === 'unlocked';
  const tabs = (fn: (t: TabManager) => void) => () => {
    if (unlocked() && app.tabs) fn(app.tabs);
  };
  const page = (name: string) => () => {
    if (unlocked()) app.openPage(name);
  };

  const tabNumbers: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? '最后一个标签页' : `标签页 ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: tabs((t) => t.activateIndex(i === 8 ? -1 : i)),
  }));

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'MinBrowser',
            submenu: [
              { role: 'about' as const, label: '关于 MinBrowser' },
              { type: 'separator' as const },
              { label: '设置…', accelerator: 'Cmd+,', click: page('settings') },
              { type: 'separator' as const },
              { role: 'hide' as const, label: '隐藏 MinBrowser' },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '全部显示' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: '退出 MinBrowser' },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新建标签页', accelerator: 'CmdOrCtrl+T', click: tabs((t) => t.create()) },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: tabs((t) => t.closeActive()) },
        { type: 'separator' },
        { label: '打开地址栏', accelerator: 'CmdOrCtrl+L', click: tabs((t) => t.focusAddress()) },
        { type: 'separator' },
        { label: '立即锁定', accelerator: 'CmdOrCtrl+Shift+L', click: () => app.lock() },
        ...(isMac ? [] : [{ label: '设置', accelerator: 'Ctrl+,', click: page('settings') }, { type: 'separator' as const }, { label: '退出', role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '查看',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: tabs((t) => t.reload()) },
        { label: '后退', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: tabs((t) => t.back()) },
        { label: '前进', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: tabs((t) => t.forward()) },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { label: '网页开发者工具', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: tabs((t) => t.toggleDevTools()) },
      ],
    },
    {
      label: '历史',
      submenu: [
        { label: '显示全部历史记录', accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H', click: page('history') },
        {
          label: '暂停 / 恢复记录',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => unlocked() && app.setRecordingPaused(!app.config!.get().recordingPaused),
        },
      ],
    },
    {
      label: '收藏',
      submenu: [
        { label: '收藏 / 取消收藏此页', accelerator: 'CmdOrCtrl+D', click: () => unlocked() && app.toggleBookmark() },
        { label: '管理收藏夹', accelerator: 'CmdOrCtrl+Shift+O', click: page('bookmarks') },
        {
          label: '显示 / 隐藏收藏夹栏',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => {
            if (!unlocked()) return;
            app.config!.set({ showBookmarksBar: !app.config!.get().showBookmarksBar });
            app.emit();
          },
        },
      ],
    },
    {
      label: '工具',
      submenu: [
        { label: '下载', accelerator: isMac ? 'Cmd+Shift+J' : 'Ctrl+J', click: page('downloads') },
        { label: '密码', click: page('passwords') },
      ],
    },
    {
      label: '标签页',
      submenu: [
        { label: '下一个标签页', accelerator: 'Ctrl+Tab', click: tabs((t) => t.cycle(1)) },
        { label: '上一个标签页', accelerator: 'Ctrl+Shift+Tab', click: tabs((t) => t.cycle(-1)) },
        { type: 'separator' },
        ...tabNumbers,
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ];

  return Menu.buildFromTemplate(template);
}
