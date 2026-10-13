// Compatibility migration only; reception never depends on a mention now.
// Preserve the effective old @-only trigger policy using upstream's visible
// sliders, not a second hidden gate. No file writes or account/model changes.
export function migrateQQGroupReception(config, { official = false } = {}) {
  if (!official || !Object.hasOwn(config?.qqbot || {}, 'requireMention')) return config;
  const out = { ...config, qqbot: { ...config.qqbot } };
  const wasMentionOnly = out.qqbot.requireMention !== false;
  delete out.qqbot.requireMention;
  if (!wasMentionOnly) return out;
  const store = config.store || {};
  const map = (values, value) => Object.fromEntries(Object.keys(values || {}).map(key => [key, value()]));
  out.store = { ...store, contextTier: 1, contextSliderPos: 5, randomPercent: 0,
    groupSliderPos: map(store.groupSliderPos, () => 5),
    groupPeakPos: map(store.groupPeakPos, () => ({ peak: 5, valley: 5 })),
  };
  if (store.peakSchedule) out.store.peakSchedule = { ...store.peakSchedule,
    peak: { ...store.peakSchedule.peak, sliderPos: 5 },
    valley: { ...store.peakSchedule.valley, sliderPos: 5 },
  };
  return out;
}
