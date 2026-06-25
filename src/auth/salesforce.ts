// Salesforce OAuth helpers and user-scoped token cache.
export interface SalesforceToken {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  token_type: string;
  issued_at?: string;
  id?: string;
}

export interface KVEntry {
  value: string;
  expiresAt?: number;
}

export class InMemoryKV {
  private store = new Map<string, KVEntry>();

  async get(key: string): Promise<string | null>;
  async get(key: string, type: 'json'): Promise<unknown>;
  async get(key: string, type?: 'json'): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = opts?.expirationTtl
      ? Date.now() + opts.expirationTtl * 1000
      : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export const kv = new InMemoryKV();

export interface Env {
  SF_LOGIN_URL: string;
  SF_API_VERSION: string;
  SF_CLIENT_ID: string;
  SF_CLIENT_SECRET?: string;
  EXTERNAL_BASE_URL?: string;
  DEV_BYPASS_USER_ID?: string;
  DEV_BYPASS_USER_NAME?: string;
  DEV_BYPASS_TENANT_ID?: string;
  KV: InMemoryKV;
}

function base64urlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  const challenge = base64urlEncode(new Uint8Array(digest));

  return { verifier, challenge };
}

const ACCESS_TOKEN_KEY = 'sf_access_token';
const REFRESH_TOKEN_KEY = 'sf_refresh_token';
const INSTANCE_URL_KEY = 'sf_instance_url';
const ACCESS_TOKEN_TTL = 55 * 60;

export async function getSalesforceToken(env: Env): Promise<SalesforceToken> {
  const cached = await env.KV.get(ACCESS_TOKEN_KEY, 'json') as SalesforceToken | null;
  if (cached) return cached;

  const [refreshToken, instanceUrl] = await Promise.all([
    env.KV.get(REFRESH_TOKEN_KEY),
    env.KV.get(INSTANCE_URL_KEY),
  ]);

  if (!refreshToken || !instanceUrl) {
    throw new Error(
      'Salesforce is not connected for this Microsoft 365 user. Visit /auth/salesforce/start to authenticate.',
    );
  }

  return refreshAccessToken(env, refreshToken, instanceUrl);
}

async function refreshAccessToken(
  env: Env,
  refreshToken: string,
  instanceUrl: string,
): Promise<SalesforceToken> {
  const bodyParams: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: env.SF_CLIENT_ID,
    refresh_token: refreshToken,
  };

  if (env.SF_CLIENT_SECRET) {
    bodyParams.client_secret = env.SF_CLIENT_SECRET;
  }

  const body = new URLSearchParams(bodyParams);

  const res = await fetch(`${env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    await Promise.all([
      env.KV.delete(ACCESS_TOKEN_KEY),
      env.KV.delete(REFRESH_TOKEN_KEY),
    ]);
    throw new Error(
      `Salesforce token refresh failed: ${err}. Visit /auth/salesforce/start to re-authenticate.`,
    );
  }

  const token = await res.json() as SalesforceToken;
  const resolvedInstanceUrl = token.instance_url || instanceUrl;

  const toCache: SalesforceToken = {
    access_token: token.access_token,
    instance_url: resolvedInstanceUrl,
    token_type: 'Bearer',
  };

  await Promise.all([
    env.KV.put(ACCESS_TOKEN_KEY, JSON.stringify(toCache), {
      expirationTtl: ACCESS_TOKEN_TTL,
    }),
    env.KV.put(INSTANCE_URL_KEY, resolvedInstanceUrl),
  ]);

  return toCache;
}

export function buildOAuthUrl(
  env: Env,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.SF_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'api refresh_token offline_access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login consent',
  });
  return `${env.SF_LOGIN_URL}/services/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  env: Env,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<SalesforceToken> {
  const bodyParams: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: env.SF_CLIENT_ID,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };

  if (env.SF_CLIENT_SECRET) {
    bodyParams.client_secret = env.SF_CLIENT_SECRET;
  }

  const body = new URLSearchParams(bodyParams);

  const res = await fetch(`${env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OAuth code exchange failed: ${err}`);
  }

  const token = await res.json() as SalesforceToken;

  const toCache: SalesforceToken = {
    access_token: token.access_token,
    instance_url: token.instance_url,
    token_type: 'Bearer',
  };

  await Promise.all([
    env.KV.put(ACCESS_TOKEN_KEY, JSON.stringify(toCache), {
      expirationTtl: ACCESS_TOKEN_TTL,
    }),
    token.refresh_token
      ? env.KV.put(REFRESH_TOKEN_KEY, token.refresh_token)
      : Promise.resolve(),
    env.KV.put(INSTANCE_URL_KEY, token.instance_url),
  ]);

  return token;
}

export async function sfFetch(
  env: Env,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await getSalesforceToken(env);
  const url = path.startsWith('http') ? path : `${token.instance_url}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  const makeRequest = (accessToken: string, targetUrl: string) =>
    fetch(targetUrl, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });

  try {
    const res = await makeRequest(token.access_token, url);

    if (res.status === 401) {
      await env.KV.delete(ACCESS_TOKEN_KEY);
      const fresh = await getSalesforceToken(env);
      const retryUrl = path.startsWith('http') ? path : `${fresh.instance_url}${path}`;
      return makeRequest(fresh.access_token, retryUrl);
    }

    return res;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Salesforce API request timed out after 30 seconds. Try a more specific query with a smaller LIMIT.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
