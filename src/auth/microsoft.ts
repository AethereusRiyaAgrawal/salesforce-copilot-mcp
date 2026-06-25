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

// Decodes an Azure AD JWT from the Authorization header without verifying the
// signature. This allows non-Azure hosts (e.g. Render) to extract user identity
// from Copilot-supplied tokens instead of relying on App Service header injection.
function tryParseAzureAdJwt(token: string): ClientPrincipalPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json) as Record<string, unknown>;
    // Must be an Azure AD token — requires both oid and tid claims.
    if (typeof payload.oid !== 'string' || typeof payload.tid !== 'string') return null;
    const claims: ClientPrincipalClaim[] = Object.entries(payload)
      .filter(([, v]) => typeof v === 'string')
      .map(([typ, val]) => ({ typ, val: val as string }));
    return {
      userId: payload.oid,
      userDetails: (payload.preferred_username ?? payload.upn ?? payload.email) as string | undefined,
      claims,
    };
  } catch {
    return null;
  }
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

  // Azure App Service Auth injects x-ms-client-principal. On other hosts
  // (e.g. Render), fall back to decoding the Azure AD JWT from the
  // Authorization header directly if no App Service headers are present.
  const authHeader = req.header('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const jwtDecoded = (!clientPrincipalHeader && !directUserId && bearerToken)
    ? tryParseAzureAdJwt(bearerToken)
    : null;

  const decoded = clientPrincipalHeader
    ? decodeClientPrincipal(clientPrincipalHeader)
    : jwtDecoded;

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
