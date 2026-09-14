import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes a password using argon2id', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('never returns the plain password anywhere in the hash', async () => {
    const password = 'a-very-specific-marker-password-987';
    const hash = await service.hash(password);
    expect(hash).not.toContain(password);
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('right-password');
    await expect(service.verify(hash, 'right-password')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('right-password');
    await expect(service.verify(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('produces a different hash for the same password each time (salted)', async () => {
    const [hashA, hashB] = await Promise.all([
      service.hash('same-password'),
      service.hash('same-password'),
    ]);
    expect(hashA).not.toBe(hashB);
  });

  it('verifyAgainstDummyHash always resolves false and never throws', async () => {
    await expect(service.verifyAgainstDummyHash('anything')).resolves.toBe(
      false,
    );
    await expect(service.verifyAgainstDummyHash('')).resolves.toBe(false);
  });
});
