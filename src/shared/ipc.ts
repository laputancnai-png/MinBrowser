/** IPC between the browser UI and the main process. */
export const Ipc = {
  /** UI -> main, invoke(command, ...args) */
  Command: 'ui:command',
  /** main -> UI */
  State: 'ui:state',
  FocusAddress: 'ui:focus-address',
  /** main -> UI: open the bookmark bubble under the star (e.g. from Ctrl+D) */
  StarRequest: 'ui:star-request',
  /** Bookmark bubble -> main, invoke(command, ...args) */
  Popup: 'popup:command',
  /** Internal min:// pages -> main, invoke(method, args) */
  Internal: 'internal',
  /** Tab password agent <-> main */
  PwForms: 'pw:forms',
  PwSubmit: 'pw:submit',
  PwFill: 'pw:fill',
  PwFillNew: 'pw:fill-new',
} as const;

export type Phase = 'setup' | 'locked' | 'unlocked';

export interface TabState {
  id: number;
  title: string;
  url: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Can this page be bookmarked / has a site (http/https)? */
  isWeb: boolean;
  bookmarked: boolean;
  blocked: number;
  /** 'on' blocking, 'paused' allowed for this site, 'off' disabled globally. */
  shield: 'on' | 'paused' | 'off';
  /** Show the key button: a login form is present or logins are saved for this site. */
  showKey: boolean;
}

export interface BarItem {
  id: number;
  type: 'folder' | 'link';
  title: string;
  url: string | null;
  description: string;
}

export interface SavePrompt {
  tabId: number;
  origin: string;
  username: string;
  update: boolean;
}

export interface UiState {
  phase: Phase;
  dataDir: string | null;
  tabs: TabState[];
  activeId: number | null;
  recordingPaused: boolean;
  showBookmarksBar: boolean;
  bookmarksBar: BarItem[];
  downloadsActive: number;
  savePrompt: SavePrompt | null;
}

export interface SetupDirResult {
  dir: string;
  /** The folder already holds MinBrowser data. */
  existing: boolean;
}

export type CommandResult = { ok: true; value?: unknown } | { ok: false; error: string };

export interface MinBrowserApi {
  platform: string;
  command(name: string, ...args: unknown[]): Promise<CommandResult>;
  onState(cb: (state: UiState) => void): void;
  onFocusAddress(cb: () => void): void;
  onStarRequest(cb: () => void): void;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the bookmark bubble shows. */
export interface PopupData {
  isNew: boolean;
  bookmark: { id: number; title: string; url: string; description: string; parentId: number };
  folders: { id: number; title: string; depth: number }[];
}
