export interface AnomalyFlag {
  type: 'stale_stage' | 'past_close_date' | 'no_activity' | 'large_deal_risk' | 'forecast_mismatch';
  severity: 'high' | 'medium' | 'low';
  deal_name: string;
  deal_id?: string;
  message: string;
  recommended_action: string;
}

export function detectAnomalies(
  stageRecords: Record<string, unknown>[],
  riskRecords: Record<string, unknown>[]
): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];

  // Flag: stage has 0 deals but previous stage has many (likely log jam)
  for (let i = 1; i < stageRecords.length; i++) {
    const prev = stageRecords[i - 1] as Record<string, unknown>;
    const curr = stageRecords[i] as Record<string, unknown>;
    if (Number(prev.RecordCount) > 10 && Number(curr.RecordCount) === 0) {
      flags.push({
        type: 'stale_stage',
        severity: 'medium',
        deal_name: `${String(curr.StageName)} stage`,
        message: `Stage "${String(curr.StageName)}" has 0 deals while "${String(prev.StageName)}" has ${String(prev.RecordCount)}. Possible bottleneck.`,
        recommended_action: 'Review deals stuck in the preceding stage and identify blockers.',
      });
    }
  }

  // Flag: at-risk deals with large amounts
  for (const deal of riskRecords) {
    const rec = deal as Record<string, unknown>;
    if (!rec.Amount) continue;

    const amount = Number(rec.Amount);
    const severity: 'high' | 'medium' | 'low' =
      amount > 500000 ? 'high' : amount > 100000 ? 'medium' : 'low';

    flags.push({
      type: 'no_activity',
      severity,
      deal_name: String(rec.Name),
      deal_id: String(rec.Id),
      message: `${String(rec.Name)} (${formatCurrency(amount)}) has had no activity for ${String(rec.DaysSinceLastActivity ?? '14+')} days. Stage: ${String(rec.StageName)}.`,
      recommended_action: 'Schedule a follow-up call or send a check-in email this week.',
    });
  }

  // Sort by severity
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}
