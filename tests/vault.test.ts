import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vault, WrongPasswordError } from '../src/main/vault';

const dir = () => mkdtempSync(join(tmpdir(), 'minb-vault-'));

describe('Vault', () => {
  it('unlocks with the right password and derives the same keys', async () => {
    const d = dir();
    const v = await Vault.create(d, 'correct horse battery');
    const k1 = v.key('db:history');
    v.lock();
    const v2 = await Vault.unlock(d, 'correct horse battery');
    expect(v2.key('db:history').equals(k1)).toBe(true);
    expect(v2.key('db:bookmarks').equals(k1)).toBe(false);
  });

  it('rejects the wrong password', async () => {
    const d = dir();
    await Vault.create(d, 'correct horse battery');
    await expect(Vault.unlock(d, 'wrong password!')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('rejects short passwords and refuses to overwrite', async () => {
    const d = dir();
    await expect(Vault.create(d, 'short')).rejects.toThrow();
    await Vault.create(d, 'long enough pw');
    await expect(Vault.create(d, 'long enough pw')).rejects.toThrow();
  });

  it('changes password without changing the data key', async () => {
    const d = dir();
    const v = await Vault.create(d, 'first password');
    const k = v.key('x');
    await expect(v.changePassword('not it', 'second password')).rejects.toThrow();
    await v.changePassword('first password', 'second password');
    await expect(Vault.unlock(d, 'first password')).rejects.toThrow();
    expect((await Vault.unlock(d, 'second password')).key('x').equals(k)).toBe(true);
  });

  it('stores no password material in clear', async () => {
    const d = dir();
    await Vault.create(d, 'my-master-password');
    expect(readFileSync(join(d, 'vault.meta'), 'utf8')).not.toContain('my-master-password');
  });

  it('cannot hand out keys once locked', async () => {
    const v = await Vault.create(dir(), 'some password');
    v.lock();
    expect(() => v.key('x')).toThrow();
  });
});
