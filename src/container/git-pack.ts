import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export type GitPackObject = { oid: string; type: "commit" | "tree" | "blob" | "tag"; data: Uint8Array };

const MAX_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_OBJECTS = 50_000;
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_DELTA_DEPTH = 64;
const MAX_PREFIX_PACKETS = 1000;
const TYPE_NAMES: Readonly<Record<number, GitPackObject["type"]>> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

type Cursor = { offset: number; end: number };
type Entry = {
  offset: number;
  data: Uint8Array | undefined;
  base: number | string | undefined;
  object: GitPackObject | undefined;
  depth: number;
};

function fail(message: string): never {
  throw new Error(`Invalid Git upload-pack: ${message}`);
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Git pack parsing aborted", "AbortError");
}

function byte(bytes: Uint8Array, cursor: Cursor): number {
  if (cursor.offset >= cursor.end) fail("truncated object or delta instruction");
  return bytes[cursor.offset++]!;
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const value of bytes) result += value.toString(16).padStart(2, "0");
  return result;
}

function objectHash(type: GitPackObject["type"], data: Uint8Array): string {
  return createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
}

function deltaSize(bytes: Uint8Array, cursor: Cursor): number {
  let result = 0;
  let multiplier = 1;
  for (let index = 0; index < 4; index++) {
    const value = byte(bytes, cursor);
    result += (value & 127) * multiplier;
    if (result > MAX_OBJECT_BYTES) fail("delta size exceeds object cap");
    if (!(value & 128)) {
      if (index > 0 && value === 0) fail("noncanonical delta size varint");
      return result;
    }
    multiplier *= 128;
  }
  return fail("invalid delta size varint");
}

function applyDelta(base: Uint8Array, delta: Uint8Array, reserve: (size: number) => void, signal: AbortSignal | undefined): Uint8Array {
  const cursor = { offset: 0, end: delta.length };
  if (deltaSize(delta, cursor) !== base.length) fail("delta base size mismatch");
  const size = deltaSize(delta, cursor);
  reserve(size);
  const result = new Uint8Array(size);
  let written = 0;
  while (cursor.offset < cursor.end) {
    checkAbort(signal);
    const instruction = byte(delta, cursor);
    if (instruction & 128) {
      let offset = 0;
      let count = 0;
      for (let index = 0; index < 4; index++) {
        if (instruction & (1 << index)) offset += byte(delta, cursor) * 2 ** (8 * index);
      }
      for (let index = 0; index < 3; index++) {
        if (instruction & (1 << (index + 4))) count += byte(delta, cursor) * 2 ** (8 * index);
      }
      if (count === 0) count = 0x10000;
      if (offset > base.length || count > base.length - offset) fail("delta copy outside base");
      if (count > size - written) fail("delta output overflow");
      result.set(base.subarray(offset, offset + count), written);
      written += count;
    } else {
      if (instruction === 0) fail("zero delta instruction");
      if (instruction > cursor.end - cursor.offset) fail("truncated delta insert");
      if (instruction > size - written) fail("delta output overflow");
      result.set(delta.subarray(cursor.offset, cursor.offset + instruction), written);
      cursor.offset += instruction;
      written += instruction;
    }
  }
  if (written !== size) fail("delta output size mismatch");
  return result;
}

function packStart(bytes: Uint8Array, signal: AbortSignal | undefined): number {
  let offset = 0;
  let packets = 0;
  while (true) {
    checkAbort(signal);
    if (offset + 4 > bytes.length) fail("missing raw PACK or truncated prefix");
    const prefix = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (prefix === "PACK") return offset;
    if (!/^[0-9a-f]{4}$/.test(prefix)) fail("malformed prefix packet length");
    const length = Number.parseInt(prefix, 16);
    if (++packets > MAX_PREFIX_PACKETS) fail("prefix packet count cap exceeded");
    offset += 4;
    if (length === 0) continue;
    if (length < 5 || length > 68 || length - 4 > bytes.length - offset) fail("invalid or truncated prefix packet length");
    const message = String.fromCharCode(...bytes.subarray(offset, offset + length - 4));
    const match = /^(?:shallow [0-9a-f]{40}|unshallow [0-9a-f]{40}|NAK|ACK [0-9a-f]{40}(?: (?:common|ready|continue))?)\n?$/.exec(message);
    if (match?.[0] !== message) fail("invalid prefix text, ERR or sideband packet");
    offset += length - 4;
  }
}

