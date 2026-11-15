// graphql.ts — a small GraphQL v4 executor for the fixed set of documents the
// suite sends: viewer, repository, issues, pull requests, mutations, node(id:),
// introspection (__type) and operation batching.
//
// No GraphQL library: a hand-written tokenizer/parser for the document subset
// (operations, variables, arguments, inline fragments, named fragments), a
// schema table for validation and introspection, and resolvers over the shared
// Store. A GraphQL-level failure (unknown field, bad input) is a 200 with an
// `errors` array, never an HTTP error; a missing or wrong token is a 401.

import { parseCommit } from './git-objects.ts';
import {
  Store,
  StoreError,
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  trialIso,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'number' | 'punct' | 'spread' | 'var';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && text.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(text.slice(i + 1));
      if (!match) throw new Error(`bad variable at offset ${i}`);
      tokens.push({ kind: 'var', value: match[0] });
      i += 1 + match[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          const esc = text[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(text.slice(j + 2, j + 6), 16));
            j += 4;
          } else if (esc !== undefined) out += esc;
          j += 2;
        } else {
          out += text[j];
          j += 1;
        }
      }
      if (j >= text.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (!match) throw new Error(`bad number at offset ${i}`);
      tokens.push({ kind: 'number', value: match[0] });
      i += match[0].length;
      continue;
    }
    const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(text.slice(i));
    if (match) {
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldSelection | FragmentSelection;

interface Operation {
  operationType: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentDefinition {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what}, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDefinition> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operationType: 'query', name: null, variableDefinitions: [], selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        const on = this.expectName('the "on" keyword');
        if (on !== 'on') throw new Error(`expected "on", got ${JSON.stringify(on)}`);
        const typeCondition = this.expectName('a type condition');
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token.value)}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    const operationType = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next.kind === 'name') {
      name = this.next().value;
    }
    const variableDefinitions: Operation['variableDefinitions'] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const varToken = this.next();
        if (varToken.kind !== 'var') throw new Error(`expected a variable, got ${JSON.stringify(varToken.value)}`);
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varToken.value, defaultValue });
      }
      this.expectPunct(')');
    }
    return { operationType, name, variableDefinitions, selections: this.parseSelectionSet() };
  }

  /** Consume a type reference (`String!`, `[Int]`, `CreateIssueInput!`) without keeping it. */
  private parseType(): void {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      this.parseType();
      this.expectPunct(']');
    } else if (token.kind !== 'name') {
      throw new Error(`expected a type, got ${JSON.stringify(token.value)}`);
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      if (this.pos >= this.tokens.length) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition');
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next !== undefined && next.kind === 'name') {
        const name = this.next().value;
        return { kind: 'fragment', typeCondition: null, selections: [{ kind: 'field', alias: `__spread_${name}`, name: `__spread_${name}`, args: {}, selections: [] }] };
      }
      throw new Error('malformed fragment spread');
    }
    // A field: alias: name(args) { ... } | name(args) { ... } | name
    let name = this.expectName('a field name');
    let alias = name;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName('a field name after the alias');
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName('an argument name');
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    // Directives (@...) are accepted and ignored.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    const selections: SelectionNode[] =
      this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'var') return { kind: 'variable', name: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldSelection, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(field.args)) args[name] = resolveValue(node, variables);
  return args;
}

// ---------------------------------------------------------------------------------------------
// schema tables (validation + introspection)
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'comments', 'labels'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRef', 'baseRef',
    'mergeable', 'merged', 'mergeCommit', 'files', 'author', 'createdAt', 'updatedAt',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Ref: ['name', 'target'],
  Commit: ['oid', 'message'],
  Label: ['id', 'name', 'color'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'isDeprecated'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
};

const SCHEMA_KINDS: Record<string, 'OBJECT' | 'ENUM'> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  IssueComment: 'OBJECT',
  Ref: 'OBJECT',
  Commit: 'OBJECT',
  Label: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  IssueCommentConnection: 'OBJECT',
  LabelConnection: 'OBJECT',
  SearchResultItemConnection: 'OBJECT',
  IssueEdge: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  PullRequestChangedFileEdge: 'OBJECT',
  IssueCommentEdge: 'OBJECT',
  LabelEdge: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  PageInfo: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __EnumValue: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  RepositoryPermission: 'ENUM',
  ChangeType: 'ENUM',
};

const SCHEMA_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  ChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED'],
};

