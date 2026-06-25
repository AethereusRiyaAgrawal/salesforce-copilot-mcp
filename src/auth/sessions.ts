import crypto from 'node:crypto';
import { InMemoryKV } from './salesforce.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;
const TOKEN_KEYS = new Set(['sf_access_token', 'sf_refresh_token', 'sf_instance_url']);

export interface SessionTokens {
  sfAccessToken: string;
  sfRefreshToken?: string;
  sfInstanceUrl: string;
}

interface SessionEntry {
  tokens: SessionTokens;
  expiresAt: number;
}

interface PendingAuthEntry {
  principalKey: string;
  expiresAt: number;
}

function makeTtlStore<T extends { expiresAt: number }>() {
  const store = new Map<string, T>();
  return {
    set(key: string, value: T) {
      store.set(key, value);
    },
    get(key: string): T | undefined {
      const value = store.get(key);
      if (!value) return undefined;
      if (Date.now() > value.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return value;
    },
    del(key: string) {
      store.delete(key);
    },
  };
}

const sessionMap = makeTtlStore<SessionEntry>();
const pendingAuthMap = makeTtlStore<PendingAuthEntry>();

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function createOrUpdateSession(principalKey: string, tokens: SessionTokens): void {
  sessionMap.set(principalKey, {
    tokens,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
}

export function getSession(principalKey: string): SessionTokens | undefined {
  return sessionMap.get(principalKey)?.tokens;
}

export function updateSessionTokens(principalKey: string, patch: Partial<SessionTokens>): void {
  const entry = sessionMap.get(principalKey);
  if (!entry) return;

  sessionMap.set(principalKey, {
    expiresAt: Date.now() + SESSION_TTL_MS,
    tokens: { ...entry.tokens, ...patch },
  });
}

export function deleteSession(principalKey: string): void {
  sessionMap.del(principalKey);
}

export function createPendingAuth(principalKey: string): string {
  const state = generateToken();
  pendingAuthMap.set(state, {
    principalKey,
    expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
  });
  return state;
}

export function getPendingAuth(state: string): PendingAuthEntry | undefined {
  return pendingAuthMap.get(state);
}

export function deletePendingAuth(state: string): void {
  pendingAuthMap.del(state);
}

export class SessionBackedKV extends InMemoryKV {
  constructor(
    private readonly principalKey: string,
    private readonly backingKv: InMemoryKV,
    tokens: SessionTokens,
  ) {
    super();

    const cached = {
      access_token: tokens.sfAccessToken,
      instance_url: tokens.sfInstanceUrl,
      token_type: 'Bearer',
    };

    void super.put('sf_access_token', JSON.stringify(cached), { expirationTtl: 55 * 60 });
    void super.put('sf_instance_url', tokens.sfInstanceUrl);
    if (tokens.sfRefreshToken) {
      void super.put('sf_refresh_token', tokens.sfRefreshToken);
    }
  }

  private scopedKey(key: string): string {
    return `principal:${this.principalKey}:${key}`;
  }

  override async get(key: string): Promise<string | null>;
  override async get(key: string, type: 'json'): Promise<unknown>;
  override async get(key: string, type?: 'json'): Promise<unknown> {
    if (TOKEN_KEYS.has(key)) {
      return super.get(key, type as 'json');
    }
    return this.backingKv.get(this.scopedKey(key), type as 'json');
  }

  override async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    if (TOKEN_KEYS.has(key)) {
      await super.put(key, value, opts);
      if (key === 'sf_access_token') {
        try {
          const parsed = JSON.parse(value) as { access_token: string; instance_url: string };
          updateSessionTokens(this.principalKey, {
            sfAccessToken: parsed.access_token,
            sfInstanceUrl: parsed.instance_url,
          });
        } catch {
          // Ignore malformed token payloads.
        }
      }
      if (key === 'sf_refresh_token') {
        updateSessionTokens(this.principalKey, { sfRefreshToken: value });
      }
      if (key === 'sf_instance_url') {
        updateSessionTokens(this.principalKey, { sfInstanceUrl: value });
      }
      return;
    }

    await this.backingKv.put(this.scopedKey(key), value, opts);
  }

  override async delete(key: string): Promise<void> {
    if (TOKEN_KEYS.has(key)) {
      await super.delete(key);
      return;
    }
    await this.backingKv.delete(this.scopedKey(key));
  }
}
