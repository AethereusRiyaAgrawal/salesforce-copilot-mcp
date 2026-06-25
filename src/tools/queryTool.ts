import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sfFetch } from '../auth/salesforce.js';
import { sanitizeSOQL } from '../utils/soql.js';
import { buildChartData } from '../viz/chartBuilder.js';
import type { Env } from '../auth/salesforce.js';

export function registerQueryTool(server: McpServer, env: Env): void {
  server.tool(
    'query_salesforce',
    'Execute a SOQL query against the Salesforce org and return results with optional chart data. Use for any data retrieval - opportunities, accounts, cases, custom objects.',
    {
      soql: z.string().describe(
        'Valid SOQL query. Must start with SELECT. LIMIT is auto-applied if missing.',
      ),
      include_chart: z.boolean().optional().default(false).describe(
        'If true, returns chart-ready JSON alongside records for bar, funnel, line, or pie visualization.',
      ),
      chart_type: z.enum(['bar', 'funnel', 'line', 'pie']).optional().default('bar'),
    },
    async ({ soql, include_chart, chart_type }) => {
      try {
        const safeSoql = sanitizeSOQL(soql);
        const res = await sfFetch(
          env,
          `/services/data/${env.SF_API_VERSION}/query?q=${encodeURIComponent(safeSoql)}`,
        );

        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{
              type: 'text',
              text: `SOQL error: ${err}\n\nQuery attempted:\n${safeSoql}`,
            }],
            isError: true,
          };
        }

        const data = await res.json() as { totalSize: number; records: Record<string, unknown>[]; nextRecordsUrl?: string };

        const cleaned = data.records.map(r => {
          const { attributes, ...rest } = r as Record<string, unknown> & { attributes?: unknown };
          return rest;
        });

        const maxInline = 50;
        const truncated = cleaned.length > maxInline;
        const records = truncated ? cleaned.slice(0, maxInline) : cleaned;

        const result: Record<string, unknown> = {
          total_size: data.totalSize,
          returned: records.length,
          truncated,
          records,
          soql_executed: safeSoql,
        };

        if (truncated) {
          result.note = `Response capped at ${maxInline} records to fit context. Add LIMIT ${maxInline} or a more specific WHERE clause to refine the result.`;
        }

        if (data.nextRecordsUrl) {
          result.has_more_pages = true;
        }

        if (include_chart && records.length > 0) {
          result.chart = buildChartData(records, chart_type ?? 'bar');
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
