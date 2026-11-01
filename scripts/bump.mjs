// Bump the version and add an entry to CHANGELOG.md.
//
//   npm run version:minor -- "说明这次改了什么"    v1.0 -> v1.1
//   npm run version:major -- "说明这次改了什么"    v1.4 -> v2.0
import { readFileSync, writeFileSync } from 'node:fs';

const [kind, ...words] = process.argv.slice(2);
const note = words.join(' ').trim();
if (!['minor', 'major'].includes(kind) || !note) {
  console.error('用法：npm run version:minor -- "这次改了什么"  （大改用 version:major）');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, minor] = pkg.version.split('.').map(Number);
const next = kind === 'major' ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
const shown = `v${next.split('.').slice(0, 2).join('.')}`;

// package.json and package-lock.json carry the same version.
for (const file of ['package.json', 'package-lock.json']) {
  const text = readFileSync(file, 'utf8');
  const data = JSON.parse(text);
  data.version = next;
  if (data.packages?.['']) data.packages[''].version = next;
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const date = new Date().toISOString().slice(0, 10);
const log = readFileSync('CHANGELOG.md', 'utf8');
const marker = '<!-- 新版本写在这一行下面 -->\n';
writeFileSync('CHANGELOG.md', log.replace(marker, `${marker}\n## ${shown} · ${date}\n\n- ${note}\n`));
console.log(`版本已更新为 ${shown}`);
