type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export function log(level: LogLevel, message: string, data?: unknown): void {
  const entry: Record<string, unknown> = {
    ts:      new Date().toISOString(),
    level,
    message,
  };
  if (data !== undefined) {
    entry.data = data;
  }

  const fn =
    level === 'error' ? console.error :
    level === 'warn'  ? console.warn  :
    console.log;

  fn(JSON.stringify(entry));
}
