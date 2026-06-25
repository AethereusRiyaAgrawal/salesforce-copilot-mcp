import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/index.js';
import {
  buildOAuthUrl,
  exchangeCodeForTokens,
  generatePKCE,
  kv,
  InMemoryKV,
} from './auth/salesforce.js';
import type { Env } from './auth/salesforce.js';
import { getMicrosoftPrincipal, toPrincipalKey } from './auth/microsoft.js';
import type { MicrosoftPrincipal } from './auth/microsoft.js';
import {
  createOrUpdateSession,
  getSession,
  deleteSession,
  createPendingAuth,
  getPendingAuth,
  deletePendingAuth,
  SessionBackedKV,
} from './auth/sessions.js';
import { log } from './utils/logger.js';

function buildEnv(): Env {
  const required = ['SF_LOGIN_URL', 'SF_API_VERSION', 'SF_CLIENT_ID'];
  for (const name of required) {
    if (!process.env[name]) {
      console.error(`Missing required env var: ${name}`);
      process.exit(1);
    }
  }

  return {
    SF_LOGIN_URL: process.env.SF_LOGIN_URL!,
    SF_API_VERSION: process.env.SF_API_VERSION!,
    SF_CLIENT_ID: process.env.SF_CLIENT_ID!,
    SF_CLIENT_SECRET: process.env.SF_CLIENT_SECRET,
    EXTERNAL_BASE_URL: process.env.EXTERNAL_BASE_URL,
    MCP_API_KEY: process.env.MCP_API_KEY,
    DEV_BYPASS_USER_ID: process.env.DEV_BYPASS_USER_ID,
    DEV_BYPASS_USER_NAME: process.env.DEV_BYPASS_USER_NAME,
    DEV_BYPASS_TENANT_ID: process.env.DEV_BYPASS_TENANT_ID,
    KV: kv,
  };
}

const env = buildEnv();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, X-MS-CLIENT-PRINCIPAL',
};

const MCP_PROTOCOL_VERSION = '2024-11-05';

class StatelessTransport {
  private outbox: unknown[] = [];
  private waiters: Array<(msgs: unknown[]) => void> = [];

  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: unknown): Promise<void> {
    this.outbox.push(message);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(this.outbox.splice(0));
    }
  }

  private waitForAny(): Promise<unknown[]> {
    if (this.outbox.length > 0) {
      return Promise.resolve(this.outbox.splice(0));
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }

  async inject(message: unknown, timeoutMs = 55000): Promise<unknown[]> {
    const hasId =
      typeof message === 'object' &&
      message !== null &&
      'id' in message &&
      (message as Record<string, unknown>).id != null;

    if (!hasId) {
      this.onmessage?.(message);
      return [];
    }

    const waitPromise = this.waitForAny();
    this.onmessage?.(message);

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP request timed out after ${timeoutMs}ms`)), timeoutMs),
    );

    return Promise.race([waitPromise, timeoutPromise]);
  }
}

interface AuthedRequest extends Request {
  userEnv: Env;
  principal: MicrosoftPrincipal;
  principalKey: string;
}

async function processMcpRequest(body: unknown, reqEnv: Env): Promise<unknown> {
  const transport = new StatelessTransport();
  const server = new McpServer({
    name: 'salesforce-m365-mcp',
    version: '1.0.0',
  });
  registerAllTools(server, reqEnv);
  await server.connect(transport);

  try {
    const method =
      typeof body === 'object' && body !== null && 'method' in body
        ? (body as Record<string, unknown>).method
        : undefined;

    if (method !== 'initialize') {
      await transport.inject({
        jsonrpc: '2.0',
        id: '__init__',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'azure-app-service-proxy', version: '1.0.0' },
        },
      });
      await transport.inject({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }

    const responses = await transport.inject(body);
    if (responses.length === 0) return null;
    return responses.length === 1 ? responses[0] : responses;
  } finally {
    await server.close().catch(() => {});
  }
}

function getBase(req: Request): string {
  return env.EXTERNAL_BASE_URL?.trim() || `${req.protocol}://${req.get('host')}`;
}

function requirePrincipal(req: Request, res: Response): { principal: MicrosoftPrincipal; principalKey: string } | null {
  // If MCP_API_KEY is configured, validate it before identity extraction.
  // Copilot (or any client) must send: Authorization: Bearer <MCP_API_KEY>
  if (env.MCP_API_KEY) {
    const authHeader = req.header('authorization');
    const supplied = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    if (supplied !== env.MCP_API_KEY) {
      res.status(401).json({
        error: 'invalid_api_key',
        error_description: 'A valid MCP_API_KEY is required. Set Authorization: Bearer <key> on your request.',
      });
      return null;
    }
  }

  const principal = getMicrosoftPrincipal(req, env);
  if (!principal) {
    res.status(401).json({
      error: 'microsoft_auth_required',
      error_description: 'Microsoft identity is required. On Azure: enable App Service Authentication. Elsewhere: set DEV_BYPASS_USER_ID or send an Azure AD Bearer token.',
    });
    return null;
  }

  return {
    principal,
    principalKey: toPrincipalKey(principal),
  };
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.options('*', (_req, res) => {
  res.set(CORS_HEADERS).status(204).end();
});

app.use((_req, res, next) => {
  res.set(CORS_HEADERS);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now(), version: '1.0.0' });
});

