import type { Response } from 'supertest';

/**
 * supertest has no automatic cookie jar (unlike a real browser) — tests that
 * exercise the cookie-based refresh/CSRF flow (docs/backend-architecture.md
 * §9) need to manually carry `Set-Cookie` values from one request into the
 * next request's `Cookie` header. This is that plumbing, kept in one place
 * so each e2e test doesn't hand-roll its own cookie-string parsing.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): this {
    const header: unknown = response.headers['set-cookie'];
    const rawCookies = Array.isArray(header)
      ? header
      : typeof header === 'string'
        ? [header]
        : [];
    for (const raw of rawCookies) {
      const [pair] = raw.split(';');
      const [name, value] = pair.split('=');
      this.cookies.set(name, value ?? '');
    }
    return this;
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}