/** The return type of each field; `[X]` is a list of X. Scalars are ID/Int/String/Boolean/DateTime. */
const RETURN_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', search: 'SearchResultItemConnection', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { login: 'String', id: 'ID', name: 'String', email: 'String', avatarUrl: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest', description: 'String', isPrivate: 'Boolean',
    createdAt: 'DateTime', updatedAt: 'DateTime',
  },
  Issue: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'IssueState', author: 'User',
    createdAt: 'DateTime', updatedAt: 'DateTime', comments: 'IssueCommentConnection', labels: 'LabelConnection',
  },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState',
    headRefName: 'String', baseRefName: 'String', headRef: 'Ref', baseRef: 'Ref',
    mergeable: 'MergeableState', merged: 'Boolean', mergeCommit: 'Commit', files: 'PullRequestChangedFileConnection',
    author: 'User', createdAt: 'DateTime', updatedAt: 'DateTime',
  },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'DateTime', updatedAt: 'DateTime' },
  Ref: { name: 'String', target: 'Commit' },
  Commit: { oid: 'String', message: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String' },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', edges: '[PullRequestChangedFileEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentConnection: { nodes: '[IssueComment]', edges: '[IssueCommentEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  LabelConnection: { nodes: '[Label]', edges: '[LabelEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  SearchResultItemConnection: { nodes: '[Repository]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile', cursor: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  LabelEdge: { node: 'Label', cursor: 'String' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'ChangeType' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', comment: 'IssueComment', clientMutationId: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String', description: 'String', isDeprecated: 'Boolean' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean' },
};

const SCALARS = new Set(['ID', 'Int', 'String', 'Boolean', 'DateTime', 'Float']);

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

/** Every object value carries its GraphQL type name. */
type GqlObject = Record<string, unknown> & { __typename: string };

function viewerUser(): GqlObject {
  return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, avatarUrl: null };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function commentObject(repo: Repo, issue: Issue, comment: Comment): GqlObject {
  return { __typename: 'IssueComment', repo, issue, comment };
}

// ---------------------------------------------------------------------------------------------
// cursors
// ---------------------------------------------------------------------------------------------

function encodeCursor(key: number): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface ConnectionInput {
  nodes: GqlObject[];
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  cursorOf: (node: GqlObject) => number;
}

function makeConnection(typeName: string, input: ConnectionInput): GqlObject {
  const edges = input.nodes.map((node) => ({
    __typename: `${typeName}Edge`,
    node,
    cursor: encodeCursor(input.cursorOf(node)),
  }));
  return {
    __typename: `${typeName}Connection`,
    nodes: input.nodes,
    edges,
    totalCount: input.total,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: input.hasNextPage,
      hasPreviousPage: input.hasPreviousPage,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------------------------

class GraphQLError extends Error {}

interface GqlContext {
  store: Store;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repoFromGlobalId(store: Store, id: unknown): Repo {
  if (typeof id !== 'string') throw new GraphQLError('repositoryId must be a global id string');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'repo') throw new GraphQLError(`no repository with id ${JSON.stringify(id)}`);
  const repo = store.getRepo(decoded.owner, decoded.name);
  if (repo === undefined) throw new GraphQLError(`no repository with id ${JSON.stringify(id)}`);
  return repo;
}

function issueFromGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } {
  if (typeof id !== 'string') throw new GraphQLError('issueId must be a global id string');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'issue') throw new GraphQLError(`no issue with id ${JSON.stringify(id)}`);
  const repo = store.getRepoByGlobalId(decoded.repoId);
  if (repo === undefined) throw new GraphQLError(`no issue with id ${JSON.stringify(id)}`);
  const issue = store.getIssue(repo, decoded.number);
  if (issue === undefined) throw new GraphQLError(`no issue with id ${JSON.stringify(id)}`);
  return { repo, issue };
}

function pullFromGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } {
  if (typeof id !== 'string') throw new GraphQLError('pullRequestId must be a global id string');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'pull') throw new GraphQLError(`no pull request with id ${JSON.stringify(id)}`);
  const repo = store.getRepoByGlobalId(decoded.repoId);
  if (repo === undefined) throw new GraphQLError(`no pull request with id ${JSON.stringify(id)}`);
  const pull = store.getPull(repo, decoded.number);
  if (pull === undefined) throw new GraphQLError(`no pull request with id ${JSON.stringify(id)}`);
  return { repo, pull };
}

function buildIssueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const descending = orderBy.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const after = decodeCursor(args.after);
  if (after !== null) issues = issues.filter((issue) => (descending ? issue.number < after : issue.number > after));
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : issues.length;
  const page = issues.slice(0, first);
  return makeConnection('Issue', {
    nodes: page.map((issue) => issueObject(repo, issue)),
    total: issues.length,
    hasNextPage: issues.length > first,
    hasPreviousPage: after !== null,
    cursorOf: (node) => (node.issue as Issue).number,
  });
}

function buildPullRequestConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let pulls = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.state));
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((a, b) => b.number - a.number);
  const after = decodeCursor(args.after);
  if (after !== null) pulls = pulls.filter((pull) => pull.number < after);
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  return makeConnection('PullRequest', {
    nodes: page.map((pull) => pullObject(repo, pull)),
    total: pulls.length,
    hasNextPage: pulls.length > first,
    hasPreviousPage: after !== null,
    cursorOf: (node) => (node.pull as Pull).number,
  });
}

function buildFilesConnection(store: Store, repo: Repo, pull: Pull, args: Record<string, unknown>): GqlObject {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  let files: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> = [];
  if (baseTip !== undefined && headTip !== undefined) {
    const mergeBase = store.mergeBase(repo, headTip, baseTip) ?? pull.baseSha;
    const baseObject = repo.objects.get(mergeBase);
    const headObject = repo.objects.get(headTip);
    if (baseObject !== undefined && headObject !== undefined) {
      files = store.diffTrees(repo, parseCommit(baseObject.data).tree, parseCommit(headObject.data).tree);
    }
  }
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : files.length;
  const page = files.slice(0, first);
  const nodes = page.map((file) => ({
    __typename: 'PullRequestChangedFile',
    path: file.filename,
    additions: file.additions,
    deletions: file.deletions,
    changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
  }));
  return makeConnection('PullRequestChangedFile', {
    nodes,
    total: files.length,
    hasNextPage: files.length > first,
    hasPreviousPage: false,
    cursorOf: (node) => nodes.indexOf(node),
  });
}

function buildCommentConnection(repo: Repo, issue: Issue, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : issue.comments.length;
  const after = decodeCursor(args.after);
  let comments = issue.comments;
  if (after !== null) comments = comments.slice(after + 1);
  const page = comments.slice(0, first);
  const nodes = page.map((comment) => commentObject(repo, issue, comment));
  return makeConnection('IssueComment', {
    nodes,
    total: issue.comments.length,
    hasNextPage: comments.length > first,
    hasPreviousPage: after !== null,
    cursorOf: (node) => issue.comments.indexOf(node.comment as Comment),
  });
}

/**
 * Resolve one field on a typed value. Returns the raw value; the executor
 * recurses into it using the field's declared return type.
 */
