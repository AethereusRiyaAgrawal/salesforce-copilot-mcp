import type { Env } from '../auth/salesforce.js';
import type { ObjectSchema } from './crawler.js';

const SCHEMA_TTL = 60 * 60 * 6; // 6 hours
const FULL_SCHEMA_KEY = 'sf_full_schema';
const objectKey = (name: string) => `sf_schema_${name.toLowerCase()}`;

export async function getSchemaContext(
  env: Env,
  objectName: string
): Promise<ObjectSchema | null> {
  const raw = await env.KV.get(objectKey(objectName), 'json');
  return raw as ObjectSchema | null;
}

export async function setSchemaContext(
  env: Env,
  objectName: string,
  schema: ObjectSchema
): Promise<void> {
  await env.KV.put(objectKey(objectName), JSON.stringify(schema), {
    expirationTtl: SCHEMA_TTL,
  });
}

export async function getFullSchemaContext(
  env: Env,
  objects?: string[]
): Promise<Record<string, ObjectSchema>> {
  const raw = await env.KV.get(FULL_SCHEMA_KEY, 'json') as Record<string, ObjectSchema> | null;
  if (!raw) return {};

  if (objects && objects.length > 0) {
    return Object.fromEntries(
      Object.entries(raw).filter(([key]) =>
        objects.map(o => o.toLowerCase()).includes(key.toLowerCase())
      )
    );
  }

  return raw;
}

export async function setFullSchemaContext(
  env: Env,
  schema: Record<string, ObjectSchema>
): Promise<void> {
  await env.KV.put(FULL_SCHEMA_KEY, JSON.stringify(schema), {
    expirationTtl: SCHEMA_TTL,
  });
}
