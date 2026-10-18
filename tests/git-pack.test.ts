import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUploadPackResponse, type GitPackObject } from "../src/container/git-pack";

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, inflateSync: vi.fn(actual.inflateSync) };
});

const MIB = 1024 * 1024;
const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };
const bytes = (value: string | Uint8Array): Uint8Array => typeof value === "string" ? Buffer.from(value) : value;
const concat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const sha1 = (value: Uint8Array): Buffer => createHash("sha1").update(value).digest();
const oid = (type: GitPackObject["type"], data: string | Uint8Array): string => createHash("sha1").update(`${type} ${bytes(data).length}\0`).update(bytes(data)).digest("hex");
const packet = (message: string): Buffer => concat(bytes((Buffer.byteLength(message) + 4).toString(16).padStart(4, "0")), bytes(message));

function header(type: number, size: number): Uint8Array {
  const result = [(type << 4) | (size % 16)];
  size = Math.floor(size / 16);
  while (size > 0) {
    result[result.length - 1]! |= 128;
    result.push(size % 128);
    size = Math.floor(size / 128);
  }
  return new Uint8Array(result);
}

function sizeVarint(value: number): Uint8Array {
  const result: number[] = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    result.push(next | (value > 0 ? 128 : 0));
  } while (value > 0);
  return new Uint8Array(result);
}

function offsetVarint(value: number): Uint8Array {
  const result = [value % 128];
  while ((value = Math.floor(value / 128)) > 0) {
    value--;
    result.unshift(128 | (value % 128));
  }
  return new Uint8Array(result);
}

function object(type: GitPackObject["type"], data: string | Uint8Array, declaredSize = bytes(data).length): Uint8Array {
  return concat(header(TYPE_CODES[type], declaredSize), deflateSync(bytes(data)));
}

function delta(baseSize: number, resultSize: number, instructions: number[] | Uint8Array): Uint8Array {
  return concat(sizeVarint(baseSize), sizeVarint(resultSize), new Uint8Array(instructions));
}

function ref(base: string, data: Uint8Array): Uint8Array {
  return concat(header(7, data.length), Buffer.from(base, "hex"), deflateSync(data));
}

function ofs(distance: number, data: Uint8Array): Uint8Array {
  return concat(header(6, data.length), offsetVarint(distance), deflateSync(data));
}

function pack(entries: Uint8Array[], count = entries.length, version = 2): Buffer {
  const prefix = Buffer.alloc(12);
  prefix.write("PACK");
  prefix.writeUInt32BE(version, 4);
  prefix.writeUInt32BE(count, 8);
  const body = concat(prefix, ...entries);
  return concat(body, sha1(body));
}

function copy(offset: number, count: number): Uint8Array {
  let instruction = 128;
  const fields: number[] = [];
  for (let index = 0; index < 4; index++) {
    const value = Math.floor(offset / 2 ** (index * 8)) % 256;
    if (value) {
      instruction |= 1 << index;
      fields.push(value);
    }
  }
  for (let index = 0; index < 3; index++) {
    const value = Math.floor(count / 2 ** (index * 8)) % 256;
    if (value) {
      instruction |= 1 << (index + 4);
      fields.push(value);
    }
  }
  return new Uint8Array([instruction, ...fields]);
}

function assertObject(objects: Map<string, GitPackObject>, type: GitPackObject["type"], data: string | Uint8Array): void {
  const hash = oid(type, data);
  const result = objects.get(hash);
  expect(result?.oid).toBe(hash);
  expect(result?.type).toBe(type);
  expect(result?.data).toBeInstanceOf(Uint8Array);
  expect(Array.from(result!.data)).toEqual(Array.from(bytes(data)));
}

afterEach(() => vi.clearAllMocks());

