import { ipcRenderer } from 'electron';
import { Ipc, LoginStep } from '../shared/ipc';

/**
 * Detects login forms, notices when a username or password is submitted, and
 * fills saved logins on request. It never puts saved data into the page's DOM
 * except the values it is explicitly asked to fill.
 *
 * Logins come in two shapes:
 *   - one page with a username and a password field;
 *   - several steps: first a page with only the username ("Next"), then a
 *     page (or the same page, later) with only the password.
 * The second shape is reported as a 'username' step and then a 'password'
 * step; the browser remembers the username in between.
 */
export function startPasswordAgent(): void {
  const isVisible = (el: HTMLElement) => {
    if (el.hidden || el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  // Read-only password fields count: some sites keep them read-only until
  // focused, to keep other password managers out.
  const passwordFields = (): HTMLInputElement[] =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input[type=password]')).filter((el) => isVisible(el) && !el.disabled);

  const USERNAME_TYPES = new Set(['text', 'email', 'tel', '']);
  const textInputs = (scope: ParentNode = document) =>
    Array.from(scope.querySelectorAll<HTMLInputElement>('input')).filter(
      (i) => USERNAME_TYPES.has(i.type) && isVisible(i) && !i.disabled,
    );

  /** The username field that goes with a password field: the last text-like input before it. */
  const usernameFieldFor = (pw: HTMLInputElement): HTMLInputElement | null => {
    const inputs = textInputs(pw.form ?? document);
    const tagged = inputs.find((i) => /username|email/i.test(i.autocomplete));
    if (tagged) return tagged;
    let candidate: HTMLInputElement | null = null;
    for (const i of inputs) {
      if (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) candidate = i;
    }
    return candidate;
  };

  const LOGIN_HINT = /user|login|e-?mail|account|acct|identifier|phone|mobile|账号|帐号|用户|邮箱|手机/i;

  /**
   * The first step of a multi-step login: no password field yet, and a single
   * input that is clearly for the account name. Kept strict so search boxes and
   * long sign-up forms aren't mistaken for logins.
   */
  const usernameOnlyField = (): HTMLInputElement | null => {
    if (passwordFields().length) return null;
    const inputs = textInputs();
    const tagged = inputs.filter((i) => /\b(username|email)\b/i.test(i.autocomplete));
    if (tagged.length === 1) return tagged[0];
    if (inputs.length === 0 || inputs.length > 3) return null;
    const hinted = inputs.filter((i) => {
      const words = [i.name, i.id, i.placeholder, i.getAttribute('aria-label') ?? '', i.autocomplete].join(' ');
      return i.type === 'email' || LOGIN_HINT.test(words);
    });
    return hinted.length === 1 ? hinted[0] : null;
  };

  /** A username the page keeps for password managers on the password step (often hidden). */
  const hiddenUsername = (): string =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input[autocomplete~="username"], input[autocomplete~="email"]'))
      .map((i) => i.value.trim())
      .find(Boolean) ?? '';

  const currentStep = (): LoginStep => (passwordFields().length ? 'password' : usernameOnlyField() ? 'username' : null);

  // ---- tell the browser what kind of login (if any) this page shows
  let reported: LoginStep | undefined;
  const report = () => {
    const step = currentStep();
    if (step !== reported) {
      reported = step;
      ipcRenderer.send(Ipc.PwForms, step);
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
      attributeFilter: ['type', 'style', 'class', 'hidden', 'disabled', 'readonly'],
    });
  });

  // ---- notice submissions
  let lastSent = '';
  let lastSentAt = 0;
  const once = (key: string) => {
    if (key === lastSent && Date.now() - lastSentAt < 3000) return false;
    lastSent = key;
    lastSentAt = Date.now();
    return true;
  };

  const capture = (origin: EventTarget | null) => {
    let fields = passwordFields().filter((p) => p.value);
    if (fields.length === 0) {
      // First step of a multi-step login: remember the username for the next step.
      const user = usernameOnlyField();
      const username = user?.value.trim();
      if (username && once(`u\u0000${username}`)) ipcRenderer.send(Ipc.PwUsername, username);
      return;
    }
    const form = origin instanceof Element ? origin.closest('form') : null;
    if (form) {
      const inForm = fields.filter((p) => p.form === form);
      if (inForm.length) fields = inForm;
    }
    // Sign-up and change-password forms: the last filled password is the new one.
    const pw = fields[fields.length - 1];
    // On a password-only step the browser fills in the username from the step before.
    const username = usernameFieldFor(fields[0])?.value.trim() || hiddenUsername();
    if (once(`${username}\u0000${pw.value}`)) ipcRenderer.send(Ipc.PwSubmit, { username, password: pw.value });
  };

  document.addEventListener('submit', (e) => capture(e.target), true);
  // "Next" isn't always a real button (links, divs with click handlers), so also
  // take the username as soon as the field is left with a value in it.
  document.addEventListener(
    'change',
    (e) => {
      const user = usernameOnlyField();
      if (user && e.target === user && user.value.trim() && once(`u\u0000${user.value.trim()}`)) {
        ipcRenderer.send(Ipc.PwUsername, user.value.trim());
      }
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const button = target?.closest('button, input[type=submit], input[type=button], [role=button], a');
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

  ipcRenderer.on(Ipc.PwFill, (_e, data: { username: string; password?: string; auto?: boolean }) => {
    const pw = targetPasswordField();
    if (pw) {
      // Filling by itself must never overwrite what the user (or the site) already put there.
      if (data.auto && pw.value) return;
      const user = usernameFieldFor(pw);
      if (user && data.username && !(data.auto && user.value)) setValue(user, data.username);
      if (data.password) setValue(pw, data.password);
      return;
    }
    // Username step: only the username, never a password on a page without a password field.
    const user = usernameOnlyField();
    if (!user || !data.username || (data.auto && user.value)) return;
    setValue(user, data.username);
  });

  ipcRenderer.on(Ipc.PwFillNew, (_e, password: string) => {
    const pw = targetPasswordField();
    if (!pw) return;
    // Fill the new password and its confirmation field, but not a "current password" field.
    const siblings = passwordFields().filter((f) => f.form === pw.form && !/current-password/i.test(f.autocomplete));
    for (const f of siblings.length ? siblings : [pw]) setValue(f, password);
  });
}
