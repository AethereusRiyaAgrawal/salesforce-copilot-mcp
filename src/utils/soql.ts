const BLOCKED_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'MERGE',
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'EXEC',
];

export function sanitizeSOQL(soql: string): string {
  const upper = soql.toUpperCase().trim();

  if (!upper.startsWith('SELECT')) {
    throw new Error('Only SELECT queries are permitted.');
  }

  for (const kw of BLOCKED_KEYWORDS) {
    // Match as whole word to avoid false positives on field names
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      throw new Error(`Blocked keyword detected: ${kw}`);
    }
  }

  // Strip any attempt to chain additional statements
  const cleaned = soql.replace(/;\s*SELECT/gi, '').trim();

  // Add LIMIT if missing (safety cap at 200)
  if (!/LIMIT\s+\d+/i.test(cleaned)) {
    return `${cleaned} LIMIT 200`;
  }

  // Enforce max LIMIT of 1000
  return cleaned.replace(/LIMIT\s+(\d+)/i, (_, n) =>
    `LIMIT ${Math.min(parseInt(n, 10), 1000)}`
  );
}
