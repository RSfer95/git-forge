// rest.ts — the REST v3 API surface: repositories, contents, git refs,
// labels, issues, pull requests, and the protocol guarantees (JSON always,
// X-GitHub-Request-Id on every reply, Link pagination).
//
// Every handler is a pure function of the shared Store; nothing here touches
// the network or the wall clock. Auth is a Bearer compare against
// MAKEFUN_SHOP_TOKEN and applies to every /api/v3 route.

import { parseCommit } from './git-objects.ts';
import {
  Store,
  StoreError,
  commentJson,
  isoFromEpoch,
  issueJson,
  pullJson,
  repoJson,
  trialIso,
  userJson,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3 (already URL-decoded, without empty parts). */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or null when there is none. */
  body: unknown;
  /** The request's Authorization header, or null. */
  authHeader: string | null;
  /** The request origin (scheme://host), for absolute Link headers. */
  baseUrl: string;
}

export interface RestResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

function ok(json: unknown, status = 200, headers?: Record<string, string>): RestResponse {
  return { status, json, headers };
}

function err(status: number, message: string, errors?: unknown): RestResponse {
  const body: Record<string, unknown> = { message };
  if (errors !== undefined) body.errors = errors;
  return { status, json: body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function requireRepo(store: Store, owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new StoreError(404, `Repository ${owner}/${name} not found`);
  return repo;
}

function parseNumber(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** `ada iversen <adaiversen@example.invalid> 1700000000 +0000` -> { name, email, date }. */
function parseIdentity(raw: string): { name: string; email: string; date: string } {
  const match = /^([^<]*?) <([^>]*)>(?: (\d+) ([+-]\d{4}))?$/.exec(raw.trim());
  if (!match) return { name: raw, email: '', date: trialIso() };
  const epoch = match[3] !== undefined ? Number.parseInt(match[3], 10) : 0;
  return { name: match[1]!.trim(), email: match[2]!, date: isoFromEpoch(epoch) };
}

/** Paginate a full list and build the Link header (absolute, same-origin). */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  path: string,
  baseUrl: string,
): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, Math.max(1, parseNumber(query.get('per_page'), 30)));
  const page = Math.max(1, parseNumber(query.get('page'), 1));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const pageUrl = (target: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `${baseUrl}${path}?${params.toString()}`;
  };
  if (start + perPage < items.length) links.push(`<${pageUrl(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${pageUrl(page - 1)}>; rel="prev"`);
  const headers: Record<string, string> = {};
  if (links.length > 0) headers.link = links.join(', ');
  return { page: slice, headers };
}

type Handler = (store: Store, req: RestRequest, params: Record<string, string>) => RestResponse;

interface Route {
  method: string;
  pattern: string[];
  handler: Handler;
}

/** Match segments against a pattern; `:name` captures one segment, `*name` captures the rest. */
function matchRoute(pattern: string[], segments: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const part = pattern[i]!;
    if (part.startsWith('*')) {
      params[part.slice(1)] = segments.slice(i).join('/');
      return params;
    }
    if (i >= segments.length) return null;
    if (part.startsWith(':')) {
      params[part.slice(1)] = segments[i]!;
    } else if (part !== segments[i]) {
      return null;
    }
  }
  return segments.length === pattern.length ? params : null;
}

