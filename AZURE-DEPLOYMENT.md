# Azure App Service Deployment

## 1. Required environment variables

Set these application settings in Azure App Service:

- `SF_LOGIN_URL`
- `SF_API_VERSION`
- `SF_CLIENT_ID`
- `SF_CLIENT_SECRET` if your Salesforce Connected App requires it
- `EXTERNAL_BASE_URL`

Optional local-only settings:
- `DEV_BYPASS_USER_ID`
- `DEV_BYPASS_USER_NAME`
- `DEV_BYPASS_TENANT_ID`

## 2. Enable Microsoft authentication

Enable Azure App Service Authentication with Microsoft Entra ID.
The app expects Microsoft identity headers from App Service, including the
`x-ms-client-principal` payload or equivalent principal headers.

## 3. Configure Salesforce Connected App

Use this callback URL:

`https://<your-app>/auth/salesforce/callback`

Use OAuth scopes:
- `api`
- `refresh_token`
- `offline_access`

## 4. Build and run

```bash
npm install
npm run build
npm start
```

App Service should expose the app on `PORT`.

## 5. Connect a user

After Microsoft sign-in succeeds, each user must connect Salesforce once:

`https://<your-app>/auth/salesforce/start`

## 6. Federated connector target

Point the Microsoft 365 Copilot federated connector to:

`https://<your-app>/mcp`

If your Teams or Copilot host requires a Microsoft redirect flow, configure it at the
App Service / Microsoft Entra layer and keep `EXTERNAL_BASE_URL` aligned with the public URL.
