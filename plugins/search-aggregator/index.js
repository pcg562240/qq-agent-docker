// Shared search capability; no startup requests and no duplicate credentials.
import {createAggregator} from './lib/runtime.js';
const plugin=createAggregator();
export const {setup,providers,available,activate,deactivate,dispose}=plugin;
