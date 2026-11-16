import { randomUUID } from 'node:crypto';
import { repoSlug, silentLogger, type GitHubApi, type Logger, type NormalizedEvent, type RepoRef } from './types.js';

export const REPO_CHECK_CONCURRENCY = 8;
export const REPO_RECHECK_MS = 60 * 60 * 1000;
export const REPO_RETRY_MS = 5_000;
export const REPO_MAX_RETRY_MS = 60_000;

/** Sanitized evidence from each configured entry in a failed discovery sweep. */
export interface InstallationDiscoveryOutcome {
  repo: RepoRef;
  status: number;
  rateLimited: boolean;
}

export function isInstallationDenial(outcome: { status?: number; rateLimited?: boolean }): boolean {
  return !outcome.rateLimited && [401, 403, 404, 410].includes(outcome.status ?? 0);
}

/** A data response, not a separate metadata snapshot, identifies another repo. */
export class RepoScopeError extends Error {
  constructor(readonly canonicalName: string) {
    super("repository identity in GitHub response does not match the configured entry's current target");
    this.name = 'RepoScopeError';
  }
}

/** Missing identity is also refused, but is not evidence of a rename. */
export function assertRepositoryIdentity(repo: RepoRef, canonicalName?: string): void {
  if (!canonicalName) throw new Error('GitHub response omitted repository identity; refusing unverified data');
  if (canonicalName.toLowerCase() !== repoSlug(repo).toLowerCase()) throw new RepoScopeError(canonicalName);
}

export interface RepoProblem {
  reason: string;
  canonicalName?: string;
}

export class RepoUnavailableError extends Error {
  constructor(repo: RepoRef, problem: RepoProblem) {
    super(`repository ${repoSlug(repo)} unavailable: ${problem.reason}`);
    this.name = 'RepoUnavailableError';
  }
}

/** Configured names stay stable; GitHub may resolve them to renamed/transferred targets. */
export class RepoAvailability {
  private readonly canonicalNames = new Map<string, string>();
  private readonly problems = new Map<string, RepoProblem | null>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly nextCheck = new Map<string, number>();
  private readonly retries = new Map<string, number>();
  private installationProblem?: { status: number; operation: string };
  private timer?: NodeJS.Timeout;
  private pass: Promise<void> = Promise.resolve();

  constructor(
    private readonly repos: readonly RepoRef[],
    private readonly probe: (repo: RepoRef) => Promise<string>,
    private readonly onEvent: (event: NormalizedEvent) => Promise<unknown>,
    private readonly logger: Logger = silentLogger(),
  ) {}

  available(repo: RepoRef): boolean {
    return this.problems.get(repoSlug(repo).toLowerCase()) === null;
  }

  assertAvailable(repo: RepoRef): void {
    const problem = this.problems.get(repoSlug(repo).toLowerCase());
    if (problem !== null) throw new RepoUnavailableError(repo, problem ?? { reason: 'not validated in GITHUB_REPOS' });
  }

  async initialize(): Promise<void> {
    await this.recheck();
  }

  /** Explicit full sweep (also used at startup); bypass any transient backoff. */
  async recheck(): Promise<void> {
    await this.checkMany(this.repos, true);
  }

