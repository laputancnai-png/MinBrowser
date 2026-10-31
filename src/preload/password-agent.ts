import { ipcRenderer } from 'electron';
import { Ipc } from '../shared/ipc';

/**
 * Detects login forms, notices when a password is submitted, and fills
 * passwords on request. It never puts saved data into the page's DOM except
 * the values it is explicitly asked to fill.
 */
export function startPasswordAgent(): void {
  const isVisible = (el: HTMLElement) => {
    if (el.hidden || el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const passwordFields = (): HTMLInputElement[] =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input[type=password]')).filter(
      (el) => isVisible(el) && !el.disabled && !el.readOnly,
    );

  const USERNAME_TYPES = new Set(['text', 'email', 'tel', '']);

  /** The username field that goes with a password field: the last text-like input before it. */
  const usernameFieldFor = (pw: HTMLInputElement): HTMLInputElement | null => {
    const scope: ParentNode = pw.form ?? document;
    const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>('input')).filter(
      (i) => USERNAME_TYPES.has(i.type) && isVisible(i) && !i.disabled,
    );
    const tagged = inputs.find((i) => /username|email/i.test(i.autocomplete));
    if (tagged) return tagged;
    let candidate: HTMLInputElement | null = null;
    for (const i of inputs) {
      if (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) candidate = i;
    }
    return candidate;
  };

  // ---- tell the browser whether this page has a login form
  let reported: boolean | null = null;
  const report = () => {
    const has = passwordFields().length > 0;
    if (has !== reported) {
      reported = has;
      ipcRenderer.send(Ipc.PwForms, has);
    }
  };
  let timer: number | undefined;
  const scheduleReport = () => {
    clearTimeout(timer);
    timer = window.setTimeout(report, 400);
  };
  document.addEventListener('DOMContentLoaded', () => {
    report();
    new MutationObserver(scheduleReport).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['type', 'style', 'class', 'hidden'],
    });
  });

  // ---- notice submissions
  let lastSent = '';
  let lastSentAt = 0;
  const capture = (origin: EventTarget | null) => {
    let fields = passwordFields().filter((p) => p.value);
    if (fields.length === 0) return;
    const form = origin instanceof Element ? origin.closest('form') : null;
    if (form) {
      const inForm = fields.filter((p) => p.form === form);
      if (inForm.length) fields = inForm;
    }
    // Sign-up and change-password forms: the last filled password is the new one.
    const pw = fields[fields.length - 1];
    const username = usernameFieldFor(fields[0])?.value.trim() ?? '';
    const key = `${username}\u0000${pw.value}`;
    if (key === lastSent && Date.now() - lastSentAt < 3000) return;
    lastSent = key;
    lastSentAt = Date.now();
    ipcRenderer.send(Ipc.PwSubmit, { username, password: pw.value });
  };

  document.addEventListener('submit', (e) => capture(e.target), true);
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const button = target?.closest('button, input[type=submit], input[type=button], [role=button]');
      if (button && !button.closest('[aria-label*="password" i], [aria-label*="密码"]')) capture(button);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) capture(e.target);
    },
    true,
  );

  // ---- fill on request
  const setValue = (el: HTMLInputElement, value: string) => {
    el.focus();
    // Go through the prototype setter so frameworks (React, Vue) see the change.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /** Prefer the form the user is working in. */
  const targetPasswordField = () => {
    const fields = passwordFields();
    const focused = document.activeElement;
    const focusedForm = focused instanceof HTMLElement ? focused.closest('form') : null;
    return fields.find((f) => f === focused) ?? fields.find((f) => focusedForm && f.form === focusedForm) ?? fields[0];
  };

  ipcRenderer.on(Ipc.PwFill, (_e, data: { username: string; password: string; auto?: boolean }) => {
    const pw = targetPasswordField();
    if (!pw) return;
    const user = usernameFieldFor(pw);
    // Filling on page load must never overwrite what the user already typed.
    if (data.auto && (pw.value || user?.value)) return;
    if (user && data.username) setValue(user, data.username);
    setValue(pw, data.password);
  });

  ipcRenderer.on(Ipc.PwFillNew, (_e, password: string) => {
    const pw = targetPasswordField();
    if (!pw) return;
    // Fill the new password and its confirmation field, but not a "current password" field.
    const siblings = passwordFields().filter((f) => f.form === pw.form && !/current-password/i.test(f.autocomplete));
    for (const f of siblings.length ? siblings : [pw]) setValue(f, password);
  });
}
