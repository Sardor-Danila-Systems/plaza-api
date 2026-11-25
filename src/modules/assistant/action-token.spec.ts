import { ACTION_TTL_MS, signAction, verifyAction } from './action-token.js';

const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';
const base = {
  kind: 'CREATE_FINANCIAL_TRANSACTION' as const,
  userId: 'user-1',
  projectId: 'project-1',
  payload: { type: 'EXPENSE', amount: '100.00' },
};

describe('assistant action token', () => {
  it('round-trips a signed action', () => {
    const { action, token } = signAction(base, SECRET, 1_000);
    expect(verifyAction(token, SECRET, 2_000)).toEqual(action);
    expect(action.expiresAt).toBe(1_000 + ACTION_TTL_MS);
  });

  it('rejects a token signed with another secret', () => {
    const { token } = signAction(base, SECRET);
    expect(verifyAction(token, `${SECRET}-other`)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const { token } = signAction(base, SECRET);
    const [, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...base,
        payload: { amount: '999999.00' },
        id: 'x',
        expiresAt: Date.now() + 1e6,
      }),
    ).toString('base64url');
    expect(verifyAction(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    const { token } = signAction(base, SECRET, 0);
    expect(verifyAction(token, SECRET, ACTION_TTL_MS + 1)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyAction('', SECRET)).toBeNull();
    expect(verifyAction('a.b.c', SECRET)).toBeNull();
    expect(verifyAction('not-a-token', SECRET)).toBeNull();
  });
});
