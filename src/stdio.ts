/**
 * Stdio entry point for Claude Desktop (and other local MCP clients).
 *
 * - Uses StdioServerTransport instead of HTTP.
 * - Identity comes from DEV_BYPASS_* env vars (no Azure header injection needed).
 * - Salesforce tokens persisted in .sf-tokens.json so re-auth is not needed on restart.
 * - OAuth callback server always uses OAUTH_CALLBACK_PORT (default 3001) so the
 *   redirect URI stays stable and matches the Salesforce Connected App exactly.
 *   If something is already on that port (zombie from a previous run), it is
 *   killed automatically before binding.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec, execSync } from 'node:child_process';
import { registerAllTools } from './tools/index.js';
import {
  InMemoryKV,
  buildOAuthUrl,
  exchangeCodeForTokens,
  generatePKCE,
} from './auth/salesforce.js';
import type { Env } from './auth/salesforce.js';
import { createOrUpdateSession, SessionBackedKV } from './auth/sessions.js';

const OAUTH_PORT = parseInt(process.env.OAUTH_CALLBACK_PORT ?? '3001', 10);
const TOKENS_FILE = path.join(process.cwd(), '.sf-tokens.json');

interface PersistedTokens {
  sfAccessToken: string;
  sfRefreshToken?: string;
  sfInstanceUrl: string;
}

function loadTokens(): PersistedTokens | null {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) as PersistedTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: PersistedTokens): void {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function deleteTokens(): void {
  try { fs.unlinkSync(TOKENS_FILE); } catch { /* already gone */ }
}

// Kill whatever process is holding a given port on Windows.
function freePort(port: number): void {
  try {
    const out = execSync(
      `netstat -aon | findstr :${port} | findstr LISTENING`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const pid = out.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid)) {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      process.stderr.write(`[salesforce-mcp] Freed port ${port} (killed PID ${pid}).\n`);
    }
  } catch {
    // No process found on that port — nothing to do.
  }
}

async function runOAuthFlow(env: Env): Promise<PersistedTokens> {
  return new Promise((resolve, reject) => {
    const redirectUri = `http://localhost:${OAUTH_PORT}/auth/salesforce/callback`;
    let pkce: { verifier: string; challenge: string };
    let oauthState: string;

    const server = http.createServer(async (req, res) => {
      if (!req.url) { res.writeHead(400).end(); return; }
      const url = new URL(req.url, `http://localhost:${OAUTH_PORT}`);

      if (url.pathname !== '/auth/salesforce/callback') {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400).end(`Salesforce OAuth error: ${error}`);
        server.close();
        reject(new Error(`Salesforce OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== oauthState) {
        res.writeHead(400).end('State mismatch — please restart Claude Desktop and try again.');
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }

      try {
        const tempKV = new InMemoryKV();
        const token = await exchangeCodeForTokens(
          { ...env, KV: tempKV },
          code,
          redirectUri,
          pkce.verifier,
        );

        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end(
            '<html><body style="font-family:system-ui;max-width:480px;margin:80px auto">' +
            '<h2>Salesforce connected!</h2>' +
            '<p>You can close this tab and return to Claude.</p>' +
            '</body></html>',
          );
        server.close();

        resolve({
          sfAccessToken: token.access_token,
          sfRefreshToken: token.refresh_token,
          sfInstanceUrl: token.instance_url,
        });
      } catch (err) {
        res.writeHead(500).end(`Token exchange failed: ${err}`);
        server.close();
        reject(err);
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`[salesforce-mcp] Port ${OAUTH_PORT} busy — killing zombie process...\n`);
        freePort(OAUTH_PORT);
        // Wait briefly for the OS to release the port, then retry.
        setTimeout(() => server.listen(OAUTH_PORT), 800);
      } else {
        reject(err);
      }
    });

    server.listen(OAUTH_PORT, async () => {
      pkce = await generatePKCE();
      oauthState = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

      process.stderr.write(
        `\n[salesforce-mcp] Starting Salesforce sign-in (callback on port ${OAUTH_PORT})...\n` +
        `[salesforce-mcp] If browser does not open, visit:\n${buildOAuthUrl(env, redirectUri, oauthState, pkce.challenge)}\n\n`,
      );

      exec(
        `start "" "${buildOAuthUrl(env, redirectUri, oauthState, pkce.challenge)}"`,
        err => { if (err) process.stderr.write('[salesforce-mcp] Could not open browser automatically.\n'); },
      );
    });
  });
}

async function main(): Promise<void> {
  const required = ['SF_LOGIN_URL', 'SF_API_VERSION', 'SF_CLIENT_ID'];
  for (const name of required) {
    if (!process.env[name]) {
      process.stderr.write(`[salesforce-mcp] Missing required env var: ${name}\n`);
      process.exit(1);
    }
  }

  const kv = new InMemoryKV();
  const env: Env = {
    SF_LOGIN_URL: process.env.SF_LOGIN_URL!,
    SF_API_VERSION: process.env.SF_API_VERSION!,
    SF_CLIENT_ID: process.env.SF_CLIENT_ID!,
    SF_CLIENT_SECRET: process.env.SF_CLIENT_SECRET,
    EXTERNAL_BASE_URL: `http://localhost:${OAUTH_PORT}`,
    MCP_API_KEY: process.env.MCP_API_KEY,
    DEV_BYPASS_USER_ID: process.env.DEV_BYPASS_USER_ID || 'local-user',
    DEV_BYPASS_USER_NAME: process.env.DEV_BYPASS_USER_NAME || 'Local User',
    DEV_BYPASS_TENANT_ID: process.env.DEV_BYPASS_TENANT_ID || 'local',
    KV: kv,
  };

  const principalKey = `${env.DEV_BYPASS_TENANT_ID}:${env.DEV_BYPASS_USER_ID}`;

  let tokens = loadTokens();

  if (!tokens) {
    process.stderr.write('[salesforce-mcp] No stored session. Starting Salesforce OAuth...\n');
    try {
      tokens = await runOAuthFlow(env);
      saveTokens(tokens);
      process.stderr.write('[salesforce-mcp] Salesforce connected and tokens saved.\n');
    } catch (err) {
      process.stderr.write(`[salesforce-mcp] OAuth failed: ${err}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write(`[salesforce-mcp] Loaded stored session (${tokens.sfInstanceUrl}).\n`);
  }

  createOrUpdateSession(principalKey, tokens);
  const userKV = new SessionBackedKV(principalKey, kv, tokens);
  const userEnv: Env = { ...env, KV: userKV };

  const server = new McpServer({ name: 'salesforce-mcp', version: '1.0.0' });
  registerAllTools(server, userEnv);

  const transport = new StdioServerTransport();

  transport.onerror = (err: Error) => {
    if (err.message.includes('token refresh failed') || err.message.includes('not connected')) {
      process.stderr.write('[salesforce-mcp] Session expired — deleting stored tokens.\n');
      deleteTokens();
    }
  };

  await server.connect(transport);
  process.stderr.write('[salesforce-mcp] Ready.\n');
}

main().catch(err => {
  process.stderr.write(`[salesforce-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
