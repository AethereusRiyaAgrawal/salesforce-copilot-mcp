# Salesforce MCP for Microsoft 365 Copilot

This project hosts a remote MCP server for Microsoft 365 Copilot and Teams scenarios.
It preserves the existing Salesforce toolset and Salesforce OAuth flow, but removes the
Claude-specific OAuth broker and replaces it with Microsoft identity on Azure App Service.

## Exposed tools

- `query_salesforce`
- `describe_object`
- `get_pipeline_summary`
- `list_recent_activity`
- `detect_anomalies`
- `get_schema_context`

## Runtime architecture

Microsoft 365 Copilot / Teams
-> Federated connector
-> Azure App Service hosted MCP server
-> Salesforce REST APIs

## Authentication model

1. Microsoft identity is supplied to the app by Azure App Service Authentication.
2. The app resolves the signed-in Microsoft user from App Service headers.
3. That user starts Salesforce sign-in at `/auth/salesforce/start`.
4. Salesforce OAuth tokens are stored per Microsoft user session.
5. MCP requests on `/mcp` execute with that user's Salesforce session.

## Key endpoints

- `GET /health`
- `GET /auth/status`
- `GET /auth/salesforce/start`
- `GET /auth/salesforce/callback`
- `GET /auth/salesforce/disconnect`
- `POST /mcp`
- `GET /sse`
- `POST /message`

## Local development

1. Copy `.env.example` to `.env`.
2. Fill in Salesforce values.
3. For local testing only, set `DEV_BYPASS_USER_ID` and optionally the other `DEV_BYPASS_*` values.
4. Run `npm install`.
5. Run `npm run build` and `npm start`.
6. Open `http://localhost:3000/auth/salesforce/start` to connect Salesforce.

## Azure deployment

See `AZURE-DEPLOYMENT.md` for the Azure App Service and Microsoft 365 Copilot setup.
