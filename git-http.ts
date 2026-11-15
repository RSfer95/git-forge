// git-http.ts — git smart HTTP: pkt-line codec, v2/v0 advertisements,
// ls-refs, fetch (v2 + v0, with shallow/deepen), and receive-pack.
//
// The wire shapes follow the git protocol: a v2 fetch answers in sections
// (acknowledgments, shallow-info, packfile) with sideband framing; a v0
// fetch answers a flat stream; a push answers a report-status report in
// band 1 when side-band-64k was negotiated.

import {
  collectReachable,
  parseCommit,
  peelTag,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git-objects.ts';
import { Store, type Repo } from './store.ts';

export class GitHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

const PKT_LINE_MAX_PAYLOAD = 65516;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error(`pkt-line payload is ${data.length} bytes, over the maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload?: Buffer;
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from `buffer` starting at `start`, stopping after the
 * first flush (inclusive). Returns the packets and the offset just past the
 * flush (or the end of the buffer when no flush was found).
 */
export function decodeUntilFlush(
  buffer: Buffer,
  start: number,
): { packets: DecodedPacket[]; next: number; endedWithFlush: boolean } {
  const packets: DecodedPacket[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new GitHttpError(400, `invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, next: offset + 4, endedWithFlush: true };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new GitHttpError(400, 'invalid pkt-line length 0003');
    if (length > 65520) throw new GitHttpError(400, `pkt-line length ${length} exceeds 65520`);
    if (offset + length > buffer.length) throw new GitHttpError(400, 'truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buffer.length) throw new GitHttpError(400, 'truncated pkt-line header');
  return { packets, next: offset, endedWithFlush: false };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

const AGENT = 'makefun-forge/1.0';

function v2UploadPackAdvertisement(): Buffer {
  const caps = ['ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1', `agent=${AGENT}`];
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of caps) parts.push(pktLine(`${cap}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface ListedRef {
  name: string;
  oid: string;
  peeled?: string;
}

/** Heads then tags, each sorted by name; annotated tags carry their peeled commit. */
function sortedRefs(repo: Repo): ListedRef[] {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const heads: ListedRef[] = [];
  const tags: ListedRef[] = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) heads.push({ name: ref, oid });
    else if (ref.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      let peeled: string | undefined;
      if (object && object.type === 'tag') {
        const target = peelTag(oid, lookup);
        const targetObject = repo.objects.get(target);
        if (targetObject && targetObject.type === 'commit') peeled = target;
      }
      tags.push({ name: ref, oid, peeled });
    }
  }
  const byName = (a: ListedRef, b: ListedRef): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  heads.sort(byName);
  tags.sort(byName);
  return [...heads, ...tags];
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k shallow thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const serviceLine = service === 'git-upload-pack' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const parts: Buffer[] = [pktLine(serviceLine)];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} HEAD\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocolV2: boolean,
): { contentType: string; body: Buffer } {
  if (service === 'git-upload-pack') {
    if (gitProtocolV2) {
      return { contentType: 'application/x-git-upload-pack-advertisement', body: v2UploadPackAdvertisement() };
    }
    return { contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, service) };
  }
  return { contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, service) };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodeUntilFlush(body, 0);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8');
    if (line === 'command=ls-refs\n') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'peel\n') peel = true;
    else if (line === 'symrefs\n') symrefs = true;
    else if (line === 'unborn\n') continue;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).replace(/\n$/, ''));
  }
  const lines: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (prefixes.length === 0) {
    if (headTip !== undefined) {
      lines.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------------------------------------
// fetch: request parsing
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function parseFetchV2(body: Buffer): FetchRequest {
  const { packets } = decodeUntilFlush(body, 0);
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'command=fetch') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line === 'done') continue;
    if (line.startsWith('filter ')) continue;
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) continue;
    else throw new GitHttpError(400, `unknown fetch argument ${JSON.stringify(line.slice(0, 40))}`);
  }
  if (req.wants.length === 0) throw new GitHttpError(400, 'fetch with no wants');
  return req;
}

function parseFetchV0(body: Buffer): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  const first = decodeUntilFlush(body, 0);
  for (const packet of first.packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want line may carry capabilities after the oid.
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      req.wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
    } else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) continue;
    else throw new GitHttpError(400, `unknown v0 fetch line ${JSON.stringify(line.slice(0, 40))}`);
  }
  const second = decodeUntilFlush(body, first.next);
  for (const packet of second.packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line === 'done') continue;
    else throw new GitHttpError(400, `unknown v0 fetch line ${JSON.stringify(line.slice(0, 40))}`);
  }
  if (req.wants.length === 0) throw new GitHttpError(400, 'fetch with no wants');
  return req;
}

// ---------------------------------------------------------------------------------------------
// fetch: object selection
// ---------------------------------------------------------------------------------------------

/**
 * A depth-limited walk from `wants`: generation 1 is the wants themselves,
 * each generation adds a commit's tree closure and its parents at the next
 * generation. Commits at exactly `depth` are the shallow boundaries.
 */
function depthWalk(
  repo: Repo,
  wants: readonly string[],
  depth: number,
): { visited: Set<string>; boundaries: string[] } {
  const visited = new Set<string>();
  const boundaries: string[] = [];
  const queue: Array<{ oid: string; gen: number }> = [];
  let head = 0;
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      visited.add(want);
      const target = peelTag(want, (oid) => repo.objects.get(oid));
      const targetObject = repo.objects.get(target);
      if (targetObject && targetObject.type === 'commit') queue.push({ oid: target, gen: 1 });
      else if (targetObject) visited.add(target);
    } else if (object.type === 'commit') {
      queue.push({ oid: want, gen: 1 });
    } else {
      visited.add(want);
    }
  }
  const seenCommits = new Set<string>();
  while (head < queue.length) {
    const { oid, gen } = queue[head++]!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    visited.add(oid);
    const commit = parseCommit(object.data);
    for (const reachable of collectReachable([commit.tree], (id) => repo.objects.get(id), { allowMissing: true })) {
      visited.add(reachable);
    }
    if (gen >= depth) {
      boundaries.push(oid);
    } else {
      for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  return { visited, boundaries };
}

interface SelectedObjects {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function selectObjects(store: Store, repo: Repo, req: FetchRequest): SelectedObjects {
  if (req.depth !== undefined) {
    const { visited, boundaries } = depthWalk(repo, req.wants, req.depth);
    const shallow: string[] = [...boundaries];
    const unshallow: string[] = [];
    for (const boundary of req.shallow) {
      const object = repo.objects.get(boundary);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (visited.has(boundary) && parents.every((parent) => visited.has(parent))) {
        unshallow.push(boundary);
      } else if (!shallow.includes(boundary)) {
        shallow.push(boundary);
      }
    }
    const objects: GitObject[] = [];
    for (const oid of visited) {
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }
    return { objects, shallow, unshallow };
  }
  const wanted = store.reachable(repo, req.wants);
  const held = req.haves.length > 0 ? store.reachable(repo, req.haves, true) : new Set<string>();
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow: [], unshallow: [] };
}

// ---------------------------------------------------------------------------------------------
// fetch: response framing
// ---------------------------------------------------------------------------------------------

/** Split pack bytes into sideband band-1 pkt-lines (payload ≤ 65,516 bytes). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function buildFetchV2Response(acks: string[], shallow: string[], unshallow: string[], pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (acks.length > 0) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function buildFetchV0Response(acks: string[], shallow: string[], unshallow: string[], pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  if (acks.length > 0) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponse(store: Store, repo: Repo, req: FetchRequest, version: 2 | 0): Buffer {
  const selected = selectObjects(store, repo, req);
  // A pack is always sent, even when no objects are due (an empty pack).
  const pack = writePack(selected.objects);
  const acks = req.haves.filter((have) => repo.objects.has(have));
  if (version === 2) return buildFetchV2Response(acks, selected.shallow, selected.unshallow, pack);
  return buildFetchV0Response(acks, selected.shallow, selected.unshallow, pack);
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST dispatch
// ---------------------------------------------------------------------------------------------

export function handleUploadPack(
  store: Store,
  repo: Repo,
  body: Buffer,
): { contentType: string; body: Buffer } {
  if (body.length === 0) throw new GitHttpError(400, 'empty upload-pack request');
  const { packets } = decodeUntilFlush(body, 0);
  const first = packets.find((packet) => packet.kind === 'data');
  if (!first || first.payload === undefined) throw new GitHttpError(400, 'empty upload-pack request');
  const text = first.payload.toString('utf8');
  if (text.startsWith('command=ls-refs')) {
    return { contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, body) };
  }
  if (text.startsWith('command=fetch')) {
    const req = parseFetchV2(body);
    return { contentType: 'application/x-git-upload-pack-result', body: fetchResponse(store, repo, req, 2) };
  }
  if (text.startsWith('want ')) {
    const req = parseFetchV0(body);
    return { contentType: 'application/x-git-upload-pack-result', body: fetchResponse(store, repo, req, 0) };
  }
  throw new GitHttpError(400, `unknown upload-pack command ${JSON.stringify(text.slice(0, 40))}`);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets, next } = decodeUntilFlush(body, 0);
  const commands: PushCommand[] = [];
  let negotiatedSideband = false;
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    let line = packet.payload.toString('utf8');
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).replace(/\n$/, '').split(' ');
        negotiatedSideband = caps.includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)\n?$/.exec(line);
    if (!match) throw new GitHttpError(400, `bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  if (commands.length === 0) throw new GitHttpError(400, 'receive-pack with no commands');

  // Unpack first: a refused update must still unpack.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(next);
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: store.lookup(repo) });
      if (!read.checksumOk) throw new Error('pack trailer checksum mismatch');
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message.slice(0, 120);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let ok = false;
      if (cmd.newOid === ZERO_OID) {
        ok = current !== undefined && current === cmd.oldOid;
      } else if (cmd.oldOid === ZERO_OID) {
        ok = current === undefined && repo.objects.has(cmd.newOid);
      } else {
        ok =
          current === cmd.oldOid &&
          repo.objects.has(cmd.newOid) &&
          store.isAncestor(repo, cmd.oldOid, cmd.newOid);
      }
      if (ok) {
        if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
        else repo.refs.set(cmd.ref, cmd.newOid);
      }
      results.push({ ref: cmd.ref, ok, reason: ok ? '' : 'non-fast-forward' });
    }
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: 'unpack-failed' });
  }

  const lines = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat(lines.map((line) => pktLine(line)));
  const parts: Buffer[] = [];
  if (negotiatedSideband) {
    for (let offset = 0; offset < report.length; offset += 65515) {
      const chunk = report.subarray(offset, Math.min(report.length, offset + 65515));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
  } else {
    parts.push(report);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
