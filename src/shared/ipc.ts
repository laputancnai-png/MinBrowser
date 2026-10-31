/** IPC channels between the browser UI and the main process. */
export const Ipc = {
  // UI -> main
  NewTab: 'tab:new',
  CloseTab: 'tab:close',
  ActivateTab: 'tab:activate',
  Navigate: 'tab:navigate',
  Back: 'tab:back',
  Forward: 'tab:forward',
  Reload: 'tab:reload',
  Stop: 'tab:stop',
  // main -> UI
  State: 'tabs:state',
  FocusAddress: 'ui:focus-address',
} as const;

export interface TabState {
  id: number;
  title: string;
  url: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface TabsState {
  tabs: TabState[];
  activeId: number | null;
}

export interface MinBrowserApi {
  platform: string;
  newTab(): void;
  closeTab(id: number): void;
  activateTab(id: number): void;
  navigate(input: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  onState(cb: (state: TabsState) => void): void;
  onFocusAddress(cb: () => void): void;
}