export function parseUploadPackResponse(bytes: Uint8Array, signal?: AbortSignal): Map<string, GitPackObject> {
  checkAbort(signal);
  if (bytes.length > MAX_WIRE_BYTES) fail("wire size cap exceeded");
  const pack = bytes.subarray(packStart(bytes, signal));
  if (pack.length < 32) fail("truncated PACK header or checksum");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (view.getUint32(4) !== 2) fail("unsupported PACK version");
  const count = view.getUint32(8);
  if (count > MAX_OBJECTS) fail("object count cap exceeded");
  const end = pack.length - 20;
  if (createHash("sha1").update(pack.subarray(0, end)).digest("hex") !== hex(pack.subarray(end))) fail("PACK checksum mismatch");
  const cursor = { offset: 12, end };
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  const objects = new Map<string, GitPackObject>();
  const depths = new Map<string, number>();
  let expanded = 0;
  const reserve = (size: number): void => {
    if (size > MAX_OBJECT_BYTES) fail("object size cap exceeded");
    if (size > MAX_EXPANDED_BYTES - expanded) fail("aggregate expanded size cap exceeded");
    expanded += size;
  };
  const resolve = (entry: Entry, type: GitPackObject["type"], data: Uint8Array, depth: number): void => {
    const oid = objectHash(type, data);
    if (objects.has(oid)) fail("duplicate object oid");
    const object = { oid, type, data };
    entry.object = object;
    entry.data = undefined;
    entry.depth = depth;
    objects.set(oid, object);
    depths.set(oid, depth);
  };
  for (let index = 0; index < count; index++) {
    checkAbort(signal);
    const offset = cursor.offset;
    let value = byte(pack, cursor);
    const type = (value >> 4) & 7;
    if (!TYPE_NAMES[type] && type !== 6 && type !== 7) fail("invalid packed object type");
    let size = value & 15;
    let multiplier = 16;
    let headerBytes = 1;
    while (value & 128) {
      if (++headerBytes > 4) fail("invalid object size varint");
      value = byte(pack, cursor);
      size += (value & 127) * multiplier;
      if (size > MAX_OBJECT_BYTES) fail("object size cap exceeded");
      if (!(value & 128) && value === 0) fail("noncanonical object size varint");
      multiplier *= 128;
    }
    reserve(size);
    let base: number | string | undefined;
    if (type === 6) {
      value = byte(pack, cursor);
      let distance = value & 127;
      let length = 1;
      while (value & 128) {
        if (++length > 4) fail("invalid delta offset varint");
        value = byte(pack, cursor);
        distance = (distance + 1) * 128 + (value & 127);
        if (distance > offset) fail("invalid backward delta offset");
      }
      base = offset - distance;
      if (distance === 0 || !byOffset.has(base)) fail("missing backward delta base");
    } else if (type === 7) {
      if (cursor.end - cursor.offset < 20) fail("truncated ref delta oid");
      base = hex(pack.subarray(cursor.offset, cursor.offset + 20));
      cursor.offset += 20;
    }
    let decoded: { buffer: Uint8Array; engine: { bytesWritten: number } };
    try {
      decoded = inflateSync(pack.subarray(cursor.offset, end), { info: true, maxOutputLength: Math.max(1, size) }) as unknown as typeof decoded;
    } catch {
      return fail("invalid zlib stream or inflated size cap exceeded");
    }
    const consumed = decoded.engine.bytesWritten;
    if (decoded.buffer.length !== size) fail("declared inflated size mismatch");
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > end - cursor.offset) fail("invalid zlib stream consumption");
    cursor.offset += consumed;
    checkAbort(signal);
    const entry: Entry = { offset, data: decoded.buffer, base, object: undefined, depth: 0 };
    entries.push(entry);
    byOffset.set(offset, entry);
    const name = TYPE_NAMES[type];
    if (name) resolve(entry, name, decoded.buffer, 0);
  }
  if (cursor.offset !== end) fail("trailing PACK data or object count mismatch");
  let remaining = entries.reduce((total, entry) => total + Number(!entry.object), 0);
  for (let pass = 0; remaining > 0 && pass < MAX_DELTA_DEPTH; pass++) {
    let progress = false;
    for (const entry of entries) {
      checkAbort(signal);
      if (entry.object) continue;
      const baseEntry = typeof entry.base === "number" ? byOffset.get(entry.base) : undefined;
      const base = typeof entry.base === "string" ? objects.get(entry.base) : baseEntry?.object;
      if (!base) continue;
      const depth = (typeof entry.base === "string" ? depths.get(entry.base)! : baseEntry!.depth) + 1;
      if (depth > MAX_DELTA_DEPTH) fail("delta depth cap exceeded");
      const data = applyDelta(base.data, entry.data!, reserve, signal);
      resolve(entry, base.type, data, depth);
      remaining--;
      progress = true;
    }
    if (!progress) fail("unresolved ref delta base or cycle");
  }
  if (remaining > 0) fail("delta depth or resolution work cap exceeded");
  checkAbort(signal);
  return objects;
}
