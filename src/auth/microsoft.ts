import type { Request } from 'express';
import type { Env } from './salesforce.js';

export interface MicrosoftPrincipal {
  provider: 'microsoft';
  tenantId: string;
  userId: string;
  username?: string;
  displayName?: string;
}

interface ClientPrincipalClaim {
  typ?: string;
  val?: string;
}

interface ClientPrincipalPayload {
  userId?: string;
  userDetails?: string;
  userRoles?: string[];
  claims?: ClientPrincipalClaim[];
}

function decodeClientPrincipal(headerValue: string): ClientPrincipalPayload | null {
  try {
    const json = Buffer.from(headerValue, 'base64').toString('utf8');
    return JSON.parse(json) as ClientPrincipalPayload;
  } catch {
    return null;
  }
}

function getClaimValue(
  claims: ClientPrincipalClaim[] | undefined,
  types: string[],
): string | undefined {
  if (!claims) return undefined;
  const lowered = new Set(types.map(type => type.toLowerCase()));

  for (const claim of claims) {
    const type = claim.typ?.toLowerCase();
    if (type && lowered.has(type) && claim.val) {
      return claim.val;
    }
  }

  return undefined;
}

export function toPrincipalKey(principal: MicrosoftPrincipal): string {
  return `${principal.tenantId}:${principal.userId}`;
}

export function getMicrosoftPrincipal(req: Request, env: Env): MicrosoftPrincipal | null {
  const devBypassUserId = env.DEV_BYPASS_USER_ID?.trim();
  if (devBypassUserId) {
    return {
      provider: 'microsoft',
      tenantId: env.DEV_BYPASS_TENANT_ID?.trim() || 'local-tenant',
      userId: devBypassUserId,
      username: env.DEV_BYPASS_USER_NAME?.trim() || devBypassUserId,
      displayName: env.DEV_BYPASS_USER_NAME?.trim() || devBypassUserId,
    };
  }

  const clientPrincipalHeader = req.header('x-ms-client-principal');
  const directUserId = req.header('x-ms-client-principal-id');
  const directUserName = req.header('x-ms-client-principal-name');

  const decoded = clientPrincipalHeader
    ? decodeClientPrincipal(clientPrincipalHeader)
    : null;

  const userId =
    decoded?.userId ||
    directUserId ||
    getClaimValue(decoded?.claims, [
      'oid',
      'http://schemas.microsoft.com/identity/claims/objectidentifier',
      'sub',
    ]);

  const tenantId =
    getClaimValue(decoded?.claims, [
      'tid',
      'http://schemas.microsoft.com/identity/claims/tenantid',
    ]) || req.header('x-ms-tenant-id');

  if (!userId || !tenantId) {
    return null;
  }

  const username =
    decoded?.userDetails ||
    directUserName ||
    getClaimValue(decoded?.claims, [
      'preferred_username',
      'upn',
      'email',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    ]);

  const displayName = getClaimValue(decoded?.claims, [
    'name',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  ]);

  return {
    provider: 'microsoft',
    tenantId,
    userId,
    username,
    displayName,
  };
}
