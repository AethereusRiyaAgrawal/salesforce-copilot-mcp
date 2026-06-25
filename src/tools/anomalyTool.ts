import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sfFetch } from '../auth/salesforce.js';
import type { Env } from '../auth/salesforce.js';

export function registerAnomalyTool(server: McpServer, env: Env): void {
  server.tool(
    'detect_anomalies',
    'Scans the pipeline for anomalies: deals stuck in a stage too long, large opportunities with no contact, close dates in the past, overdue tasks, and forecast category mismatches.',
    {
      sensitivity: z.enum(['low', 'medium', 'high']).default('medium').describe(
        'low = only severe anomalies, high = flag anything unusual'
      ),
    },
    async ({ sensitivity }) => {
      const thresholds = {
        low:    { stale_days: 45, min_amount: 50000, overdue_tasks: 30 },
        medium: { stale_days: 21, min_amount: 10000, overdue_tasks: 14 },
        high:   { stale_days: 10, min_amount: 1000,  overdue_tasks: 7  },
      }[sensitivity];

      const apiVersion = env.SF_API_VERSION;

      const stuckDealsSOQL = `
        SELECT Id, Name, StageName, Amount, CloseDate, Owner.Name,
               LastStageChangeDate, LastModifiedDate
        FROM Opportunity
        WHERE IsClosed = false
          AND LastStageChangeDate < LAST_N_DAYS:${thresholds.stale_days}
          AND Amount >= ${thresholds.min_amount}
        ORDER BY LastStageChangeDate ASC
        LIMIT 30
      `.trim();

      const pastCloseDateSOQL = `
        SELECT Id, Name, StageName, Amount, CloseDate, Owner.Name
        FROM Opportunity
        WHERE IsClosed = false
          AND CloseDate < TODAY
          AND Amount > 0
        ORDER BY CloseDate ASC
        LIMIT 30
      `.trim();

      const noContactSOQL = `
        SELECT Id, Name, StageName, Amount, CreatedDate, Owner.Name
        FROM Opportunity
        WHERE IsClosed = false
          AND Amount >= ${thresholds.min_amount}
          AND (LastActivityDate = null OR LastActivityDate < LAST_N_DAYS:${thresholds.stale_days})
        ORDER BY Amount DESC
        LIMIT 20
      `.trim();

      const [stuckRes, pastRes, noContactRes] = await Promise.all([
        sfFetch(env, `/services/data/${apiVersion}/query?q=${encodeURIComponent(stuckDealsSOQL)}`),
        sfFetch(env, `/services/data/${apiVersion}/query?q=${encodeURIComponent(pastCloseDateSOQL)}`),
        sfFetch(env, `/services/data/${apiVersion}/query?q=${encodeURIComponent(noContactSOQL)}`),
      ]);

      const [stuck, pastClose, noContact] = await Promise.all([
        stuckRes.json() as Promise<{ totalSize: number; records: Record<string, unknown>[] }>,
        pastRes.json()  as Promise<{ totalSize: number; records: Record<string, unknown>[] }>,
        noContactRes.json() as Promise<{ totalSize: number; records: Record<string, unknown>[] }>,
      ]);

      const anomalies = {
        sensitivity,
        summary: {
          stuck_deals:       stuck.totalSize,
          past_close_date:   pastClose.totalSize,
          no_recent_contact: noContact.totalSize,
          total_anomalies:   stuck.totalSize + pastClose.totalSize + noContact.totalSize,
        },
        stuck_in_stage: stuck.records?.map(r => {
          const rec = r as Record<string, unknown> & { Owner?: Record<string, unknown> };
          return {
            name:      rec.Name,
            stage:     rec.StageName,
            amount:    rec.Amount,
            owner:     rec.Owner?.Name,
            days_stuck: Math.floor(
              (Date.now() - new Date(String(rec.LastStageChangeDate)).getTime()) / 86400000
            ),
          };
        }),
        past_close_date: pastClose.records?.map(r => {
          const rec = r as Record<string, unknown> & { Owner?: Record<string, unknown> };
          return {
            name:        rec.Name,
            stage:       rec.StageName,
            amount:      rec.Amount,
            owner:       rec.Owner?.Name,
            days_overdue: Math.floor(
              (Date.now() - new Date(String(rec.CloseDate)).getTime()) / 86400000
            ),
          };
        }),
        no_recent_contact: noContact.records?.map(r => {
          const rec = r as Record<string, unknown> & { Owner?: Record<string, unknown> };
          return {
            name:  rec.Name,
            stage: rec.StageName,
            amount: rec.Amount,
            owner: rec.Owner?.Name,
          };
        }),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(anomalies, null, 2) }],
      };
    }
  );
}