const ROUTES: Route[] = [
  // API root and meta.
  {
    method: 'GET',
    pattern: [],
    handler: (_store, req) =>
      ok(
        {
          current_user_url: `${req.baseUrl}/api/v3/user`,
          repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
        },
        200,
        { 'x-oauth-scopes': 'repo' },
      ),
  },
  {
    method: 'GET',
    pattern: ['meta'],
    handler: () => ok({ installed_version: '1.0.0' }),
  },
  {
    method: 'GET',
    pattern: ['user'],
    handler: () => ok(userJson()),
  },
  // Repositories.
  {
    method: 'GET',
    pattern: ['user', 'repos'],
    handler: (store, req) => {
      const repos = store.listRepos();
      const { page, headers } = paginate(
        repos,
        req.query,
        '/api/v3/user/repos',
        req.baseUrl,
      );
      return ok(page.map((repo) => repoJson(repo)), 200, headers);
    },
  },
  {
    method: 'POST',
    pattern: ['user', 'repos'],
    handler: (store, req) => {
      const repo = store.createRepo({
        name: stringField(req.body, 'name') ?? '',
        private: isRecord(req.body) && req.body.private === true,
        description: stringField(req.body, 'description'),
      });
      return ok(repoJson(repo), 201);
    },
  },
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo'],
    handler: (store, _req, params) => ok(repoJson(requireRepo(store, params.owner!, params.repo!))),
  },
  {
    method: 'PATCH',
    pattern: ['repos', ':owner', ':repo'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      store.patchRepo(repo, { description: stringField(req.body, 'description') });
      return ok(repoJson(repo));
    },
  },
  {
    method: 'DELETE',
    pattern: ['repos', ':owner', ':repo'],
    handler: (store, _req, params) => {
      store.deleteRepo(requireRepo(store, params.owner!, params.repo!));
      return { status: 204, json: null };
    },
  },
  // Branches and commits.
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo', 'branches'],
    handler: (store, _req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      return ok(
        store.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })),
      );
    },
  },
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo', 'commits'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const commits = store.listCommits(repo, req.query.get('sha') ?? undefined);
      return ok(
        commits.map((commit) => {
          const author = parseIdentity(commit.author);
          const committer = parseIdentity(commit.committer);
          return {
            sha: commit.sha,
            commit: {
              message: commit.message,
              author: { name: author.name, email: author.email, date: author.date },
              committer: { name: committer.name, email: committer.email, date: committer.date },
            },
            author: { login: VIEWER_LOGIN },
            committer: { login: VIEWER_LOGIN },
          };
        }),
      );
    },
  },
  // Contents (paths may contain slashes).
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo', 'contents', '*path'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const read = store.readContent(repo, params.path!, req.query.get('ref') ?? undefined);
      if (read === null) throw new StoreError(404, `Path ${params.path} not found`);
      if (read.kind === 'dir') {
        return ok(
          read.entries.map((entry) => ({
            type: entry.type,
            name: entry.name,
            path: entry.path,
            sha: entry.sha,
            size: entry.size ?? 0,
          })),
        );
      }
      return ok({
        type: 'file',
        encoding: 'base64',
        size: read.data.length,
        name: read.name,
        path: read.path,
        sha: read.oid,
        content: read.data.toString('base64'),
      });
    },
  },
  {
    method: 'PUT',
    pattern: ['repos', ':owner', ':repo', 'contents', '*path'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const content = stringField(req.body, 'content');
      if (content === undefined) throw new StoreError(422, 'content is required');
      const message = stringField(req.body, 'message');
      if (message === undefined) throw new StoreError(422, 'message is required');
      const result = store.putContent(repo, {
        path: params.path!,
        content: Buffer.from(content, 'base64'),
        message,
        branch: stringField(req.body, 'branch'),
        sha: stringField(req.body, 'sha'),
      });
      return ok(
        {
          content: { name: params.path!.split('/').pop(), path: params.path, sha: result.contentSha, encoding: 'base64' },
          commit: { sha: result.commitSha, message },
        },
        result.status,
      );
    },
  },
  {
    method: 'DELETE',
    pattern: ['repos', ':owner', ':repo', 'contents', '*path'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const message = stringField(req.body, 'message');
      if (message === undefined) throw new StoreError(422, 'message is required');
      const result = store.deleteContent(repo, {
        path: params.path!,
        message,
        branch: stringField(req.body, 'branch'),
        sha: stringField(req.body, 'sha'),
      });
      return ok({ commit: { sha: result.commitSha, message } });
    },
  },
  // Git refs.
  {
    method: 'POST',
    pattern: ['repos', ':owner', ':repo', 'git', 'refs'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const ref = stringField(req.body, 'ref');
      const sha = stringField(req.body, 'sha');
      if (ref === undefined || sha === undefined) throw new StoreError(422, 'ref and sha are required');
      store.createRef(repo, ref, sha);
      const object = repo.objects.get(sha);
      return ok({ ref, object: { sha, type: object?.type ?? 'commit' } }, 201);
    },
  },
  // Labels.
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo', 'labels'],
    handler: (store, _req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    },
  },
  {
    method: 'POST',
    pattern: ['repos', ':owner', ':repo', 'labels'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const name = stringField(req.body, 'name');
      if (name === undefined || name === '') throw new StoreError(422, 'name is required');
      const label = store.createLabel(repo, { name, color: stringField(req.body, 'color') });
      return ok({ name: label.name, color: label.color }, 201);
    },
  },
  // Issues.
  {
    method: 'POST',
    pattern: ['repos', ':owner', ':repo', 'issues'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const title = stringField(req.body, 'title');
      if (title === undefined || title === '') throw new StoreError(422, 'title is required');
      const labels = isRecord(req.body) && Array.isArray(req.body.labels) ? (req.body.labels as unknown[]) : [];
      const issue = store.createIssue(repo, {
        title,
        body: stringField(req.body, 'body'),
        labels: labels.filter((label): label is string => typeof label === 'string'),
      });
      return ok(issueJson(repo, issue), 201);
    },
  },
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo', 'issues'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const issues = store.listIssues(repo, {
        state: req.query.get('state') ?? undefined,
        sort: req.query.get('sort') ?? undefined,
        direction: req.query.get('direction') ?? undefined,
        per_page: parseNumber(req.query.get('per_page'), 30),
        page: parseNumber(req.query.get('page'), 1),
      });
      return ok(issues.map((issue) => issueJson(repo, issue)));
    },
  },
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo', 'issues', ':number'],
    handler: (store, _req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const issue = store.getIssue(repo, Number.parseInt(params.number!, 10));
      if (issue === undefined) throw new StoreError(404, `Issue #${params.number} not found`);
      return ok(issueJson(repo, issue));
    },
  },
  {
    method: 'PATCH',
    pattern: ['repos', ':owner', ':repo', 'issues', ':number'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const issue = store.patchIssue(repo, Number.parseInt(params.number!, 10), {
        state: stringField(req.body, 'state'),
        title: stringField(req.body, 'title'),
        body: stringField(req.body, 'body'),
      });
      return ok(issueJson(repo, issue));
    },
  },
  {
    method: 'POST',
    pattern: ['repos', ':owner', ':repo', 'issues', ':number', 'comments'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const issue: Issue | undefined = store.getIssue(repo, Number.parseInt(params.number!, 10));
      if (issue === undefined) throw new StoreError(404, `Issue #${params.number} not found`);
      const body = stringField(req.body, 'body');
      if (body === undefined) throw new StoreError(422, 'body is required');
      const comment = store.createComment(issue, body);
      return ok(commentJson(repo, issue, comment), 201);
    },
  },
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo', 'issues', ':number', 'comments'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const issue: Issue | undefined = store.getIssue(repo, Number.parseInt(params.number!, 10));
      if (issue === undefined) throw new StoreError(404, `Issue #${params.number} not found`);
      const { page } = paginate(issue.comments, req.query, `/api/v3/repos/${params.owner}/${params.repo}/issues/${params.number}/comments`, req.baseUrl);
      return ok(page.map((comment) => commentJson(repo, issue, comment)));
    },
  },
  // Pull requests.
  {
    method: 'POST',
    pattern: ['repos', ':owner', ':repo', 'pulls'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const title = stringField(req.body, 'title');
      if (title === undefined || title === '') throw new StoreError(422, 'title is required');
      const head = stringField(req.body, 'head');
      const base = stringField(req.body, 'base');
      if (head === undefined || base === undefined) throw new StoreError(422, 'head and base are required');
      const pull = store.createPull(repo, { head, base, title, body: stringField(req.body, 'body') });
      return ok(pullJson(store, repo, pull), 201);
    },
  },
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo', 'pulls'],
    handler: (store, req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const pulls = store.listPulls(repo, {
        state: req.query.get('state') ?? undefined,
        per_page: parseNumber(req.query.get('per_page'), 30),
        page: parseNumber(req.query.get('page'), 1),
      });
      return ok(pulls.map((pull) => pullJson(store, repo, pull)));
    },
  },
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo', 'pulls', ':number'],
    handler: (store, _req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const pull = store.getPull(repo, Number.parseInt(params.number!, 10));
      if (pull === undefined) throw new StoreError(404, `Pull request #${params.number} not found`);
      return ok(pullJson(store, repo, pull));
    },
  },
  {
    method: 'GET',
    pattern: ['repos', ':owner', ':repo', 'pulls', ':number', 'files'],
    handler: (store, _req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const pull: Pull | undefined = store.getPull(repo, Number.parseInt(params.number!, 10));
      if (pull === undefined) throw new StoreError(404, `Pull request #${params.number} not found`);
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      if (baseTip === undefined || headTip === undefined) return ok([]);
      const baseCommit = repo.objects.get(baseTip);
      const headCommit = repo.objects.get(headTip);
      if (baseCommit === undefined || headCommit === undefined) return ok([]);
      // Diff the merge-base tree against the head tree, so a pull opened after
      // the base moved still lists exactly the head branch's changes.
      const mergeBase = store.mergeBase(repo, headTip, baseTip) ?? pull.baseSha;
      const baseObject = repo.objects.get(mergeBase);
      if (baseObject === undefined) return ok([]);
      const files = store.diffTrees(repo, parseCommit(baseObject.data).tree, parseCommit(headCommit.data).tree);
      return ok(
        files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
        })),
      );
    },
  },
  {
    method: 'PUT',
    pattern: ['repos', ':owner', ':repo', 'pulls', ':number', 'merge'],
    handler: (store, _req, params) => {
      const repo = requireRepo(store, params.owner!, params.repo!);
      const pull: Pull | undefined = store.getPull(repo, Number.parseInt(params.number!, 10));
      if (pull === undefined) throw new StoreError(404, `Pull request #${params.number} not found`);
      const result = store.mergePull(repo, pull);
      return ok({ merged: true, sha: result.sha, message: result.message });
    },
  },
];

/**
 * Handle one /api/v3 request. Returns a JSON response; unknown routes are a
 * JSON 404 and store errors carry their status. Auth failures are 401.
 */
export function handleRest(store: Store, req: RestRequest): RestResponse {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '' || req.authHeader !== `Bearer ${expected}`) {
    return err(401, 'Bad credentials');
  }
  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    const params = matchRoute(route.pattern, req.segments);
    if (params === null) continue;
    try {
      return route.handler(store, req, params);
    } catch (error) {
      if (error instanceof StoreError) return err(error.status, error.message);
      throw error;
    }
  }
  return err(404, `No route matches ${req.method} /api/v3/${req.segments.join('/')}`);
}
