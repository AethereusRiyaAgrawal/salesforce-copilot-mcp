import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sfFetch } from '../auth/salesforce.js';
import type { Env } from '../auth/salesforce.js';

export function registerActivityTool(server: McpServer, env: Env): void {
  server.tool(
    'list_recent_activity',
    'Lists recent CRM activity: tasks completed, emails logged, stage changes, new opportunities created. Use for "what happened this week" questions.',
    {
      days: z.number().min(1).max(90).default(7).describe('Number of days to look back'),
      activity_type: z.enum(['all', 'tasks', 'events', 'new_opps']).default('all'),
      limit: z.number().min(1).max(100).default(25),
    },
    async ({ days, activity_type, limit }) => {
      const apiVersion = env.SF_API_VERSION;

      const queries: Record<string, string> = {
        tasks: `
          SELECT Id, Subject, Status, ActivityDate, Who.Name, What.Name, Owner.Name
          FROM Task
          WHERE CreatedDate = LAST_N_DAYS:${days}
            AND IsClosed = true
          ORDER BY ActivityDate DESC
          LIMIT ${limit}
        `.trim(),
        events: `
          SELECT Id, Subject, StartDateTime, EndDateTime, Who.Name, What.Name, Owner.Name
          FROM Event
          WHERE CreatedDate = LAST_N_DAYS:${days}
          ORDER BY StartDateTime DESC
          LIMIT ${limit}
        `.trim(),
        new_opps: `
          SELECT Id, Name, StageName, Amount, CloseDate, Owner.Name, Account.Name, CreatedDate
          FROM Opportunity
          WHERE CreatedDate = LAST_N_DAYS:${days}
          ORDER BY CreatedDate DESC
          LIMIT ${limit}
        `.trim(),
      };

      const toFetch = activity_type === 'all'
        ? ['tasks', 'events', 'new_opps']
        : [activity_type].filter(t => queries[t]);

      const results: Record<string, unknown[]> = {};

      await Promise.all(
        toFetch.map(async (type) => {
          const q = queries[type];
          if (!q) return;
          const res = await sfFetch(
            env,
            `/services/data/${apiVersion}/query?q=${encodeURIComponent(q)}`
          );
          const data = await res.json() as { records: Record<string, unknown>[] };
          results[type] = (data.records || []).map(r => {
            const { attributes, ...clean } = r as Record<string, unknown> & { attributes?: unknown };
            return clean;
          });
        })
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ period_days: days, activity: results }, null, 2),
        }],
      };
    }
  );
}
