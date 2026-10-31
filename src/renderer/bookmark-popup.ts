import type { PopupData } from '../shared/ipc';

// The bubble under the star: rename the bookmark, pick its folder, add a note.

declare global {
  interface Window {
    popup: { call(name: string, ...args: unknown[]): Promise<unknown> };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const title = $<HTMLInputElement>('title');
const folder = $<HTMLSelectElement>('folder');
const desc = $<HTMLInputElement>('desc');

async function init(): Promise<void> {
  const data = (await window.popup.call('data')) as PopupData | null;
  if (!data) return;
  $('heading').textContent = data.isNew ? '已收藏' : '编辑收藏';
  title.value = data.bookmark.title;
  desc.value = data.bookmark.description;
  for (const f of data.folders) {
    const opt = document.createElement('option');
    opt.value = String(f.id);
    // Indent with full-width spaces so the hierarchy shows in the list.
    opt.textContent = `${'　'.repeat(f.depth)}${f.title}`;
    opt.selected = f.id === data.bookmark.parentId;
    folder.append(opt);
  }
  title.focus();
  title.select();
  void window.popup.call('fit', document.documentElement.scrollHeight);
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  void window.popup.call('save', title.value, Number(folder.value), desc.value);
});
$('remove').addEventListener('click', () => void window.popup.call('remove'));
$('manage').addEventListener('click', () => void window.popup.call('manage'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void window.popup.call('close');
});

void init();
