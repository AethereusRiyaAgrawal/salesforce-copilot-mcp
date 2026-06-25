import { sfFetch } from '../auth/salesforce.js';
import { setFullSchemaContext } from './cache.js';
import type { Env } from '../auth/salesforce.js';

export interface FieldMeta {
  apiName: string;
  label: string;
  type: string;
  isCustom: boolean;
  picklistValues: string[];
  referenceTo: string[];
  length?: number;
  required: boolean;
}

export interface ObjectSchema {
  apiName: string;
  label: string;
  isCustom: boolean;
  keyPrefix: string;
  fields: FieldMeta[];
  customFields: FieldMeta[];
}

// Objects always included regardless of custom status
const KEY_STANDARD_OBJECTS = [
  'Opportunity', 'Account', 'Lead', 'Contact',
  'Case', 'Task', 'Event', 'Campaign',
];

const KEY_STANDARD_FIELDS = new Set([
  'Id', 'Name', 'OwnerId', 'CreatedDate', 'LastModifiedDate',
  'StageName', 'CloseDate', 'Amount', 'Probability', 'ForecastCategory',
  'LeadSource', 'Type', 'AccountId', 'ContactId', 'Status',
  'IsWon', 'IsClosed', 'LastActivityDate', 'DaysSinceLastActivity',
]);

export async function crawlObject(env: Env, objectName: string): Promise<ObjectSchema> {
  const res = await sfFetch(
    env,
    `/services/data/${env.SF_API_VERSION}/sobjects/${objectName}/describe`
  );

  if (!res.ok) {
    throw new Error(`Cannot describe ${objectName}: ${res.status} ${await res.text()}`);
  }

  const meta = await res.json() as {
    name: string;
    label: string;
    custom: boolean;
    keyPrefix: string;
    fields: Array<{
      name: string;
      label: string;
      type: string;
      custom: boolean;
      nillable: boolean;
      defaultedOnCreate: boolean;
      picklistValues: Array<{ active: boolean; value: string }>;
      referenceTo: string[];
      length: number;
    }>;
  };

  const allFields: FieldMeta[] = meta.fields
    .filter(f => f.custom || KEY_STANDARD_FIELDS.has(f.name))
    .map(f => ({
      apiName:        f.name,
      label:          f.label,
      type:           f.type,
      isCustom:       f.custom,
      required:       !f.nillable && !f.defaultedOnCreate,
      picklistValues: (f.type === 'picklist' || f.type === 'multipicklist')
        ? f.picklistValues.filter(p => p.active).map(p => p.value)
        : [],
      referenceTo:    f.referenceTo || [],
      length:         f.length,
    }));

  return {
    apiName:      meta.name,
    label:        meta.label,
    isCustom:     meta.custom,
    keyPrefix:    meta.keyPrefix,
    fields:       allFields,
    customFields: allFields.filter(f => f.isCustom),
  };
}

export async function crawlFullOrg(env: Env): Promise<Record<string, ObjectSchema>> {
  // Step 1: Global describe to find all queryable objects
  const globalRes = await sfFetch(env, `/services/data/${env.SF_API_VERSION}/sobjects`);
  const globalData = await globalRes.json() as {
    sobjects: Array<{ name: string; custom: boolean; queryable: boolean }>;
  };

  const objectNames: string[] = [
    ...KEY_STANDARD_OBJECTS,
    ...globalData.sobjects
      .filter(s => s.custom && s.queryable && s.name.endsWith('__c'))
      .map(s => s.name),
  ];

  const unique = [...new Set(objectNames)].slice(0, 40); // cap at 40 to stay within limits

  // Step 2: Describe each in batches to avoid rate limits
  const schema: Record<string, ObjectSchema> = {};
  const batchSize = 5;

  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(name => crawlObject(env, name))
    );

    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        const obj = result.value;
        schema[obj.apiName] = obj;
      } else {
        console.warn(`[crawler] Skipped ${batch[idx]}: ${String(result.reason)}`);
      }
    });
  }

  // Step 3: Persist to KV
  await setFullSchemaContext(env, schema);
  return schema;
}
