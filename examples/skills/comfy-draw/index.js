// At installation this lives in <profile>/extensions/skills/comfy-draw.
// module-paths.js supplies extensions/src -> /app/src for community skill compatibility.
import { DATA_DIR } from '../../src/config.js';
import { safeFetchBinary } from '../../src/safe-fetch.js';
import { createSkill } from './lib/qwen21-runtime.js';

const skill = createSkill({ dataDir: DATA_DIR, downloadReference: safeFetchBinary });
export const { setup, available, activate, deactivate, dispose } = skill;