describe("parseUploadPackResponse", () => {
  it("returns only the exact public exports and hashes all four Git object types", async () => {
    expect(Object.keys(await import("../src/container/git-pack"))).toEqual(["parseUploadPackResponse"]);
    const blob = bytes("hello\n");
    const tree = concat(bytes("100644 hello.txt\0"), Buffer.from(oid("blob", blob), "hex"));
    const commit = bytes(`tree ${oid("tree", tree)}\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\nfixture\n`);
    const tag = bytes(`object ${oid("commit", commit)}\ntype commit\ntag fixture\n\nfixture tag\n`);
    const values = [["commit", commit], ["tree", tree], ["blob", blob], ["tag", tag]] as const;
    const result = parseUploadPackResponse(pack(values.map(([type, data]) => object(type, data))));
    expect(result.size).toBe(4);
    for (const [type, data] of values) assertObject(result, type, data);
    expect(oid("blob", blob)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("accepts empty packs, empty objects and Uint8Array views with nonzero offsets", () => {
    expect(parseUploadPackResponse(pack([])).size).toBe(0);
    const wire = pack([object("blob", "")]);
    const backing = concat(bytes("padding"), wire, bytes("ignored"));
    assertObject(parseUploadPackResponse(new Uint8Array(backing.buffer, backing.byteOffset + 7, wire.length)), "blob", "");
  });

  it.each(["", "\n"])("accepts shallow, unshallow, ACK and NAK packets with terminal LF %j", (lf) => {
    const hash = "a".repeat(40);
    const prefix = concat(
      packet(`shallow ${hash}${lf}`), packet(`unshallow ${hash}${lf}`), bytes("0000"),
      packet(`ACK ${hash} common${lf}`), packet(`ACK ${hash} continue${lf}`),
      packet(`ACK ${hash} ready${lf}`), packet(`ACK ${hash}${lf}`), packet(`NAK${lf}`)
    );
    const result = parseUploadPackResponse(concat(prefix, pack([object("blob", "one"), object("blob", "two")])));
    assertObject(result, "blob", "one");
    assertObject(result, "blob", "two");
    expect(inflateSync).toHaveBeenCalledTimes(2);
  });

  it.each([
    "ERR denied\n", "\x01PACK", "\x02progress\n", "\x03fatal\n", "NAK\n\n", "NAK\r\n", "NAK\0", "NAK extra", "NAK\nACK " + "a".repeat(40),
    "shallow " + "a".repeat(39), "shallow " + "A".repeat(40), "ACK " + "a".repeat(40) + " unknown", ""
  ])("rejects invalid prefix text %j", (message) => {
    expect(() => parseUploadPackResponse(concat(packet(message), pack([])))).toThrow("prefix");
  });

  it.each(["0001", "0002", "0003", "0004", "gggg", "00FF", "ffffNAK", "0008NA", "000", "0000", "0008NAK\nX"])("rejects malformed or unterminated prefix %j", (prefix) => {
    expect(() => parseUploadPackResponse(bytes(prefix))).toThrow();
  });

  it("counts flush packets toward the prefix work cap", () => {
    expect(() => parseUploadPackResponse(concat(bytes("0000".repeat(1001)), pack([])))).toThrow("prefix packet count cap");
    expect(parseUploadPackResponse(concat(bytes("0000".repeat(1000)), pack([]))).size).toBe(0);
  });

  it("resolves ofs and ref deltas with copy and insert operations", () => {
    const base = object("blob", "hello world");
    const instructions = concat(copy(0, 6), new Uint8Array([3]), bytes("Git"), copy(5, 6));
    const first = ofs(base.length, delta(11, 15, instructions));
    const next = ref(oid("blob", "hello Git world"), delta(15, 16, concat(copy(0, 15), new Uint8Array([1, 33]))));
    const result = parseUploadPackResponse(pack([base, first, next]));
    expect(result.size).toBe(3);
    assertObject(result, "blob", "hello world");
    assertObject(result, "blob", "hello Git world");
    assertObject(result, "blob", "hello Git world!");
  });

  it.each(["commit", "tree", "blob", "tag"] as const)("inherits the resolved %s base type for forward ref deltas", (type) => {
    const last = ref(oid(type, "ab"), delta(2, 3, [0x90, 2, 1, 99]));
    const middle = ref(oid(type, "a"), delta(1, 2, [0x90, 1, 1, 98]));
    const result = parseUploadPackResponse(pack([last, middle, object(type, "a")]));
    assertObject(result, type, "abc");
    assertObject(result, type, "ab");
  });

  it("resolves an ofs delta whose earlier ref delta waits for a forward base", () => {
    const first = ref(oid("blob", "a"), delta(1, 2, [0x90, 1, 1, 98]));
    const result = parseUploadPackResponse(pack([first, ofs(first.length, delta(2, 3, [0x90, 2, 1, 99])), object("blob", "a")]));
    assertObject(result, "blob", "abc");
  });

  it("decodes multibyte backward offsets and all copy offset and length fields", () => {
    const data = new Uint8Array(80_000).map((_, index) => index % 251);
    const base = object("blob", data);
    expect(base.length).toBeGreaterThan(127);
    const start = 513;
    const length = 66_051;
    const result = parseUploadPackResponse(pack([base, ofs(base.length, delta(data.length, length, copy(start, length)))]));
    assertObject(result, "blob", data.subarray(start, start + length));
  });

  it("implements Git's zero copy length as 65536 and permits zero-sized results", () => {
    const base = object("blob", new Uint8Array(65_537));
    const result = parseUploadPackResponse(pack([base, ofs(base.length, delta(65_537, 65_536, [128])), ref(oid("blob", new Uint8Array(65_536)), delta(65_536, 0, []))]));
    expect(result.get(oid("blob", new Uint8Array(65_536)))?.data.length).toBe(65_536);
    assertObject(result, "blob", "");
  });

  it("rejects missing ref bases, self references and mutual unresolved cycles", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    expect(() => parseUploadPackResponse(pack([ref(a, delta(1, 1, [0x90, 1]))]))).toThrow("unresolved");
    expect(() => parseUploadPackResponse(pack([ref(b, delta(1, 1, [0x90, 1])), ref(a, delta(1, 1, [0x90, 1]))]))).toThrow("cycle");
    expect(() => parseUploadPackResponse(pack([ref(oid("blob", "x"), delta(1, 1, [1, 120]))]))).toThrow("unresolved");
  });

  it("accepts depth 64 and rejects depth 65 without recursive or exponential resolution", () => {
    const entries = [object("blob", "x")];
    for (let index = 1; index <= 65; index++) {
      entries.push(ref(oid("blob", "x".repeat(index)), delta(index, index + 1, concat(copy(0, index), new Uint8Array([1, 120])))));
    }
    expect(parseUploadPackResponse(pack(entries.slice(0, 65))).size).toBe(65);
    expect(() => parseUploadPackResponse(pack(entries))).toThrow("depth");
    expect(parseUploadPackResponse(pack(entries.slice(0, 65).reverse())).size).toBe(65);
    expect(() => parseUploadPackResponse(pack([...entries].reverse()))).toThrow(/depth|resolution work/);
  });

  it.each([
    [delta(2, 1, [1, 97]), "base size"],
    [delta(1, 1, [0]), "zero delta"],
    [delta(1, 1, [2, 97]), "truncated delta insert"],
    [delta(1, 1, [2, 97, 98]), "overflow"],
    [delta(1, 2, [1, 97]), "output size"],
    [delta(1, 0, [1, 97]), "overflow"],
    [delta(1, 1, [0x90]), "truncated"],
    [delta(1, 1, [0x91, 1, 1]), "outside base"],
    [delta(1, 1, [0x90, 2]), "outside base"],
    [delta(1, 1, [128]), "outside base"],
    [delta(1, 1, [0x88, 255]), "outside base"],
    [delta(1, 1, [1, 97, 0]), "zero delta"],
    [new Uint8Array([]), "truncated"],
    [new Uint8Array([128]), "truncated"],
    [new Uint8Array([129, 0, 1, 1, 97]), "noncanonical"],
    [new Uint8Array([1, 129, 0, 1, 97]), "noncanonical"],
    [new Uint8Array([128, 128, 128, 128, 128, 0]), "varint"],
    [delta(4 * MIB + 1, 0, []), "size"],
    [delta(1, 4 * MIB + 1, []), "size"]
  ])("rejects malformed delta program %#", (program, message) => {
    expect(() => parseUploadPackResponse(pack([object("blob", "a"), ref(oid("blob", "a"), program as Uint8Array)]))).toThrow(message as string);
  });

  it.each([
    new Uint8Array([0]), new Uint8Array([12]), new Uint8Array([127]), new Uint8Array([128]),
    new Uint8Array([255, 255, 255, 255, 255])
  ])("rejects zero, non-object, forward and overflowing ofs offsets %#", (distance) => {
    const base = object("blob", "a");
    const program = delta(1, 1, [1, 98]);
    expect(() => parseUploadPackResponse(pack([base, concat(header(6, program.length), distance, deflateSync(program))]))).toThrow();
  });

  it("rejects truncated ofs offsets and ref oid bytes", () => {
    expect(() => parseUploadPackResponse(pack([concat(header(6, 0), new Uint8Array([128]))]))).toThrow("truncated");
    expect(() => parseUploadPackResponse(pack([concat(header(7, 0), new Uint8Array(19))]))).toThrow("ref delta oid");
  });

  it.each([0, 5])("rejects unsupported packed type %i", (type) => {
    expect(() => parseUploadPackResponse(pack([concat(header(type, 0), deflateSync(bytes("")))]))).toThrow("type");
    expect(inflateSync).not.toHaveBeenCalled();
  });

  it("rejects oversized and noncanonical object headers before invoking inflate", () => {
    for (const value of [concat(header(3, 4 * MIB + 1), bytes("invalid zlib")), new Uint8Array([0xb0, 0]), new Uint8Array([0xb0, 128, 128, 128, 0])]) {
      expect(() => parseUploadPackResponse(pack([value]))).toThrow(/size|varint/);
    }
    expect(inflateSync).not.toHaveBeenCalled();
    expect(() => parseUploadPackResponse(pack([new Uint8Array([0xb0])]))).toThrow("truncated");
  });

  it("checks exact declared inflated lengths and bounds native zlib explosions", () => {
    expect(() => parseUploadPackResponse(pack([object("blob", "a", 2)]))).toThrow("inflated size mismatch");
    expect(() => parseUploadPackResponse(pack([object("blob", "a", 0)]))).toThrow("inflated size mismatch");
    expect(() => parseUploadPackResponse(pack([object("blob", new Uint8Array(4 * MIB + 1), 4 * MIB)]))).toThrow("inflated size cap");
    expect(vi.mocked(inflateSync).mock.calls.at(-1)?.[1]).toEqual({ info: true, maxOutputLength: 4 * MIB });
  });

  it("rejects truncated or corrupt zlib streams even with a valid pack checksum", () => {
    const compressed = deflateSync(bytes("hello"));
    const corrupt = Buffer.from(compressed);
    corrupt[corrupt.length - 1]! ^= 1;
    for (const value of [compressed.subarray(0, -1), compressed.subarray(0, 2), corrupt, bytes("garbage")]) {
      expect(() => parseUploadPackResponse(pack([concat(header(3, 5), value)]))).toThrow("zlib");
    }
  });

  it("rejects extra zlib members rather than folding them into one object", () => {
    expect(() => parseUploadPackResponse(pack([concat(object("blob", "a"), deflateSync(bytes("b")))]))).toThrow("trailing");
  });

  it("validates the checksum before attempting any object inflate", () => {
    const value = pack([object("blob", "hello")]);
    value[value.length - 1]! ^= 1;
    expect(() => parseUploadPackResponse(value)).toThrow("checksum");
    expect(inflateSync).not.toHaveBeenCalled();
  });

  it.each([0, 1, 3])("rejects PACK version %i", (version) => {
    expect(() => parseUploadPackResponse(pack([], 0, version))).toThrow("version");
  });

  it("rejects wrong counts, truncation, trailing bytes and concatenated packs", () => {
    const value = pack([object("blob", "a")]);
    expect(() => parseUploadPackResponse(pack([object("blob", "a")], 0))).toThrow("trailing");
    expect(() => parseUploadPackResponse(pack([object("blob", "a")], 2))).toThrow("truncated");
    for (const length of [0, 3, 4, 11, 20, value.length - 1]) {
      expect(() => parseUploadPackResponse(value.subarray(0, length))).toThrow();
    }
    for (const suffix of [bytes("\0"), bytes("0000"), bytes("\n"), pack([])]) {
      expect(() => parseUploadPackResponse(concat(value, suffix))).toThrow();
    }
    expect(() => parseUploadPackResponse(pack([object("blob", "a"), bytes("\0")]))).toThrow();
  });

  it("rejects duplicate resolved object oids without returning partial results", () => {
    expect(() => parseUploadPackResponse(pack([object("blob", "a"), object("blob", "a")]))).toThrow("duplicate");
    expect(() => parseUploadPackResponse(pack([object("blob", "a"), ref(oid("blob", "a"), delta(1, 1, [0x90, 1]))]))).toThrow("duplicate");
  });

  it("enforces the 16 MiB wire and 50000 object count caps before native inflate", () => {
    expect(() => parseUploadPackResponse(new Uint8Array(16 * MIB + 1))).toThrow("wire size cap");
    expect(() => parseUploadPackResponse(new Uint8Array(16 * MIB))).toThrow("prefix");
    expect(() => parseUploadPackResponse(pack([], 50_001))).toThrow("object count cap");
    expect(() => parseUploadPackResponse(pack([], 50_000))).toThrow("truncated");
    expect(inflateSync).not.toHaveBeenCalled();
  });

  it("accepts exactly 32 MiB inflated and preflights excess aggregate bytes before inflate", () => {
    const entries = Array.from({ length: 8 }, (_, index) => object("blob", new Uint8Array(4 * MIB).fill(index)));
    expect(parseUploadPackResponse(pack(entries)).size).toBe(8);
    vi.mocked(inflateSync).mockClear();
    expect(() => parseUploadPackResponse(pack([...entries, concat(header(3, 1), bytes("invalid zlib"))]))).toThrow("aggregate");
    expect(inflateSync).toHaveBeenCalledTimes(8);
  });

  it("counts delta reconstructed bytes in the aggregate budget", () => {
    const baseData = new Uint8Array(4 * MIB);
    const entries = [object("blob", baseData)];
    let hash = oid("blob", baseData);
    for (let index = 1; index <= 7; index++) {
      const program = delta(baseData.length, baseData.length, concat(copy(0, baseData.length - 1), new Uint8Array([1, index])));
      entries.push(ref(hash, program));
      baseData[baseData.length - 1] = index;
      hash = oid("blob", baseData);
    }
    expect(parseUploadPackResponse(pack(entries.slice(0, 7))).size).toBe(7);
    expect(() => parseUploadPackResponse(pack(entries))).toThrow("aggregate");
  });

  it("honors an already-aborted signal and preserves its reason", () => {
    const controller = new AbortController();
    const reason = new Error("cancel fixture");
    controller.abort(reason);
    expect(() => parseUploadPackResponse(pack([]), controller.signal)).toThrow(reason);
    expect(inflateSync).not.toHaveBeenCalled();
  });

  it("checks cancellation between native object inflates", () => {
    const controller = new AbortController();
    const nativeInflate = vi.mocked(inflateSync).getMockImplementation()!;
    vi.mocked(inflateSync).mockImplementationOnce((...args) => {
      const result = nativeInflate(...args);
      controller.abort(new Error("cancel after inflate"));
      return result;
    });
    expect(() => parseUploadPackResponse(pack([object("blob", "a"), object("blob", "b")]), controller.signal)).toThrow("cancel after inflate");
    expect(inflateSync).toHaveBeenCalledTimes(1);
  });

  it("checks cancellation between delta operations", () => {
    const controller = new AbortController();
    let checks = 0;
    const aborted = vi.spyOn(controller.signal, "aborted", "get").mockImplementation(() => ++checks >= 12);
    const program = delta(1, 5, [1, 98, 1, 99, 1, 100, 1, 101, 1, 102]);
    expect(() => parseUploadPackResponse(pack([object("blob", "a"), ref(oid("blob", "a"), program)]), controller.signal)).toThrow("aborted");
    expect(checks).toBe(12);
    aborted.mockRestore();
  });
});
