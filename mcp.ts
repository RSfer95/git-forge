// mcp.ts — the Model Context Protocol endpoint at /mcp (JSON-RPC 2.0 over
// Streamable HTTP, plain JSON bodies).
//
// Modern era (2026-07-28): `server/discover` returns identity, capabilities
// and supported versions; no handshake, no session. The legacy `initialize` +
// `notifications/initialized` handshake is answered too, for older clients.
// Every request needs a Bearer token (MAKEFUN_SHOP_TOKEN); a missing or
// wrong token is HTTP 401. A body that is not JSON is HTTP 400 with
// JSON-RPC -32700. An unknown tool is JSON-RPC -32602; a tool called without
// its required arguments answers isError: true.

import {
  Store,
  StoreError,
  issueJson,
  pullJson,
  repoJson,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };
const CAPABILITIES = { tools: {} };

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required: string[];
  };
}

/** The tool list is a constant: two tools/list answers must be byte-identical. */
const TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (always the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRepo(store: Store, args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  const found = store.getRepo(owner, repo);
  if (found === undefined) throw new StoreError(404, `Repository ${owner}/${repo} not found`);
  return found;
}

/** The required arguments a tool call is missing, or an empty list. */
function missingArgs(tool: McpToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter(
    (name) => args[name] === undefined || args[name] === null || args[name] === '',
  );
}

interface ToolOutcome {
  structured: unknown;
  isError: boolean;
}

function toolResult(structured: unknown, isError = false): ToolOutcome {
  return { structured, isError };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw { jsonRpcCode: -32602, message: `Unknown tool "${name}"` };
  }
  const missing = missingArgs(tool, args);
  if (missing.length > 0) {
    return toolResult({ error: `missing required argument(s): ${missing.join(', ')}` }, true);
  }
  switch (name) {
    case 'create_repo': {
      const repo = store.createRepo({
        name: String(args.name),
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : undefined,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      return toolResult(repoJson(requireRepo(store, args)));
    }
    case 'create_issue': {
      const repo = requireRepo(store, args);
      const issue = store.createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = requireRepo(store, args);
      const issues = store.listIssues(repo, {
        state: typeof args.state === 'string' ? args.state : 'open',
        per_page: 100,
        page: 1,
      });
      return toolResult({ issues: issues.map((issue: Issue) => issueJson(repo, issue)) });
    }
    case 'get_issue': {
      const repo = requireRepo(store, args);
      const issue = store.getIssue(repo, Number(args.number));
      if (issue === undefined) throw new StoreError(404, `Issue #${args.number} not found`);
      return toolResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = requireRepo(store, args);
      const pull = store.createPull(repo, {
        head: String(args.head),
        base: String(args.base),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return toolResult(pullJson(store, repo, pull));
    }
    case 'list_pull_requests': {
      const repo = requireRepo(store, args);
      const pulls = store.listPulls(repo, {
        state: typeof args.state === 'string' ? args.state : 'open',
        per_page: 100,
        page: 1,
      });
      return toolResult({ pull_requests: pulls.map((pull: Pull) => pullJson(store, repo, pull)) });
    }
    case 'merge_pull_request': {
      const repo = requireRepo(store, args);
      const pull = store.getPull(repo, Number(args.pull_number));
      if (pull === undefined) throw new StoreError(404, `Pull request #${args.pull_number} not found`);
      const result = store.mergePull(repo, pull);
      return toolResult({ merged: true, sha: result.sha, message: result.message });
    }
    default:
      throw { jsonRpcCode: -32602, message: `Unknown tool "${name}"` };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------------------------

export interface McpResponse {
  /** HTTP status. `null` means the body is empty (a notification acknowledgement). */
  status: number | null;
  json: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string): McpResponse {
  return { status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

/**
 * Handle one POST /mcp request. `rawBody` is the exact request text: a body
 * that is not JSON is HTTP 400 with JSON-RPC -32700.
 */
export function handleMcp(store: Store, rawBody: string, authHeader: string | null): McpResponse {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '' || authHeader !== `Bearer ${expected}`) {
    return { status: 401, json: { message: 'Bad credentials' } };
  }
  let request: unknown;
  try {
    request = JSON.parse(rawBody) as unknown;
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(request) || typeof request.method !== 'string') {
    return { status: 200, json: { jsonrpc: '2.0', id: isRecord(request) ? request.id ?? null : null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = request.id ?? null;
  const method = request.method;
  const params = isRecord(request.params) ? request.params : {};

  // A notification (no id) is acknowledged with an empty 202.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, json: null };
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const offered = isRecord(params) ? params.protocolVersion : undefined;
      const protocolVersion =
        typeof offered === 'string' && SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    }
    case 'notifications/initialized': {
      return { status: 202, json: null };
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = params.name;
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      if (typeof name !== 'string' || name === '') {
        return rpcError(id, -32602, 'tools/call requires a tool name');
      }
      try {
        const outcome = callTool(store, name, args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(outcome.structured) }],
          structuredContent: outcome.structured,
          isError: outcome.isError,
        });
      } catch (error) {
        if (isRecord(error) && typeof error.jsonRpcCode === 'number') {
          return rpcError(id, error.jsonRpcCode, String(error.message ?? 'Unknown tool'));
        }
        if (error instanceof StoreError) {
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
            structuredContent: { error: error.message },
            isError: true,
          });
        }
        throw error;
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