function resolveField(
  ctx: GqlContext,
  typeName: string,
  parent: GqlObject | null,
  field: FieldSelection,
  args: Record<string, unknown>,
): unknown {
  const { store } = ctx;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return viewerUser();
      if (field.name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoObject(repo);
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.kind === 'repo') {
          const repo = store.getRepo(decoded.owner, decoded.name);
          return repo === undefined ? null : repoObject(repo);
        }
        if (decoded.kind === 'issue') {
          const repo = store.getRepoByGlobalId(decoded.repoId);
          if (repo === undefined) return null;
          const issue = store.getIssue(repo, decoded.number);
          return issue === undefined ? null : issueObject(repo, issue);
        }
        if (decoded.kind === 'pull') {
          const repo = store.getRepoByGlobalId(decoded.repoId);
          if (repo === undefined) return null;
          const pull = store.getPull(repo, decoded.number);
          return pull === undefined ? null : pullObject(repo, pull);
        }
        if (decoded.kind === 'comment') {
          const repo = store.getRepoByGlobalId(decoded.repoId);
          if (repo === undefined) return null;
          const issue = store.getIssue(repo, decoded.number);
          if (issue === undefined) return null;
          const comment = issue.comments.find((candidate) => candidate.id === decoded.commentId);
          return comment === undefined ? null : commentObject(repo, issue, comment);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        const kind = SCHEMA_KINDS[name];
        if (kind === undefined) return null;
        return {
          __typename: '__Type',
          name,
          kind,
          fields: (SCHEMA_FIELDS[name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName, description: null, isDeprecated: false })),
          enumValues:
            kind === 'ENUM'
              ? (SCHEMA_ENUM_VALUES[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false }))
              : null,
        };
      }
      if (field.name === 'search') {
        return makeConnection('SearchResultItem', {
          nodes: [],
          total: 0,
          hasNextPage: false,
          hasPreviousPage: false,
          cursorOf: () => 0,
        });
      }
      break;
    }
    case 'Mutation': {
      const input = isRecord(args.input) ? args.input : {};
      if (field.name === 'createIssue') {
        const repo = repoFromGlobalId(store, input.repositoryId);
        const title = input.title;
        if (typeof title !== 'string' || title === '') throw new GraphQLError('createIssue requires a title');
        const issue = store.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
        return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
      }
      if (field.name === 'closeIssue') {
        const { repo, issue } = issueFromGlobalId(store, input.issueId);
        store.patchIssue(repo, issue.number, { state: 'closed' });
        return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
      }
      if (field.name === 'createPullRequest') {
        const repo = repoFromGlobalId(store, input.repositoryId);
        const title = input.title;
        if (typeof title !== 'string' || title === '') throw new GraphQLError('createPullRequest requires a title');
        const pull = store.createPull(repo, {
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
          title,
          body: typeof input.body === 'string' ? input.body : '',
        });
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null };
      }
      if (field.name === 'mergePullRequest') {
        const { repo, pull } = pullFromGlobalId(store, input.pullRequestId);
        try {
          store.mergePull(repo, pull);
        } catch (error) {
          if (error instanceof StoreError) throw new GraphQLError(error.message);
          throw error;
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null };
      }
      if (field.name === 'addComment') {
        const { repo, issue } = issueFromGlobalId(store, input.subjectId);
        const body = input.body;
        if (typeof body !== 'string' || body === '') throw new GraphQLError('addComment requires a body');
        const comment = store.createComment(issue, body);
        const node = commentObject(repo, issue, comment);
        return {
          __typename: 'AddCommentPayload',
          comment: node,
          commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(issue.comments.indexOf(comment)) },
          clientMutationId: input.clientMutationId ?? null,
        };
      }
      break;
    }
    case 'User': {
      if (field.name === 'login') return parent?.login ?? null;
      if (field.name === 'id') return parent?.id !== undefined ? String(parent.id) : null;
      if (field.name === 'name') return parent?.name ?? null;
      if (field.name === 'email') return parent?.email ?? null;
      if (field.name === 'avatarUrl') return parent?.avatarUrl ?? null;
      break;
    }
    case 'Repository': {
      const repo = parent?.repo as Repo;
      if (field.name === 'id') return repo.globalId;
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return viewerUser();
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'isPrivate') return repo.private;
      if (field.name === 'createdAt' || field.name === 'updatedAt') return trialIso();
      if (field.name === 'issue') {
        const issue = store.getIssue(repo, Number(args.number));
        return issue === undefined ? null : issueObject(repo, issue);
      }
      if (field.name === 'issues') return buildIssueConnection(repo, args);
      if (field.name === 'pullRequests') return buildPullRequestConnection(repo, args);
      if (field.name === 'pullRequest') {
        const pull = store.getPull(repo, Number(args.number));
        return pull === undefined ? null : pullObject(repo, pull);
      }
      break;
    }
    case 'Issue': {
      const issue = parent?.issue as Issue;
      const repo = parent?.repo as Repo;
      if (field.name === 'id') return issueGlobalId(repo.globalId, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'body') return issue.body;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'author') return viewerUser();
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      if (field.name === 'comments') return buildCommentConnection(repo, issue, args);
      if (field.name === 'labels') {
        const nodes = issue.labels.map((label) => ({ __typename: 'Label', id: label.name, name: label.name, color: label.color }));
        return makeConnection('Label', {
          nodes,
          total: nodes.length,
          hasNextPage: false,
          hasPreviousPage: false,
          cursorOf: (node) => nodes.indexOf(node),
        });
      }
      break;
    }
    case 'PullRequest': {
      const pull = parent?.pull as Pull;
      const repo = parent?.repo as Repo;
      if (field.name === 'id') return pullGlobalId(repo.globalId, pull.number);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'headRef') return { __typename: 'Ref', name: pull.headRef };
      if (field.name === 'baseRef') return { __typename: 'Ref', name: pull.baseRef };
      if (field.name === 'mergeable') return store.mergeable(repo, pull);
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeCommit') {
        return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha, message: '' };
      }
      if (field.name === 'files') return buildFilesConnection(store, repo, pull, args);
      if (field.name === 'author') return viewerUser();
      if (field.name === 'createdAt') return pull.createdAt;
      if (field.name === 'updatedAt') return pull.updatedAt;
      break;
    }
    case 'IssueComment': {
      const comment = parent?.comment as Comment;
      const repo = parent?.repo as Repo;
      const issue = parent?.issue as Issue;
      if (field.name === 'id') return commentGlobalId(repo.globalId, issue.number, comment.id);
      if (field.name === 'body') return comment.body;
      if (field.name === 'author') return viewerUser();
      if (field.name === 'createdAt') return comment.createdAt;
      if (field.name === 'updatedAt') return comment.createdAt;
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return parent?.name ?? null;
      if (field.name === 'target') return null;
      break;
    }
    case 'Commit': {
      if (field.name === 'oid') return parent?.oid ?? null;
      if (field.name === 'message') return parent?.message ?? null;
      break;
    }
    case 'Label': {
      if (field.name === 'id') return parent?.id ?? null;
      if (field.name === 'name') return parent?.name ?? null;
      if (field.name === 'color') return parent?.color ?? null;
      break;
    }
    case 'PageInfo': {
      return parent?.[field.name] ?? null;
    }
    case '__Type': {
      if (field.name === 'name') return parent?.name ?? null;
      if (field.name === 'kind') return parent?.kind ?? null;
      if (field.name === 'fields') return parent?.fields ?? null;
      if (field.name === 'enumValues') return parent?.enumValues ?? null;
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return parent?.name ?? null;
      if (field.name === 'description') return parent?.description ?? null;
      if (field.name === 'isDeprecated') return parent?.isDeprecated ?? false;
      break;
    }
    default: {
      // Connection and edge types read their fields straight off the object.
      if (parent !== null && field.name in parent) return parent[field.name];
      break;
    }
  }
  throw new GraphQLError(`no resolver for ${typeName}.${field.name}`);
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

