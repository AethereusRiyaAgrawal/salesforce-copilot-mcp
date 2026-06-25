import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../auth/salesforce.js';
import { registerQueryTool } from './queryTool.js';
import { registerDescribeTool } from './describeTool.js';
import { registerPipelineTool } from './pipelineTool.js';
import { registerActivityTool } from './activityTool.js';
import { registerAnomalyTool } from './anomalyTool.js';
import { registerSchemaTool } from './schemaTool.js';

export function registerAllTools(server: McpServer, env: Env): void {
  registerQueryTool(server, env);
  registerDescribeTool(server, env);
  registerPipelineTool(server, env);
  registerActivityTool(server, env);
  registerAnomalyTool(server, env);
  registerSchemaTool(server, env);
}
