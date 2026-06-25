import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { crawlObject } from '../schema/crawler.js';
import { getSchemaContext, setSchemaContext } from '../schema/cache.js';
import type { Env } from '../auth/salesforce.js';

export function registerDescribeTool(server: McpServer, env: Env): void {
  server.tool(
    'describe_object',
    'Returns full metadata for a Salesforce object: all fields with labels, types, picklist values, relationships, and business context. Use before querying an unfamiliar object.',
    {
      object_name: z.string().describe(
        'Salesforce API object name, e.g. "Opportunity", "Account", "My_Custom__c"'
      ),
      force_refresh: z.boolean().optional().default(false).describe(
        'Bypass cache and re-fetch from Salesforce Metadata API'
      ),
    },
    async ({ object_name, force_refresh }) => {
      if (!force_refresh) {
        const cached = await getSchemaContext(env, object_name);
        if (cached) {
          return {
            content: [{ type: 'text', text: JSON.stringify(cached, null, 2) }],
          };
        }
      }

      const schema = await crawlObject(env, object_name);
      await setSchemaContext(env, object_name, schema);

      return {
        content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }],
      };
    }
  );
}
