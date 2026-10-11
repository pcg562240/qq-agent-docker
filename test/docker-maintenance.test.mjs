import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditRepositoryFiles } from '../scripts/check-local-overrides.mjs';
const manifest = { features: [{ id: 'L_TEST', files: ['src/required.js'], tests: ['test/required.mjs'] }] };
const file = (path, text = '', mode = '100644') => ({ path, bytes: Buffer.from(text), mode });
const base = [file('src/required.js'), file('test/required.mjs')];
test('maintenance gate accepts required source, blank example keys and binary favicon', () => {
  assert.deepEqual(auditRepositoryFiles(manifest, [...base, file('.env.example', 'QQ_AGENT_CONSOLE_TOKEN=\nQQBOT_APP_SECRET=\n'), file('ui/favicon.ico', '\0image')]), []);
});
test('maintenance gate rejects tracked runtime data, credentials, backups and symlinks', () => {
  for (const path of ['.env', '.env.local', 'artifacts/result.json', 'data/config.json', 'backups/data.tar', 'shared-models.json', 'robots/111/config.json', 'key.pem', 'ChatGPT 图像 test.png']) {
    assert.ok(auditRepositoryFiles(manifest, [...base, file(path)]).some(i => i.file === path));
  }
  assert.ok(auditRepositoryFiles(manifest, [...base, file('src/link', '/data/config.json', '120000')]).length);
});
test('maintenance gate detects known secrets and high-confidence credentials without echoing values', () => {
  const secret = ['PRIVATE', 'LOCAL', 'VALUE', '123456789'].join('_');
  const findings = auditRepositoryFiles(manifest, [...base, file('src/leak.js', `value=${secret}`)], [secret]);
  assert.equal(findings.length, 1); assert.ok(!JSON.stringify(findings).includes(secret));
  for (const text of [['-----BEGIN ', 'PRIVATE KEY-----'].join(''), 'ghp_' + 'A'.repeat(40), 'sk-' + 'a'.repeat(40)]) {
    assert.ok(auditRepositoryFiles(manifest, [...base, file('src/leak.js', text)]).length);
  }
});
test('maintenance gate detects missing protected files and filled sample credentials', () => {
  assert.ok(auditRepositoryFiles(manifest, []).some(i => i.reason.startsWith('L_TEST')));
  assert.ok(auditRepositoryFiles(manifest, [...base, file('.env.example', 'QQBOT_APP_SECRET=must-be-empty')]).length);
});
