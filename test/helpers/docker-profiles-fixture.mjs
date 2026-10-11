// Same production bootstrap ordering, but QQ and QR use offline test doubles.
import { prepareRobotProfiles } from '../../src/robot-profiles.js';
const p = prepareRobotProfiles(process.env.QQ_AGENT_DATA_DIR);
process.env.QQ_AGENT_PROFILES_ROOT = p.root;
process.env.QQ_AGENT_ACTIVE_ROBOT = p.id;
process.env.QQ_AGENT_DATA_DIR = p.dir;
await import('./docker-http-fixture.mjs');
