import { DATA_DIR } from '../../src/config.js';
import { createSearchSkill } from './runtime.js';
const skill = createSearchSkill({ dataDir:DATA_DIR });
export const { setup, available, modelCatalog, deactivate, activate, dispose, providers } = skill;
