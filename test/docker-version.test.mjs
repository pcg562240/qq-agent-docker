import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('application and lockfile root versions follow the official source version', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const source = JSON.parse(read('docs/upstream-source.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, pkg.upstream.version);
  assert.equal(pkg.version, source.upstreamVersion);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('legacy packaging default follows the app without removing explicit version overrides', () => {
  const pkg = JSON.parse(read('package.json'));
  const defaultVersion = read('scripts/lib.sh').match(/^APP_VERSION="\$\{QL_APP_VERSION:-([^}]+)\}"$/m);
  assert.ok(defaultVersion, 'QL_APP_VERSION override must remain available');
  assert.equal(defaultVersion[1], pkg.version);
});
