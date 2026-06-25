import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sfFetch } from '../auth/salesforce.js';
import { getSchemaContext } from '../schema/cache.js';
import { detectAnomalies } from '../intelligence/anomalyDetector.js';
import type { Env } from '../auth/salesforce.js';

export function registerPipelineTool(server: McpServer, env: Env): void {
  server.tool(
    'get_pipeline_summary',
    'Returns a complete sales pipeline summary: stage distribution, total value, weighted pipeline, deals at risk, and comparison to previous period. Always use this for pipeline questions.',
    {
      period: z.enum(['this_quarter', 'next_quarter', 'this_month', 'custom']).default('this_quarter'),
      custom_filter: z.string().optional().describe(
        'Additional SOQL WHERE clause fragment, e.g. "OwnerId = \'005xx\'" or "Region__c = \'North\'"'
      ),
      owner_id: z.string().optional().describe('Filter by specific user ID'),
      include_closed: z.boolean().optional().default(false),
    },
    async ({ period, custom_filter, owner_id, include_closed }) => {
      const periodFilter = {
        this_quarter: 'CloseDate = THIS_FISCAL_QUARTER',
        next_quarter:  'CloseDate = NEXT_FISCAL_QUARTER',
        this_month:    'CloseDate = THIS_MONTH',
        custom:        '',
      }[period];

      const closedFilter = include_closed ? '' : 'AND IsClosed = false';
      const ownerFilter  = owner_id ? `AND OwnerId = '${owner_id}'` : '';
      const customWhere  = custom_filter ? `AND ${custom_filter}` : '';

      const apiVersion = env.SF_API_VERSION;

      // Stage distribution query
      const stageSOQL = `
        SELECT StageName, COUNT(Id) RecordCount, SUM(Amount) TotalAmount,
               SUM(Amount * Probability / 100) WeightedAmount
        FROM Opportunity
        WHERE ${periodFilter} ${closedFilter} ${ownerFilter} ${customWhere}
        GROUP BY StageName
        ORDER BY SUM(Amount) DESC
      `.trim();

      // At-risk deals: no activity in 14+ days, not closed
      const riskSOQL = `
        SELECT Id, Name, StageName, Amount, CloseDate, Owner.Name,
               LastActivityDate, DaysSinceLastActivity
        FROM Opportunity
        WHERE ${periodFilter}
          AND IsClosed = false
          AND (LastActivityDate < LAST_N_DAYS:14 OR LastActivityDate = null)
          AND Amount > 0
        ORDER BY Amount DESC
        LIMIT 20
      `.trim();

      // Previous period comparison
      const prevPeriodFilter = {
        this_quarter: 'CloseDate = LAST_FISCAL_QUARTER',
        next_quarter:  'CloseDate = THIS_FISCAL_QUARTER',
        this_month:    'CloseDate = LAST_MONTH',
        custom:        '',
      }[period];

      const prevSOQL = prevPeriodFilter ? `
        SELECT SUM(Amount) TotalAmount, COUNT(Id) RecordCount
        FROM Opportunity
        WHERE ${prevPeriodFilter} AND IsWon = true
      `.trim() : null;

      const [stageRes, riskRes, prevRes] = await Promise.all([
        sfFetch(env, `/services/data/${apiVersion}/query?q=${encodeURIComponent(stageSOQL)}`),
        sfFetch(env, `/services/data/${apiVersion}/query?q=${encodeURIComponent(riskSOQL)}`),
        prevSOQL
          ? sfFetch(env, `/services/data/${apiVersion}/query?q=${encodeURIComponent(prevSOQL)}`)
          : Promise.resolve(null),
      ]);

      const stageData = await stageRes.json() as { records: Record<string, unknown>[] };
      const riskData  = await riskRes.json() as { records: Record<string, unknown>[] };
      const prevData  = prevRes ? await prevRes.json() as { records: Record<string, unknown>[] } : null;

      const schema = await getSchemaContext(env, 'Opportunity');
      const anomalies = detectAnomalies(stageData.records, riskData.records);

      const totalPipeline = stageData.records.reduce(
        (sum: number, r) => sum + (Number((r as Record<string, unknown>).TotalAmount) || 0), 0
      );
      const weightedPipeline = stageData.records.reduce(
        (sum: number, r) => sum + (Number((r as Record<string, unknown>).WeightedAmount) || 0), 0
      );

      const result = {
        summary: {
          period,
          total_pipeline_value: totalPipeline,
          weighted_pipeline_value: weightedPipeline,
          total_opportunities: stageData.records.reduce(
            (sum: number, r) => sum + (Number((r as Record<string, unknown>).RecordCount) || 0), 0
          ),
          previous_period_closed_won:
            (prevData?.records?.[0] as Record<string, unknown> | undefined)?.TotalAmount || 0,
        },
        stage_breakdown: stageData.records.map(r => {
          const rec = r as Record<string, unknown>;
          return {
            stage: rec.StageName,
            count: rec.RecordCount,
            total_value: rec.TotalAmount,
            weighted_value: rec.WeightedAmount,
            pct_of_pipeline: totalPipeline > 0
              ? Math.round((Number(rec.TotalAmount) / totalPipeline) * 100)
              : 0,
          };
        }),
        at_risk_deals: riskData.records.map(r => {
          const rec = r as Record<string, unknown> & { Owner?: Record<string, unknown> };
          return {
            id: rec.Id,
            name: rec.Name,
            stage: rec.StageName,
            amount: rec.Amount,
            close_date: rec.CloseDate,
            owner: rec.Owner?.Name,
            days_since_activity: rec.DaysSinceLastActivity,
          };
        }),
        anomalies,
        custom_field_context: schema?.customFields?.slice(0, 10) || [],
        chart: {
          type: 'funnel',
          title: `Pipeline by Stage — ${period.replace(/_/g, ' ')}`,
          data: stageData.records.map(r => {
            const rec = r as Record<string, unknown>;
            return {
              label: rec.StageName,
              value: rec.TotalAmount,
              count: rec.RecordCount,
            };
          }),
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