function validateSelections(
  selections: SelectionNode[],
  typeName: string,
  errors: Array<{ message: string }>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      validateSelections(selection.selections, selection.typeCondition ?? typeName, errors);
      continue;
    }
    const { name } = selection;
    if (name === '__typename') continue;
    if (name.startsWith('__spread_')) {
      errors.push({ message: `Cannot query field "${name}" on type "${typeName}": named fragment spreads are not supported.` });
      continue;
    }
    const fields = SCHEMA_FIELDS[typeName];
    if (fields === undefined || !fields.includes(name)) {
      errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
      continue;
    }
    if (selection.selections.length > 0) {
      const returnType = RETURN_TYPES[typeName]?.[name];
      if (returnType === undefined) continue;
      const inner = returnType.replace(/^\[|\]$/g, '');
      if (SCALARS.has(inner)) {
        errors.push({ message: `Field "${name}" must not have a selection since type "${inner}" has no subfields.` });
        continue;
      }
      // A `node` field resolves to whatever concrete type the id names; its
      // sub-selections are validated lazily at execution time.
      if (inner === 'Node') continue;
      validateSelections(selection.selections, inner, errors);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

function executeSelectionSet(
  selections: SelectionNode[],
  value: GqlObject | null,
  typeName: string,
  ctx: GqlContext,
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const condition = selection.typeCondition;
      if (condition !== null && value !== null && value.__typename !== condition) continue;
      const merged = executeSelectionSet(selection.selections, value, condition ?? typeName, ctx, variables, errors);
      Object.assign(out, merged);
      continue;
    }
    if (selection.name === '__typename') {
      out[selection.alias] = typeName;
      continue;
    }
    const args = resolveArgs(selection, variables);
    let resolved: unknown;
    try {
      resolved = resolveField(ctx, typeName, value, selection, args);
    } catch (error) {
      if (error instanceof GraphQLError) {
        errors.push({ message: error.message });
        out[selection.alias] = null;
        continue;
      }
      throw error;
    }
    if (selection.selections.length === 0) {
      out[selection.alias] = resolved;
      continue;
    }
    if (resolved === null || resolved === undefined) {
      out[selection.alias] = null;
      continue;
    }
    const returnType = RETURN_TYPES[typeName]?.[selection.name] ?? 'String';
    const isList = returnType.startsWith('[');
    const inner = returnType.replace(/^\[|\]$/g, '');
    if (isList) {
      if (!Array.isArray(resolved)) {
        errors.push({ message: `Field "${selection.name}" did not return a list.` });
        out[selection.alias] = null;
        continue;
      }
      out[selection.alias] = resolved.map((entry) => {
        if (entry === null || typeof entry !== 'object') return entry;
        const concrete = (entry as GqlObject).__typename ?? inner;
        return executeSelectionSet(selection.selections, entry as GqlObject, concrete, ctx, variables, errors);
      });
      continue;
    }
    if (typeof resolved !== 'object') {
      errors.push({ message: `Field "${selection.name}" must not have a selection since it returns a scalar.` });
      out[selection.alias] = null;
      continue;
    }
    const concrete = (resolved as GqlObject).__typename ?? inner;
    out[selection.alias] = executeSelectionSet(selection.selections, resolved as GqlObject, concrete, ctx, variables, errors);
  }
  return out;
}

