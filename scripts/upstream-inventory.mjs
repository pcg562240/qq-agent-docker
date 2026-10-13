// Explicit maintenance command. Reads Git blobs only, never production data.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function auditUpstreamInventory(entries, overrides) {
  const files = new Map(entries.map(e => [e.path, e]));
  const issues = [];
  const read = name => JSON.parse(Buffer.from(files.get(name)?.bytes || '').toString('utf8'));
  try {
    const upstream = read('docs/upstream-source.json');
    const extensions = read('docs/extensions/catalog.json');
    if (upstream.commit !== overrides.upstream.commit || upstream.repository !== overrides.upstream.url) {
      issues.push({ file: 'docs/upstream-source.json', reason: 'official baseline metadata mismatch' });
    }
    if (!upstream.files?.length || !extensions.modules?.length) throw new Error('empty inventory');
    for (const record of upstream.files) {
      const entry = files.get(record.path);
      if (!entry) issues.push({ file: record.path, reason: 'official file removed; review the upstream inventory explicitly' });
      else if (entry.oid !== record.blob && !record.overlay) {
        issues.push({ file: record.path, reason: 'unrecorded modification of official source' });
      }
    }
    const extensionFiles = entries.filter(e => /^(?:skills|plugins|examples\/skills)\/.+\/(?:skill|plugin)\.json$/.test(e.path));
    for (const entry of extensionFiles) {
      const module = JSON.parse(Buffer.from(entry.bytes).toString('utf8'));
      const known = extensions.modules.find(m => m.manifest === entry.path);
      if (!known || known.id !== module.id || known.version !== module.version) {
        issues.push({ file: entry.path, reason: 'extension added/renamed/version changed; refresh its independent catalog' });
      }
    }
    for (const module of extensions.modules) {
      if (!files.has(module.manifest)) issues.push({ file: module.manifest, reason: 'catalogued extension missing from index' });
    }
  } catch {
    issues.push({ file: 'docs/upstream-source.json', reason: 'missing/invalid source or extension inventory' });
  }
  return issues;
}

const git = args => execFileSync('git', args, { maxBuffer: 16 * 1024 * 1024 });
function refresh() {
  const root = git(['rev-parse', '--show-toplevel']).toString().replace(/\r?\n$/, '');
  process.chdir(root);
  const manifest = JSON.parse(fs.readFileSync('docs/local-overrides.json', 'utf8'));
  const commit = manifest.upstream.commit;
  const previousPath = 'docs/upstream-source.json';
  const previous = fs.existsSync(previousPath) ? JSON.parse(fs.readFileSync(previousPath)) : {};
  const existing = new Map((previous.files || []).map(f => [f.path, f]));
  const files = git(['ls-tree', '-rz', commit]).toString().split('\0').filter(Boolean).map(row => {
    const [header, name] = row.split('\t');
    const [mode, , blob] = header.split(' ');
    if (!fs.existsSync(name)) throw new Error(`Missing official source: ${name}`);
    const current = execFileSync('git', ['hash-object', '--path', name, name]).toString().trim();
    const layer = name.startsWith('src/') ? 'core-adaptation'
      : name.startsWith('ui/') ? 'maintained-console'
      : name.startsWith('electron/') ? 'platform-compatibility'
      : name.startsWith('test/') ? 'test-fixture-compatibility' : 'delivery-and-documentation';
    return { path: name, mode, blob, ...(current !== blob ? {
      overlay: existing.get(name)?.overlay || layer
    } : {}) };
  });
  const upstream = { schemaVersion: 1, repository: manifest.upstream.url,
    branch: 'main', commit, upstreamVersion: '0.4.0',
    downstreamSource: manifest.migration.fromCommit, files };
  fs.writeFileSync(previousPath, JSON.stringify(upstream, null, 2) + '\n');
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0');
  const modules = [...new Set(paths)].filter(p => /^(?:skills|plugins|examples\/skills)\/.+\/(?:skill|plugin)\.json$/.test(p))
    .sort().map(manifestPath => {
      const m = JSON.parse(fs.readFileSync(manifestPath));
      return { manifest: manifestPath, id: m.id, version: m.version,
        distribution: manifestPath.startsWith('examples/') ? 'installable-example'
          : manifestPath.split('/').length > 3 ? 'nested-package-copy' : 'bundled',
        maintenance: /(?:chatgpt2api|search-aggregator|image-gen-skill|examples\/skills)/.test(manifestPath) || (manifest.features.find(f => f.id === 'L22')?.files || []).some(f => f.startsWith(path.posix.dirname(manifestPath) + '/'))
          ? 'downstream-maintained' : 'legacy-carried-forward' };
    });
  fs.mkdirSync('docs/extensions', { recursive: true });
  fs.writeFileSync('docs/extensions/catalog.json', JSON.stringify({ schemaVersion: 1,
    policy: 'independent-versioning; never overwrite installed modules or enable them during core upgrades',
    modules }, null, 2) + '\n');
  console.log(`Recorded ${files.length} official source files and ${modules.length} extension manifests. Review and stage both inventories.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { refresh(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
