import { cleanUrlForHistory } from '../shared/url';
import type { HistoryService, Transition } from './history';

interface Current {
  visitId: number;
  startedAt: number;
}

/**
 * Turns tab navigation events into history rows: one visit per page, linked
 * to the page it came from, with how long it stayed open.
 */
export class HistoryRecorder {
  private current = new Map<number, Current>();

  constructor(
    private readonly history: () => HistoryService | null,
    private readonly paused: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  navigated(tabId: number, rawUrl: string, title: string, transition: Transition, openerTabId: number | null): void {
    const prev = this.current.get(tabId);
    // A reload is the same visit continuing, not a new one.
    if (transition === 'reload' && prev) return;
    const referrer = transition === 'link' ? (prev ?? (openerTabId !== null ? this.current.get(openerTabId) : undefined)) : undefined;
    this.finish(tabId);

    const history = this.history();
    const url = cleanUrlForHistory(rawUrl);
    if (!history || !url || this.paused()) return;
    const at = this.now();
    const visitId = history.add({
      url,
      title: title === rawUrl ? '' : title,
      at,
      transition,
      referrerId: referrer?.visitId ?? null,
      tabId,
    });
    this.current.set(tabId, { visitId, startedAt: at });
  }

  titleChanged(tabId: number, title: string): void {
    const cur = this.current.get(tabId);
    const history = this.history();
    if (cur && history && title) history.setTitle(cur.visitId, title);
  }

  /** The tab left its page (navigated away or closed): store how long it was open. */
  finish(tabId: number): void {
    const cur = this.current.get(tabId);
    if (!cur) return;
    this.current.delete(tabId);
    this.history()?.setDuration(cur.visitId, this.now() - cur.startedAt);
  }

  finishAll(): void {
    for (const id of [...this.current.keys()]) this.finish(id);
  }
}
