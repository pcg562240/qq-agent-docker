// Read-only maintenance gate. Inspects the Git INDEX, never publishes or edits files.
import fs from 'node:fs';
import { auditUpstreamInventory } from './upstream-inventory.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function auditRepositoryFiles(manifest, entries, knownSecrets = []) {
  const issues = [], files = new Map(entries.map(e => [e.path, e]));
  const fail = (file, reason) => issues.push({ file, reason }); // Never print a matched secret.
  for (const feature of manifest.features || []) {
    for (const file of [...feature.files, ...feature.tests]) {
      if (!files.has(file)) fail(file, `${feature.id}: required file missing from Git index`);
    }
  }
  const privatePath = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|node_modules|artifacts|data(?:-[^/]*)?|backups|local-private|legacy-backups)(\/|$)|\.(?:pem|key|p12|pfx|sqlite3?|db)(?:-(?:wal|shm))?$|\.log$|^ChatGPT 图像 .*\.png$/i;
  const runtimeRoot = /^(?:config\.json|shared-models\.json|robot-profiles\.json|robots\/|extensions\/|media\/|logs\/)/;
  for (const file of entries) {
    if ((privatePath.test(file.path) && file.path !== '.env.example') || runtimeRoot.test(file.path)) fail(file.path, 'private/runtime file must not be tracked');
    if (file.mode === '120000') fail(file.path, 'tracked symlink needs explicit review');
    const bytes = Buffer.from(file.bytes);
    if (bytes.length > 10 * 1024 * 1024) fail(file.path, 'large file requires separate distribution review');
    // Exact known local secrets are checked in binary files too.
    if (knownSecrets.some(s => typeof s === 'string' && s.length >= 8 && bytes.includes(Buffer.from(s)))) fail(file.path, 'contains a known local secret');
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    if (/^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/m.test(text)
      || /\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(text)
      || /\bgithub_pat_[A-Za-z0-9_]{50,}\b/.test(text)
      || /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/.test(text)) fail(file.path, 'possible credential literal; review without printing its value');
    if (file.path === '.env.example' && /^(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD))[ \t]*=[ \t]*[^\s#]+/m.test(text)) fail(file.path, 'example credentials must be blank');
  }
  return issues;
}

function git(args, input) { return execFileSync('git', args, { input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }); }
function readIndex() {
  const names = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean);
  const records = names.map(row => {
    const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(row);
    if (!match || match[3] !== '0') throw new Error('Git index has unresolved merge conflicts');
    return { mode: match[1], oid: match[2], path: match[4] };
  });
  const unique = [...new Set(records.map(r => r.oid))];
  const raw = git(['cat-file', '--batch'], unique.join('\n') + '\n');
  const contents = new Map(); let offset = 0;
  for (const oid of unique) {
    const end = raw.indexOf(10, offset), header = raw.subarray(offset, end).toString('ascii').split(' ');
    if (end < 0 || header[0] !== oid || header[1] !== 'blob') throw new Error('Unexpected Git object in index');
    const length = Number(header[2]); offset = end + 1;
    contents.set(oid, raw.subarray(offset, offset + length)); offset += length + 1;
  }
  return records.map(r => ({ ...r, bytes: contents.get(r.oid) }));
}
function localEnvSecrets() {
  if (!fs.existsSync('.env')) return [];
  return fs.readFileSync('.env', 'utf8').split(/\r?\n/).flatMap(line => {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD))\s*=\s*(.*?)\s*$/.exec(line);
    const value = match?.[2]?.replace(/^(['"])(.*)\1$/, '$2');
    return value && value.length >= 8 ? [value] : [];
  });
}
export function main({ publicSnapshot = false } = {}) {
  const root = git(['rev-parse', '--show-toplevel']).toString().replace(/\r?\n$/, '');
  // Do not trim ordinary spaces: this user's original directory ends in a space.
  process.chdir(root);
  const entries = readIndex();
  const manifestEntry = entries.find(e => e.path === 'docs/local-overrides.json');
  if (!manifestEntry) throw new Error('Stage docs/local-overrides.json and reviewed source files before running the audit');
  const manifest = JSON.parse(manifestEntry.bytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.features) || !manifest.features.length) throw new Error('Invalid local override manifest');
  // Public snapshots deliberately exclude the upstream history's old archives.
  // The private integration repository must still retain its exact baseline tag.
  const base = publicSnapshot ? manifest.upstream.commit
    : git(['rev-parse', `${manifest.upstream.tag}^{commit}`]).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(base) || base !== manifest.upstream.commit) throw new Error('Upstream baseline tag does not match the recorded commit');
  if (!publicSnapshot) git(['merge-base', '--is-ancestor', base, 'HEAD']);
  const issues = [...auditRepositoryFiles(manifest, entries, localEnvSecrets()),
    ...auditUpstreamInventory(entries, manifest)];
  if (issues.length) { console.error(JSON.stringify({ ok: false, issues }, null, 2)); process.exitCode = 1; return; }
  console.log(JSON.stringify({ ok: true, indexedFiles: entries.length, features: manifest.features.length,
    baseline: base, publicSnapshot, note: 'Index/path/credential checks passed; run test:local and review behavior separately.' }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main({ publicSnapshot: process.argv.includes('--public-snapshot') }); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
