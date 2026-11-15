// app.ts — the entry's HTTP server: one in-memory Store shared by every
// surface (git smart HTTP, REST v3, GraphQL v4, MCP), plus the health probe.
//
// main.ts is the lifecycle and stays as it is; this file is the server to
// grow. Every JSON reply carries an X-GitHub-Request-Id (a deterministic
// counter, no clock, no randomness). Auth is a Bearer compare against
// MAKEFUN_SHOP_TOKEN on every route except /healthz.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { GitHttpError, handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { Store, StoreError } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Deterministic request ids: req-00000000000000000000000000000001, ... */
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(32, '0')}`;
}

/** Parse the request URL once; the path and query both come from this one object. */
function parseUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

/** The path of a request URL. */
function pathOf(url: URL): string {
  return url.pathname;
}

function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), JSON_TYPE, headers);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return false;
  return req.headers.authorization === `Bearer ${expected}`;
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = parseUrl(req);
      const path = pathOf(url);
      const method = req.method ?? 'GET';
      const query = url.searchParams;

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const host = req.headers.host ?? 'localhost';
        const baseUrl = `http://${host}`;

        // ---------------------------------------------------------------- git smart HTTP
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const action = gitMatch[3]!;
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: `Repository ${owner}/${repoName} not found` });
            return;
          }
          if (action === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' });
              return;
            }
            const service = query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'a service query parameter is required' });
              return;
            }
            const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            const advertisement = handleInfoRefs(repo, service, v2);
            sendBuffer(res, 200, advertisement.body, advertisement.contentType);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          if (action === 'git-upload-pack') {
            const result = handleUploadPack(store, repo, body);
            sendBuffer(res, 200, result.body, result.contentType);
            return;
          }
          const result = handleReceivePack(store, repo, body);
          sendBuffer(res, 200, result, 'application/x-git-receive-pack-result');
          return;
        }

        // ---------------------------------------------------------------- GraphQL v4
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Invalid JSON body' });
            return;
          }
          const result = handleGraphQL(store, parsed.value, req.headers.authorization ?? null);
          sendJson(res, result.status, result.json);
          return;
        }

        // ---------------------------------------------------------------- MCP
        if (path === '/mcp') {
          if (method === 'DELETE') {
            // A legacy session close: no session is ever handed out, so there
            // is nothing to close.
            res.writeHead(204, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(store, raw.toString('utf8'), req.headers.authorization ?? null);
          if (result.status === null || result.json === null) {
            res.writeHead(result.status ?? 202, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, result.status, result.json);
          return;
        }

        // ---------------------------------------------------------------- REST v3
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          const restPath = path === '/api/v3' || path === '/api/v3/' ? '' : path.slice('/api/v3/'.length);
          const segments = restPath === '' ? [] : restPath.split('/').map((segment) => decodeURIComponent(segment));
          // GET requests carry no body: do not wait for the body's end event.
          // (A GET that does carry one is drained, so keep-alive stays sound.)
          const contentLength = req.headers['content-length'];
          const getHasBody =
            (contentLength !== undefined && contentLength !== '0') || req.headers['transfer-encoding'] !== undefined;
          const raw = method === 'GET' && !getHasBody ? Buffer.alloc(0) : await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Invalid JSON body' });
            return;
          }
          const restReq: RestRequest = {
            method,
            segments,
            query,
            body: parsed.value,
            authHeader: req.headers.authorization ?? null,
            baseUrl,
          };
          const result = handleRest(store, restReq);
          if (result.status === 204) {
            res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, result.status, result.json, result.headers ?? {});
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (error instanceof GitHttpError) {
          sendJson(res, error.status, { message: error.message });
          return;
        }
        if (error instanceof StoreError) {
          sendJson(res, error.status, { message: error.message });
          return;
        }
        if (res.headersSent) {
          res.end();
          return;
        }
        process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
        sendJson(res, 500, { message: 'Internal Server Error' });
      }
    })();
  });
}
