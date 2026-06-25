# User Guide

## Before you start

You need:
- a deployed Azure App Service instance for this MCP server
- Azure App Service Authentication enabled with Microsoft Entra ID
- a Salesforce Connected App configured with this callback URL:
  `https://<your-app>/auth/salesforce/callback`

## Connect Salesforce for your Microsoft 365 user

1. Sign in through your Microsoft 365 Copilot or Teams experience.
2. Open `https://<your-app>/auth/status` and confirm Microsoft authentication is active.
3. Open `https://<your-app>/auth/salesforce/start`.
4. Sign in to Salesforce and approve access.
5. After the success page appears, return to Microsoft 365 Copilot.

## Validate MCP access

- Health: `https://<your-app>/health`
- Auth status: `https://<your-app>/auth/status`
- MCP endpoint: `https://<your-app>/mcp`

## Available tools

- `query_salesforce`
- `describe_object`
- `get_pipeline_summary`
- `list_recent_activity`
- `detect_anomalies`
- `get_schema_context`

## Disconnect Salesforce

Open `https://<your-app>/auth/salesforce/disconnect` while signed in with the same Microsoft user.
