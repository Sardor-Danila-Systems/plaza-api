import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

/**
 * A write the assistant proposed and the owner has not yet confirmed.
 * The assistant never writes on its own: it returns one of these, signed,
 * and only `POST /assistant/actions/confirm` executes it — through the same
 * service, permission check and idempotency key as a hand-made request.
 */
export interface PendingAction {
  /** Doubles as the Idempotency-Key, so a repeated confirm is a replay. */
  id: string;
  kind: 'CREATE_FINANCIAL_TRANSACTION';
  userId: string;
  projectId: string;
  payload: Record<string, unknown>;
  /** Unix milliseconds. */
  expiresAt: number;
}

export const ACTION_TTL_MS = 15 * 60 * 1000;

function key(secret: string): Buffer {
  // A key of its own, so an action token can never pass as an access token.
  return createHash('sha256')
    .update(`plaza-assistant-action:${secret}`)
    .digest();
}

export function signAction(
  action: Omit<PendingAction, 'id' | 'expiresAt'>,
  secret: string,
  now = Date.now(),
): { action: PendingAction; token: string } {
  const full: PendingAction = {
    ...action,
    id: randomUUID(),
    expiresAt: now + ACTION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = createHmac('sha256', key(secret))
    .update(body)
    .digest('base64url');
  return { action: full, token: `${body}.${sig}` };
}

/** Returns the action, or null when the token is forged, malformed or expired. */
export function verifyAction(
  token: string,
  secret: string,
  now = Date.now(),
): PendingAction | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', key(secret)).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  try {
    const action = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as PendingAction;
    if (typeof action.expiresAt !== 'number' || action.expiresAt < now)
      return null;
    return action;
  } catch {
    return null;
  }
}
