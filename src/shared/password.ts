const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';

/** Uniform random index in [0, n) without modulo bias. */
function randomIndex(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/**
 * A strong random password with at least one character from each class.
 * Look-alike characters (l, 1, I, O, 0) are left out so it can be read aloud.
 */
export function generatePassword(length = 20, symbols = true): string {
  const sets = symbols ? [LOWER, UPPER, DIGITS, SYMBOLS] : [LOWER, UPPER, DIGITS];
  const all = sets.join('');
  const len = Math.max(length, sets.length);
  const chars = sets.map((s) => s[randomIndex(s.length)]);
  while (chars.length < len) chars.push(all[randomIndex(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Rough strength estimate for the master password form: 0 (weak) to 4 (strong). */
export function passwordStrength(pw: string): number {
  if (pw.length < 8) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  // Non-ASCII (e.g. Chinese) characters come from a far larger alphabet.
  if (/[^\x00-\x7f]/.test(pw)) pool += 1000;
  const unique = new Set(pw).size;
  const bits = Math.log2(Math.max(pool, 2)) * Math.min(pw.length, unique * 2);
  if (bits < 40) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}
