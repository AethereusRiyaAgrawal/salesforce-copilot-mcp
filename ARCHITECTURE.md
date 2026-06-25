# Architecture

## Target topology

Microsoft 365 Copilot / Teams
-> Federated connector
-> Azure App Service
-> Express-based MCP server
-> Salesforce REST API

## What changed

The old project acted as an OAuth broker for Claude by exposing:
- `/.well-known/oauth-authorization-server`
- `/oauth/authorize`
- `/oauth/token`
- `/oauth/register`
- `/oauth/start`

That broker is removed.

The new server keeps the MCP tool surface and Salesforce OAuth logic, but now:
- trusts Microsoft identity from Azure App Service Authentication
- stores Salesforce tokens per Microsoft user
- starts Salesforce sign-in from `/auth/salesforce/start`
- invokes MCP tools from `/mcp` only after both Microsoft and Salesforce identity are present

## Identity model

- Microsoft identity: provided by Azure App Service / Microsoft Entra ID
- Salesforce identity: OAuth Authorization Code + PKCE using `SF_CLIENT_ID` and optional `SF_CLIENT_SECRET`
- Session key: `<tenantId>:<userId>`

## Tool discovery and invocation

Tool registration remains centralized in `src/tools/index.ts`.
The server still uses `McpServer` from `@modelcontextprotocol/sdk` and keeps:
- `tools/list`
- `tools/call`
- `POST /mcp`
- `GET /sse`
- `POST /message`

## Storage notes

- Salesforce access and refresh tokens remain in the in-process session store.
- Schema and non-token KV data are now scoped per Microsoft user.
- For multi-instance production deployments, move the in-memory stores to Redis or another shared backing store.
