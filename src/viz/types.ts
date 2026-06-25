export type ChartType = 'bar' | 'funnel' | 'line' | 'pie' | 'table';

export interface ChartSeries {
  label: string;
  value: number;
  secondary?: number;
  color?: string;
  raw?: Record<string, unknown>;
}

export interface ChartData {
  type: ChartType;
  title: string;
  labelField: string;
  valueField: string;
  series: ChartSeries[];
  meta: {
    total: number;
    max: number;
    min: number;
    count: number;
  };
}
