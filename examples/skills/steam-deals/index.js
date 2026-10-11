// Installed at <profile>/extensions/skills/steam-deals, not /app/skills.
import { DATA_DIR, getConfig } from '../../src/config.js'
import { setSkillConfig } from '../../src/skills/config.js'
import { safeFetchBinary } from '../../src/safe-fetch.js'
import { createSkill } from './steam-runtime-v150.js'

const skill = createSkill({
  dataDir: DATA_DIR, downloadBinary: safeFetchBinary, setSkillConfig,
  translationConfig: () => {
    const c = getConfig()
    return { apiKey: c.dshProviderKeys?.[c.api?.provider] || c.api?.apiKey || '',
      baseUrl: c.api?.baseUrl || '', model: c.api?.model || '' }
  }
})
export const { setup, available, dispose } = skill
