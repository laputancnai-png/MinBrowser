import { app, Menu, MenuItemConstructorOptions } from 'electron';
import { TabManager } from './tabs';

/**
 * The menu carries the keyboard shortcuts, so they work no matter whether
 * focus is in the browser UI or inside a web page.
 */
export function buildMenu(getTabs: () => TabManager | null): Menu {
  const tabs = (fn: (t: TabManager) => void) => () => {
    const t = getTabs();
    if (t) fn(t);
  };
  const isMac = process.platform === 'darwin';

  const tabNumbers: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? '最后一个标签页' : `标签页 ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: tabs((t) => t.activateIndex(i === 8 ? -1 : i)),
  }));

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建标签页', accelerator: 'CmdOrCtrl+T', click: tabs((t) => t.create()) },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: tabs((t) => t.closeActive()) },
        { type: 'separator' },
        { label: '打开地址栏', accelerator: 'CmdOrCtrl+L', click: tabs((t) => t.focusAddress()) },
        ...(isMac ? [] : [{ type: 'separator' as const }, { label: '退出', role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: '查看',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: tabs((t) => t.reload()) },
        { label: '后退', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: tabs((t) => t.back()) },
        { label: '前进', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: tabs((t) => t.forward()) },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: '网页开发者工具',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: tabs((t) => t.toggleDevTools()),
        },
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
    { role: 'windowMenu' },
  ];

  if (!isMac) app.setAboutPanelOptions({ applicationName: 'MinBrowser' });
  return Menu.buildFromTemplate(template);
}