app.get('/auth/status', (req: Request, res: Response) => {
  const auth = requirePrincipal(req, res);
  if (!auth) return;

  const session = getSession(auth.principalKey);
  res.json({
    microsoft_authenticated: true,
    salesforce_connected: Boolean(session),
    user: auth.principal,
    authorization_url: `${getBase(req)}/auth/salesforce/start`,
    mcp_endpoint: `${getBase(req)}/mcp`,
  });
});

app.get('/auth/salesforce/start', async (req: Request, res: Response) => {
  const auth = requirePrincipal(req, res);
  if (!auth) return;

  try {
    const state = createPendingAuth(auth.principalKey);
    const { verifier, challenge } = await generatePKCE();
    const redirectUri = `${getBase(req)}/auth/salesforce/callback`;

    await env.KV.put(
      `oauth_pkce_${state}`,
      JSON.stringify({ verifier, redirectUri, principalKey: auth.principalKey }),
      { expirationTtl: 600 },
    );

    res.redirect(302, buildOAuthUrl(env, redirectUri, state, challenge));
  } catch (err) {
    log('error', 'auth/salesforce/start failed', String(err));
    res.status(500).type('text').send(String(err));
  }
});

app.get('/auth/salesforce/callback', async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    res.status(400).type('text').send(`Salesforce OAuth error: ${error} - ${error_description ?? ''}`);
    return;
  }
  if (!code || !state) {
    res.status(400).type('text').send('Missing code or state parameter.');
    return;
  }

  const pendingAuth = getPendingAuth(state);
  if (!pendingAuth) {
    res.status(400).type('text').send('Invalid or expired state. Please restart Salesforce sign-in from Microsoft 365 Copilot.');
    return;
  }

  const pkceStored = await env.KV.get(`oauth_pkce_${state}`);
  if (!pkceStored) {
    res.status(400).type('text').send('Missing PKCE session. Please restart Salesforce sign-in.');
    return;
  }

  await env.KV.delete(`oauth_pkce_${state}`);
  deletePendingAuth(state);

  let codeVerifier: string;
  let redirectUri: string;
  let principalKey: string;
  try {
    ({ verifier: codeVerifier, redirectUri, principalKey } = JSON.parse(pkceStored) as {
      verifier: string;
      redirectUri: string;
      principalKey: string;
    });
  } catch {
    res.status(400).type('text').send('Corrupted OAuth state. Please restart Salesforce sign-in.');
    return;
  }

  if (principalKey !== pendingAuth.principalKey) {
    res.status(400).type('text').send('Principal mismatch detected. Please restart Salesforce sign-in.');
    return;
  }

  try {
    const tempKV = new InMemoryKV();
    const tempEnv: Env = { ...env, KV: tempKV };
    const sfToken = await exchangeCodeForTokens(tempEnv, code, redirectUri, codeVerifier);

    createOrUpdateSession(principalKey, {
      sfAccessToken: sfToken.access_token,
      sfRefreshToken: sfToken.refresh_token,
      sfInstanceUrl: sfToken.instance_url,
    });

    res.type('html').send(
      '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
      '<title>Salesforce Connected</title>' +
      '<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:80px auto;padding:0 20px;line-height:1.5}' +
      '.badge{display:inline-block;background:#2563eb;color:#fff;border-radius:6px;padding:4px 12px;font-weight:600}' +
      'code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:.9em}</style></head><body>' +
      '<p><span class="badge">Connected</span></p>' +
      '<h2>Salesforce is now connected for your Microsoft 365 session</h2>' +
      `<p>Instance: <code>${sfToken.instance_url}</code></p>` +
      '<p>You can close this tab and return to Microsoft 365 Copilot or Teams.</p>' +
      `<hr><p style="color:#64748b;font-size:.85em">MCP endpoint: <code>${getBase(req)}/mcp</code></p>` +
      '</body></html>',
    );
  } catch (err) {
    log('error', 'Salesforce callback failed', String(err));
    res.status(500).type('text').send(`Authentication failed: ${String(err)}`);
  }
});

