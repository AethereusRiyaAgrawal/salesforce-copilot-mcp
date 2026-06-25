import type { ChartData, ChartType } from './types.js';

export function buildChartData(
  records: Record<string, unknown>[],
  chartType: ChartType
): ChartData {
  if (records.length === 0) {
    return {
      type: chartType,
      title: 'No data',
      labelField: 'label',
      valueField: 'value',
      series: [],
      meta: { total: 0, max: 0, min: 0, count: 0 },
    };
  }

  // Auto-detect numeric and label fields
  const keys = Object.keys(records[0]);
  const numericKeys = keys.filter(k =>
    typeof records[0][k] === 'number' && !['Id'].includes(k)
  );
  const labelKeys = keys.filter(k =>
    typeof records[0][k] === 'string' && !k.endsWith('Id')
  );

  const labelKey = labelKeys[0] || 'label';
  const valueKey = numericKeys[0] || 'value';
  const secondaryKey = numericKeys[1];

  const series = records.map(r => ({
    label:     String(r[labelKey] ?? ''),
    value:     Number(r[valueKey] ?? 0),
    secondary: secondaryKey ? Number(r[secondaryKey] ?? 0) : undefined,
    raw:       r,
  }));

  // For funnel charts, sort descending by value
  if (chartType === 'funnel') {
    series.sort((a, b) => b.value - a.value);
  }

  const values = series.map(r => r.value);

  return {
    type:       chartType,
    title:      `${valueKey} by ${labelKey}`,
    labelField: labelKey,
    valueField: valueKey,
    series,
    meta: {
      total:  values.reduce((s, v) => s + v, 0),
      max:    values.length > 0 ? Math.max(...values) : 0,
      min:    values.length > 0 ? Math.min(...values) : 0,
      count:  series.length,
    },
  };
}

export function buildPipelineFunnel(stageData: Record<string, unknown>[]): ChartData {
  const series = stageData.map(s => ({
    label:     String(s.StageName ?? s.stage ?? ''),
    value:     Number(s.TotalAmount ?? s.total_value ?? 0),
    secondary: Number(s.RecordCount ?? s.count ?? 0),
    raw:       s,
  }));

  const values = series.map(s => s.value);

  return {
    type: 'funnel',
    title: 'Pipeline by Stage',
    labelField: 'stage',
    valueField: 'total_value',
    series,
    meta: {
      total:  values.reduce((sum, v) => sum + v, 0),
      max:    values.length > 0 ? Math.max(...values) : 0,
      min:    values.length > 0 ? Math.min(...values) : 0,
      count:  series.length,
    },
  };
}
