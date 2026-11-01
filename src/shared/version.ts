/**
 * Versions are shown as vMAJOR.MINOR: every change bumps the minor number
 * (v1.0 -> v1.1), a big change bumps the major (v1.4 -> v2.0). package.json
 * keeps the full semver form (1.1.0) that the packaging tools require.
 */
export function displayVersion(semver: string): string {
  const [major = '0', minor = '0'] = semver.split('.');
  return `v${major}.${minor}`;
}
