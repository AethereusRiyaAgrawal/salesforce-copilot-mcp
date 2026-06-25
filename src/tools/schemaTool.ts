import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { crawlFullOrg } from '../schema/crawler.js';
import { getFullSchemaContext } from '../schema/cache.js';
import { buildSchemaPrompt } from '../intelligence/promptBuilder.js';
import type { Env } from '../auth/salesforce.js';

export function registerSchemaTool(server: McpServer, env: Env): void {
  server.tool(
    'get_schema_context',
    'Returns the full org schema context as structured prompt text or JSON. Call this first in a conversation to understand the org before querying.',
    {
      objects: z.array(z.string()).optional().describe(
        'Specific objects to describe. If omitted, returns full org schema summary.',
      ),
      format: z.enum(['prompt', 'json']).default('prompt').describe(
        'prompt = formatted for assistant context injection, json = raw schema data',
      ),
      force_refresh: z.boolean().optional().default(false),
    },
    async ({ objects, format, force_refresh }) => {
      if (force_refresh) {
        await crawlFullOrg(env);
      }

      const schema = await getFullSchemaContext(env, objects);

      if (format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }],
        };
      }

      const prompt = buildSchemaPrompt(schema);
      return {
        content: [{ type: 'text', text: prompt }],
      };
    },
  );
}
