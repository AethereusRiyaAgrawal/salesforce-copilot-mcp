import type { ObjectSchema } from '../schema/crawler.js';

export function buildSchemaPrompt(schema: Record<string, ObjectSchema>): string {
  const lines: string[] = [
    '## Salesforce Org Schema Context',
    '',
    'You are connected to a live Salesforce org. Below is the complete schema.',
    'Always use business labels (not API names) when speaking to the user.',
    'When writing SOQL, use the API names shown in parentheses.',
    '',
  ];

  for (const [, obj] of Object.entries(schema)) {
    lines.push(`### ${obj.label} (${obj.apiName})${obj.isCustom ? ' [Custom Object]' : ''}`);

    if (obj.customFields.length === 0) {
      lines.push('_No custom fields — standard object with key fields below_');
    }

    for (const field of obj.fields) {
      let line = `- **${field.label}** (\`${field.apiName}\`) — ${field.type}`;

      if (field.picklistValues.length > 0) {
        line += `\n  Values: ${field.picklistValues.join(' | ')}`;
      }
      if (field.referenceTo.length > 0) {
        line += `\n  Relates to: ${field.referenceTo.join(', ')}`;
      }
      if (field.required) {
        line += ' _(required)_';
      }

      lines.push(line);
    }

    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('**Query rules:**');
  lines.push('- Always add LIMIT to prevent large result sets');
  lines.push('- Use WITH SECURITY_ENFORCED on all queries');
  lines.push('- Fiscal quarter filters: THIS_FISCAL_QUARTER, LAST_FISCAL_QUARTER');
  lines.push('- Date literals: TODAY, YESTERDAY, THIS_WEEK, LAST_N_DAYS:n');
  lines.push('- Aggregate functions: COUNT(), SUM(), AVG(), MIN(), MAX()');
  lines.push('- Relationship traversal: Account.Name, Owner.Name, etc.');

  return lines.join('\n');
}
