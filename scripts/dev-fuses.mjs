// Turn on cookie encryption in the development copy of Electron (the one
// `npm start` runs). Packaged builds get all their fuses from
// electron-builder.yml; this only covers development, where cookies (your
// logged-in sessions) would otherwise be stored in plain text.
//
// Runs after `npm install`. The other fuses are left alone here because the
// test tooling relies on them (RunAsNode for unit tests, --inspect for e2e).
import { createRequire } from 'node:module';
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';

const require = createRequire(import.meta.url);
let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.warn('[dev-fuses] Electron not installed yet; skipping.');
  process.exit(0);
}

try {
  const wire = await getCurrentFuseWire(electronPath);
  // The wire stores '1' (enabled) / '0' (disabled) per fuse.
  if (String.fromCharCode(wire[FuseV1Options.EnableCookieEncryption]) === '1') {
    console.log('[dev-fuses] Cookie encryption already on.');
    process.exit(0);
  }
  await flipFuses(electronPath, {
    version: FuseVersion.V1,
    // Apple Silicon refuses to run a modified binary unless it is re-signed.
    resetAdHocDarwinSignature: process.platform === 'darwin',
    [FuseV1Options.EnableCookieEncryption]: true,
  });
  console.log('[dev-fuses] Cookie encryption turned on for development.');
} catch (err) {
  console.warn(`[dev-fuses] Could not set fuses (${err.message}); cookies stay unencrypted in development.`);
}