  private async checkMany(repos: readonly RepoRef[], force = false): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < repos.length) await this.backgroundCheck(repos[next++], force);
    };
    await Promise.all(Array.from({ length: Math.min(REPO_CHECK_CONCURRENCY, repos.length) }, worker));
  }

  check(repo: RepoRef, force = false): Promise<void> {
    const slug = repoSlug(repo).toLowerCase();
    const existing = this.inFlight.get(slug);
    if (existing) return existing;
    if (!force && this.retries.has(slug) && (this.nextCheck.get(slug) ?? 0) > Date.now()) {
      return Promise.reject(new Error(`repository ${repoSlug(repo)} validation temporarily failed; retry scheduled`));
    }
    const pass = this.inspect(repo).finally(() => this.inFlight.delete(slug));
    this.inFlight.set(slug, pass);
    return pass;
  }

  private async inspect(repo: RepoRef): Promise<void> {
    const slug = repoSlug(repo).toLowerCase();
    let problem: RepoProblem | null;
    try {
      const canonicalName = await this.probe(repo);
      await this.confirm(repo, canonicalName);
      return;
    } catch (err) {
      // Fixed reasons are stable across polls and cannot leak credentials or response bodies.
      const { status, rateLimited, operation, installationDiscovery } = (err ?? {}) as {
        status?: number; rateLimited?: boolean; operation?: string;
        installationDiscovery?: readonly InstallationDiscoveryOutcome[];
      };
      // Shared auth/discovery failures precede this repo's metadata request:
      // even a sibling's 404 is not definitive evidence about this repository.
      const sharedAuthFailure = operation === 'resolveInstallationId' || operation === 'mintInstallationToken';
      const installationDenied = operation === 'resolveInstallationId' && installationDiscovery
        ? installationDiscovery.length > 0 && installationDiscovery.every(isInstallationDenial)
        : isInstallationDenial({ status, rateLimited });
      if (sharedAuthFailure && installationDenied) await this.setInstallationProblem({
        status: typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0,
        operation,
      });
      else if (!sharedAuthFailure && status && status >= 400 && status < 500) await this.setInstallationProblem(undefined);
      if (sharedAuthFailure || rateLimited || !status || ![403, 404, 410].includes(status)) {
        const attempts = (this.retries.get(slug) ?? 0) + 1;
        this.retries.set(slug, attempts);
        this.nextCheck.set(slug, Date.now() + Math.min(REPO_RETRY_MS * 2 ** Math.min(attempts - 1, 10), REPO_MAX_RETRY_MS));
        // Keep the last confirmed repository state, including unknown at startup.
        throw new Error(`repository ${repoSlug(repo)} validation temporarily failed; retry scheduled`);
      }
      const reason = status === 404 ? 'not found or inaccessible to the token (HTTP 404)'
        : status === 403 ? 'inaccessible to the token (HTTP 403)'
        : 'repository gone (HTTP 410)';
      problem = { reason };
    }
    this.retries.delete(slug);
    this.nextCheck.set(slug, Date.now() + REPO_RECHECK_MS);
    await this.setProblem(repo, problem);
  }

  /** A successful configured-entry lookup, including redirects, is authoritative. */
  async confirm(repo: RepoRef, canonicalName: string): Promise<void> {
    const slug = repoSlug(repo).toLowerCase();
    await this.setInstallationProblem(undefined);
    const previous = this.canonicalNames.get(slug);
    this.canonicalNames.set(slug, canonicalName);
    this.retries.delete(slug);
    this.nextCheck.set(slug, Date.now() + REPO_RECHECK_MS);
    await this.setProblem(repo, null);
    if ((previous ?? slug).toLowerCase() === canonicalName.toLowerCase()) return;
    const reason = canonicalName.toLowerCase() === slug
      ? `${repoSlug(repo)} resolves to its configured name again: ${canonicalName}`
      : `${repoSlug(repo)} resolves to ${canonicalName}; update GITHUB_REPOS to the current name (redirect compatibility retained)`;
    this.logger.warn('repository renamed or transferred', { repo: repoSlug(repo), canonicalName });
    await this.onEvent({
      id: `repo:${randomUUID()}`,
      kind: 'repo.renamed',
      repo,
      receivedAt: new Date().toISOString(),
      actor: { login: 'github-mcpl', isBot: true },
      html_url: `https://github.com/${canonicalName}`,
      body: reason,
      availability: { reason, canonicalName },
    });
  }

  /** One shared diagnostic, never a verdict about any configured repository. */
  private async setInstallationProblem(problem: { status: number; operation: string } | undefined): Promise<void> {
    if (JSON.stringify(this.installationProblem) === JSON.stringify(problem)) return;
    this.installationProblem = problem;
    const reason = problem
      ? `GitHub installation authentication unavailable (HTTP ${problem.status}; ${problem.operation}); retry scheduled. Check the App installation, GITHUB_APP_INSTALLATION_ID, App credentials and GITHUB_REPOS access.`
      : 'GitHub installation authentication available again';
    this.logger[problem ? 'warn' : 'info'](reason, problem ? { ...problem } : {});
    await this.onEvent({
      id: `installation:${randomUUID()}`,
      kind: problem ? 'installation.unavailable' : 'installation.available',
      // Routing anchor only; content and metadata identify connector-wide scope.
      repo: this.repos[0],
      receivedAt: new Date().toISOString(),
      actor: { login: 'github-mcpl', isBot: true },
      html_url: 'https://github.com/settings/installations',
      body: reason,
      installation: { reason, ...problem },
    });
  }

  private async setProblem(repo: RepoRef, problem: RepoProblem | null): Promise<void> {
    const slug = repoSlug(repo).toLowerCase();
    const previous = this.problems.get(slug);
    this.problems.set(slug, problem);
    if (JSON.stringify(previous) === JSON.stringify(problem) || (previous === undefined && problem === null)) return;
    const kind = problem ? 'repo.unavailable' : 'repo.available';
    const reason = problem?.reason ?? 'available again through the configured entry';
    this.logger[problem ? 'warn' : 'info'](`repository ${problem ? 'set aside' : 'recovered'}`, { repo: slug, reason });
    await this.onEvent({
      id: `repo:${randomUUID()}`,
      kind,
      repo,
      receivedAt: new Date().toISOString(),
      actor: { login: 'github-mcpl', isBot: true },
      html_url: `https://github.com/${slug}`,
      body: reason,
      availability: { reason, ...(problem?.canonicalName ? { canonicalName: problem.canonicalName } : {}) },
    });
  }

  private async backgroundCheck(repo: RepoRef, force = false): Promise<void> {
    try { await this.check(repo, force); }
    catch { if (!this.installationProblem) this.logger.warn('repository validation temporarily failed; retry scheduled', { repo: repoSlug(repo) }); }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pass = this.pass.then(async () => {
        await this.checkMany(this.repos.filter((repo) =>
          (this.nextCheck.get(repoSlug(repo).toLowerCase()) ?? 0) <= Date.now()));
      });
    }, REPO_RETRY_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pass;
  }

  /** Guard reads, writes, channel history and rollback at the shared API seam. */
  guard<T extends GitHubApi>(api: T): T {
    return new Proxy(api, {
      get: (target, property) => {
        const value = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const first = args[0] as RepoRef | { repo: RepoRef } | undefined;
          const repo = first && typeof first === 'object' ? ('repo' in first ? first.repo : first) : undefined;
          const scoped = repo && typeof repo.owner === 'string' && typeof repo.name === 'string' ? repo : undefined;
          if (scoped) {
            this.assertAvailable(scoped);
            // Search and GraphQL can resolve old names without an HTTP redirect.
            // Preflight is useful even for empty results. The adapter ALSO binds
            // data to the current canonical target, not to this earlier snapshot.
            if (property === 'searchIssues' || property === 'listReviewThreads') {
              await this.check(scoped);
              this.assertAvailable(scoped);
            }
          }
          try {
            return await value.apply(target, args);
          } catch (err) {
            const status = (err as { status?: number })?.status;
            // A missing issue or denied write is not proof the repo is gone: probe it.
            if (scoped && status && [301, 302, 307, 308, 401, 403, 404, 410].includes(status)) {
              await this.check(scoped);
              this.assertAvailable(scoped);
            }
            throw err;
          }
        };
      },
    });
  }
}