interface OperationResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

function executeOperation(
  store: Store,
  operation: Operation,
  variables: Record<string, unknown>,
): OperationResult {
  const errors: Array<{ message: string }> = [];
  const ctx: GqlContext = { store };
  const rootType = operation.operationType === 'mutation' ? 'Mutation' : 'Query';
  // Variable defaults.
  const resolvedVariables: Record<string, unknown> = { ...variables };
  for (const definition of operation.variableDefinitions) {
    if (resolvedVariables[definition.name] === undefined && definition.defaultValue !== undefined) {
      resolvedVariables[definition.name] = resolveValue(definition.defaultValue, resolvedVariables);
    }
  }
  validateSelections(operation.selections, rootType, errors);
  if (errors.length > 0) return { data: null, errors };
  try {
    const data = executeSelectionSet(operation.selections, null, rootType, ctx, resolvedVariables, errors);
    if (errors.length > 0) return { data, errors };
    return { data, errors: [] };
  } catch (error) {
    if (error instanceof GraphQLError) return { data: null, errors: [{ message: error.message }] };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResponse {
  status: number;
  json: unknown;
}

/**
 * Handle one POST /api/graphql request. `body` is the parsed JSON body (an
 * object for one operation, an array for a batch). Auth failures are 401;
 * GraphQL-level failures are 200 with an `errors` array.
 */
export function handleGraphQL(store: Store, body: unknown, authHeader: string | null): GraphQLResponse {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '' || authHeader !== `Bearer ${expected}`) {
    return { status: 401, json: { message: 'Bad credentials' } };
  }
  const operations = Array.isArray(body) ? body : [body];
  const results: OperationResult[] = [];
  for (const entry of operations) {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'each operation needs a query string' }] });
      continue;
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    let parsed: { operations: Operation[]; fragments: Map<string, FragmentDefinition> };
    try {
      parsed = new Parser(tokenize(entry.query)).parseDocument();
    } catch (error) {
      results.push({ data: null, errors: [{ message: `syntax error: ${(error as Error).message}` }] });
      continue;
    }
    // Expand named fragment spreads inline (the fixed documents use inline
    // fragments, but named ones are cheap to support).
    const expand = (selections: SelectionNode[], depth: number): SelectionNode[] => {
      if (depth > 10) throw new Error('fragment nesting too deep');
      const out: SelectionNode[] = [];
      for (const selection of selections) {
        if (selection.kind === 'field' && selection.name.startsWith('__spread_')) {
          const name = selection.name.slice('__spread_'.length);
          const fragment = parsed.fragments.get(name);
          if (fragment === undefined) throw new Error(`unknown fragment "${name}"`);
          out.push({
            kind: 'fragment',
            typeCondition: fragment.typeCondition,
            selections: expand(fragment.selections, depth + 1),
          });
          continue;
        }
        if (selection.kind === 'field') {
          out.push({ ...selection, selections: expand(selection.selections, depth + 1) });
        } else {
          out.push({ ...selection, selections: expand(selection.selections, depth + 1) });
        }
      }
      return out;
    };
    let operation: Operation | undefined;
    if (typeof entry.operationName === 'string' && entry.operationName !== '') {
      operation = parsed.operations.find((candidate) => candidate.name === entry.operationName);
    } else if (parsed.operations.length === 1) {
      operation = parsed.operations[0];
    }
    if (operation === undefined) {
      results.push({ data: null, errors: [{ message: 'no operation found in the document' }] });
      continue;
    }
    try {
      operation = { ...operation, selections: expand(operation.selections, 0) };
      results.push(executeOperation(store, operation, variables));
    } catch (error) {
      results.push({ data: null, errors: [{ message: (error as Error).message }] });
    }
  }
  if (Array.isArray(body)) return { status: 200, json: results };
  return { status: 200, json: results[0] ?? { data: null, errors: [{ message: 'empty request' }] } };
}
