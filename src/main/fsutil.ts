import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';

/** Write a file so that a crash leaves either the old or the new version, never half of one. */
export function writeFileAtomic(path: string, data: Uint8Array | string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
