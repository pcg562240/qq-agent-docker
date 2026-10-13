// Function-call arguments are always an object. Legacy no-argument skills often
// supplied {}, which permissive gateways accept but strict providers reject.
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Normalize the root only; never rewrite nested constraints or enable strict mode. */
export function normalizeToolParameters(parameters, toolName = 'unknown') {
  if (parameters == null) return { type: 'object', properties: {} };
  const invalid = reason => new Error(`工具 ${toolName} 的 parameters ${reason}`);
  if (!isRecord(parameters)) throw invalid('必须是 JSON Schema 对象');
  if (Object.hasOwn(parameters, 'type') && parameters.type !== 'object') {
    throw invalid('根类型必须为 type: "object"');
  }
  if (Object.hasOwn(parameters, 'properties') && !isRecord(parameters.properties)) {
    throw invalid('的 properties 必须是对象');
  }
  // Clone the containers we normalize; callers retain their original definition.
  return { ...parameters, type: 'object', properties: { ...parameters.properties } };
}
