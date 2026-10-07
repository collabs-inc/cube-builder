import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
const manifest = JSON.parse(readFileSync('scripts/extraction-manifest.json', 'utf8'));
const recorded = new Set();
for (const entry of manifest) {
  assert.ok(existsSync(entry.file), `Missing adapted file: ${entry.file}`);
  assert.match(entry.revision, /^[a-f0-9]{40}$/);
  assert.ok(entry.source && !entry.source.startsWith('/') && !entry.source.includes('..'));
  assert.ok(!recorded.has(entry.file), `Duplicate provenance: ${entry.file}`); recorded.add(entry.file);
}
const failures = [];
for (const file of files) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bAKIA[A-Z0-9]{16}\b/.test(content)) failures.push(`${file}: possible credential`);
  if (/\/workspace\/home\/|\/Users\/[A-Za-z0-9_-]+\//.test(content)) failures.push(`${file}: machine-specific path`);
  if (file.startsWith('src/')) {
    if (/@cube\/|window\.api\b|process\.env\.(?:CUBE_|CUBED_)|(?:ptyd|cubed)\.sock/.test(content)) failures.push(`${file}: host interface dependency`);
    if (/\/\/ Adapted from|\/\* Adapted from/.test(content) && !recorded.has(file)) failures.push(`${file}: unrecorded adaptation`);
  }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
  assert.ok(!name.startsWith('@cube/') && !/^(?:file:|link:|workspace:|git\+ssh:)/.test(version), `Non-public dependency: ${name}`);
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
for (const [name, value] of Object.entries(lock.packages)) if (value.resolved) {
  assert.ok(value.resolved.startsWith('https://registry.npmjs.org/'), `Non-registry resolution: ${name}`);
}
const app = JSON.parse(readFileSync('cube.json', 'utf8'));
assert.equal(app.install, 'npm ci && npm run build'); assert.equal(app.start, 'node dist/server.js');
assert.deepEqual(app.platforms, ['linux', 'darwin']);
assert.deepEqual(failures, [], failures.join('\n'));
console.log(`Public-package checks passed: ${files.length} files, ${recorded.size} adapted files, public registry dependencies.`);
