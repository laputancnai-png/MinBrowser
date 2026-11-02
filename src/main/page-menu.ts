import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

/** What the right-click menu on a web page can do. Kept apart so the menu can be tested. */
export interface PageMenuActions {
  openInNewTab(url: string): void;
  openInSplit(url: string): void;
  copyText(text: string): void;
  copyImage(): void;
  download(url: string): void;
  search(text: string): void;
  edit(action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): void;
  back(): void;
  forward(): void;
  reload(): void;
}

export interface PageMenuState {
  canGoBack: boolean;
  canGoForward: boolean;
}

type Params = Pick<ContextMenuParams, 'linkURL' | 'srcURL' | 'mediaType' | 'hasImageContents' | 'selectionText' | 'isEditable' | 'editFlags'>;

const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Cmd' : 'Ctrl';

/** Only real web addresses open in a tab; never javascript:, file:, data: or internal pages. */
export function isOpenable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Menu labels: one line, short, and no "&" (GTK reads it as a keyboard shortcut marker). */
function quote(text: string, max = 24): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const short = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return short.replace(/&/g, '&&');
}

export function pageMenu(p: Params, state: PageMenuState, a: PageMenuActions): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];
  const link = p.linkURL;
  const image = p.mediaType === 'image' && p.srcURL ? p.srcURL : '';
  const selection = p.selectionText.trim();

  if (link) {
    const items: MenuItemConstructorOptions[] = [];
    if (isOpenable(link)) {
      items.push(
        { label: '在新标签页中打开链接', click: () => a.openInNewTab(link) },
        { label: '在分屏中打开链接', click: () => a.openInSplit(link) },
      );
    }
    items.push({ label: '复制链接地址', click: () => a.copyText(link.startsWith('mailto:') ? link.slice(7) : link) });
    if (isOpenable(link)) items.push({ label: '链接另存为…', click: () => a.download(link) });
    groups.push(items);
  }

  if (image) {
    const items: MenuItemConstructorOptions[] = [];
    if (isOpenable(image)) items.push({ label: '在新标签页中打开图片', click: () => a.openInNewTab(image) });
    if (isOpenable(image) || image.startsWith('data:image/')) items.push({ label: '图片另存为…', click: () => a.download(image) });
    if (p.hasImageContents) items.push({ label: '复制图片', click: () => a.copyImage() });
    if (isOpenable(image)) items.push({ label: '复制图片地址', click: () => a.copyText(image) });
    if (items.length) groups.push(items);
  }

  if (p.isEditable) {
    const f = p.editFlags;
    groups.push(
      [
        { label: '撤销', accelerator: `${MOD}+Z`, enabled: f.canUndo, click: () => a.edit('undo') },
        { label: '重做', accelerator: MAC ? 'Shift+Cmd+Z' : 'Ctrl+Shift+Z', enabled: f.canRedo, click: () => a.edit('redo') },
      ],
      [
        { label: '剪切', accelerator: `${MOD}+X`, enabled: f.canCut, click: () => a.edit('cut') },
        { label: '复制', accelerator: `${MOD}+C`, enabled: f.canCopy, click: () => a.edit('copy') },
        { label: '粘贴', accelerator: `${MOD}+V`, enabled: f.canPaste, click: () => a.edit('paste') },
        { label: '全选', accelerator: `${MOD}+A`, enabled: f.canSelectAll, click: () => a.edit('selectAll') },
      ],
    );
  } else if (selection) {
    groups.push([
      { label: '复制', accelerator: `${MOD}+C`, click: () => a.copyText(p.selectionText) },
      { label: `用 DuckDuckGo 搜索“${quote(selection)}”`, click: () => a.search(selection) },
    ]);
  }

  // Nothing specific under the pointer: page navigation.
  if (!groups.length) {
    groups.push([
      { label: '后退', enabled: state.canGoBack, click: () => a.back() },
      { label: '前进', enabled: state.canGoForward, click: () => a.forward() },
      { label: '重新加载', click: () => a.reload() },
    ]);
  }

  const items: MenuItemConstructorOptions[] = [];
  for (const g of groups) {
    if (items.length) items.push({ type: 'separator' });
    items.push(...g);
  }
  // Shortcuts are shown as a reminder only; the real ones are handled by the page.
  for (const i of items) if (i.accelerator) i.registerAccelerator = false;
  return items;
}
