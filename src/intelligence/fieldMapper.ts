import type { ObjectSchema } from '../schema/crawler.js';

/**
 * Maps API field names to business labels for a given object.
 */
export function buildFieldMap(schema: ObjectSchema): Map<string, string> {
  const map = new Map<string, string>();
  for (const field of schema.fields) {
    map.set(field.apiName, field.label);
    map.set(field.apiName.toLowerCase(), field.label);
  }
  return map;
}

export function translateRecord(
  record: Record<string, unknown>,
  fieldMap: Map<string, string>,
): Record<string, unknown> {
  const translated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const label = fieldMap.get(key) || fieldMap.get(key.toLowerCase()) || key;
    translated[label] = value;
  }
  return translated;
}