app.get('/auth/salesforce/disconnect', (req: Request, res: Response) => {
  const auth = requirePrincipal(req, res);
  if (!auth) return;

  deleteSession(auth.principalKey);
  res.type('html').send(
    '<html><body><h2>Disconnected</h2><p>Salesforce has been disconnected for this Microsoft 365 user.</p></body></html>',
  );
});

app.use((req: Request, res: Response, next) => {
  if (req.path !== '/mcp' && req.path !== '/sse' && req.path !== '/message') {
    return next();
  }

  const auth = requirePrincipal(req, res);
  if (!auth) return;

  // /sse is the discovery endpoint — only Microsoft identity is required here.
  // Salesforce session is validated on the actual MCP paths.
  if (req.path === '/sse') {
    const authedReq = req as AuthedRequest;
    authedReq.principal = auth.principal;
    authedReq.principalKey = auth.principalKey;
    return next();
  }

  const sfTokens = getSession(auth.principalKey);
  if (!sfTokens) {
    res.status(401).json({
      error: 'salesforce_not_connected',
      error_description: 'This Microsoft 365 user has not connected Salesforce yet.',
      authorization_url: `${getBase(req)}/auth/salesforce/start`,
    });
    return;
  }

  const userKV = new SessionBackedKV(auth.principalKey, env.KV, sfTokens);
  const authedReq = req as AuthedRequest;
  authedReq.principal = auth.principal;
  authedReq.principalKey = auth.principalKey;
  authedReq.userEnv = { ...env, KV: userKV };
  next();
});

app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const result = await processMcpRequest(req.body, (req as AuthedRequest).userEnv);
    if (result === null) {
      res.status(202).end();
      return;
    }
    res.json(result);
  } catch (err) {
    log('error', 'MCP request failed', String(err));
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: String(err) },
      id: null,
    });
  }
});

app.get('/sse', (req: Request, res: Response) => {
  const base = getBase(req);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: endpoint\ndata: ${base}/mcp\n\n`);
  setTimeout(() => res.end(), 300);
});

app.post('/message', (req: Request, res: Response) => {
  req.url = '/mcp';
  app(req, res);
});

app.use((_req, res) => res.status(404).send('Not Found'));

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`Salesforce MCP server listening on port ${PORT}`);
  console.log(`  Health:         http://localhost:${PORT}/health`);
  console.log(`  Auth status:    http://localhost:${PORT}/auth/status`);
  console.log(`  Salesforce:     http://localhost:${PORT}/auth/salesforce/start`);
  console.log(`  MCP:            http://localhost:${PORT}/mcp`);
});
