import { DATA_DIR } from '../../src/config.js';
import { safeFetchBinary } from '../../src/safe-fetch.js';
import { createImageSkill } from './runtime.js';

const skill = createImageSkill({ dataDir: DATA_DIR, download: safeFetchBinary });
export const { setup, available, activate, deactivate, dispose, modelCatalog } = skill;
