import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as yaml from 'js-yaml';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('release compose uses a versioned GHCR image without altering isolation or data identity', () => {
  const local = yaml.load(read('compose.yaml')), release = yaml.load(read('compose.release.yaml'));
  assert.equal(release.name, local.name);
  const { image, ...service } = release.services['qq-agent'];
  const { image: _, build, ...localService } = local.services['qq-agent'];
  assert.match(image, /^\$\{QQ_AGENT_IMAGE:-ghcr\.io\/pcg562240\/qq-agent-docker:0\.4\.0-docker\.1\}$/);
  assert.equal(service.build, undefined);
  delete service.environment.QQ_AGENT_CONSOLE_TOKEN;
  delete localService.environment.QQ_AGENT_CONSOLE_TOKEN;
  assert.deepEqual(service, localService);
  assert.deepEqual(release.volumes, local.volumes);
  assert.match(read('compose.release.yaml'), /QQ_AGENT_CONSOLE_TOKEN:\s*\$\{QQ_AGENT_CONSOLE_TOKEN:\?/);
});

test('release workflow gates both native architectures on tests and image smoke checks', () => {
  const workflow = yaml.load(read('.github/workflows/publish-image.yml'));
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.push.branches, undefined);
  assert.deepEqual(workflow.on.push.tags, ['v*-docker.*']);
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(x => x.arch), ['amd64', 'arm64']);
  assert.deepEqual(workflow.jobs.build.permissions, { contents: 'read', packages: 'write' });
  assert.equal(workflow.jobs.manifest.needs, 'build');
  const steps = workflow.jobs.build.steps;
  assert.ok(steps.findIndex(x => x.run?.includes('release-smoke.sh')) < steps.findIndex(x => x.run?.includes('docker push')));
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps || []) {
    if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
  }
  assert.match(read('scripts/release-smoke.sh'), /--network none/);
  assert.match(read('scripts/release-smoke.sh'), /--read-only/);
});

test('release retains separate third-party notices and excludes personal avatar originals', () => {
  assert.match(read('Dockerfile'), /COPY package\.json prices\.json LICENSE THIRD_PARTY_NOTICES\.md/);
  assert.match(read('.dockerignore'), /^assets\/avatars\/$/m);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /UNLICENSED/);
  assert.match(read('docs/PUBLISHING.md'), /public:main/);
  assert.match(read('package.json'), /audit:public/);
});
