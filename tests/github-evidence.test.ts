import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRepoEvidence, resolveRepoAuthority, resolveRepoEvidence, RetryableGithubError, zeroResultForAssessment } from "../src/container/github";
import { MAX_EVIDENCE_FILES, MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_TOTAL_BYTES, MAX_SNAPSHOT_SERIALIZED_BYTES } from "../src/shared/constants";
import type { NormalizedRepo } from "../src/shared/types";

const repo: NormalizedRepo = { owner: "demo", repo: "project", normalized: "demo/project", canonicalUrl: "https://github.com/demo/project" };
const otherSha = "b".repeat(40);
const refsUrl = "https://github.com/demo/project.git/info/refs?service=git-upload-pack";
const uploadUrl = "https://github.com/demo/project.git/git-upload-pack";
const encoder = new TextEncoder();
const provenance = "固定コミットのGit追跡ソース全文を評価。";
const capabilities = "filter shallow ofs-delta no-progress";
type ObjectType = "commit" | "tree" | "blob" | "tag";
type ObjectFixture = { oid: string; type: ObjectType; data: Buffer };
type Entry = { path: string; content: string | Uint8Array; mode?: string };
type Fixture = { sha: string; commit: ObjectFixture; trees: ObjectFixture[]; blobs: Map<string, ObjectFixture>; paths: Map<string, string> };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function pkt(value: string): string {
  return (encoder.encode(value).length + 4).toString(16).padStart(4, "0") + value;
}

function advertisement(sha: string, options: { branch?: string; head?: string; refSha?: string; capabilities?: string; first?: string; service?: string; end?: string } = {}): string {
  const branch = options.branch ?? "main";
  return pkt(options.service ?? "# service=git-upload-pack\n") + "0000"
    + pkt(options.first ?? `${options.head ?? sha} HEAD\0${options.capabilities ?? `${capabilities} symref=HEAD:refs/heads/${branch} agent=git/2.0`}\n`)
    + pkt(`${options.refSha ?? sha} refs/heads/${branch}\n`) + (options.end ?? "0000");
}

function emptyAdvertisement(): string {
  return pkt("# service=git-upload-pack\n") + "0000" + pkt(`${"0".repeat(40)} capabilities^{}\0${capabilities} agent=git/2.0\n`) + "0000";
}

function canonical(response: Response, url: string, redirected = false): Response {
  Object.defineProperty(response, "url", { value: url, configurable: true });
  Object.defineProperty(response, "redirected", { value: redirected, configurable: true });
  return response;
}

function refsResponse(body: BodyInit, init: ResponseInit = {}): Response {
  return canonical(new Response(body, { ...init, headers: { "content-type": "application/x-git-upload-pack-advertisement", ...init.headers } }), refsUrl);
}

function object(type: ObjectType, value: string | Uint8Array): ObjectFixture {
  const data = Buffer.from(value);
  const oid = createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
  return { oid, type, data };
}

function tree(entries: { mode: string; name: string | Uint8Array; oid: string }[]): ObjectFixture {
  return object("tree", Buffer.concat(entries.map((entry) => Buffer.concat([Buffer.from(`${entry.mode} `), Buffer.from(entry.name), Buffer.from([0]), Buffer.from(entry.oid, "hex")]))));
}

function atRoot(root: ObjectFixture, trees: ObjectFixture[] = [root], blobs: ObjectFixture[] = []): Fixture {
  const commit = object("commit", `tree ${root.oid}\nauthor Test <test@example.test> 1 +0000\ncommitter Test <test@example.test> 1 +0000\n\nfixture\n`);
  return { sha: commit.oid, commit, trees, blobs: new Map(blobs.map((blob) => [blob.oid, blob])), paths: new Map() };
}

function fixture(entries: Entry[] = [{ path: "src/main.ts", content: "tracked source" }]): Fixture {
  type Directory = Map<string, Directory | { oid: string; mode: string }>;
  const root: Directory = new Map();
  const blobs = new Map<string, ObjectFixture>();
  const paths = new Map<string, string>();
  for (const entry of entries) {
    const blob = object("blob", entry.content);
    blobs.set(blob.oid, blob);
    paths.set(entry.path, blob.oid);
    const parts = entry.path.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      if (!directory.has(part)) directory.set(part, new Map());
      directory = directory.get(part) as Directory;
    }
    directory.set(parts[parts.length - 1]!, { oid: blob.oid, mode: entry.mode ?? "100644" });
  }
  const trees = new Map<string, ObjectFixture>();
  const build = (directory: Directory): ObjectFixture => {
    const entries = [...directory].map(([name, value]) => value instanceof Map
      ? { name, mode: "40000", oid: build(value).oid }
      : { name, ...value });
    const result = tree(entries);
    trees.set(result.oid, result);
    return result;
  };
  return { ...atRoot(build(root), [...trees.values()], [...blobs.values()]), paths };
}

function pack(objects: ObjectFixture[]): Buffer {
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const types = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const entries = objects.map((entry) => {
    let remaining = Math.floor(entry.data.length / 16);
    const bytes = [(types[entry.type] << 4) | (entry.data.length & 15) | (remaining ? 128 : 0)];
    while (remaining) {
      const byte = remaining & 127;
      remaining = Math.floor(remaining / 128);
      bytes.push(byte | (remaining ? 128 : 0));
    }
    return Buffer.concat([Buffer.from(bytes), deflateSync(entry.data)]);
  });
  const bytes = Buffer.concat([header, ...entries]);
  return Buffer.concat([bytes, createHash("sha1").update(bytes).digest()]);
}

function packResponse(objects: ObjectFixture[], prefix = pkt("NAK\n"), init: ResponseInit = {}): Response {
  return canonical(new Response(Buffer.concat([Buffer.from(prefix), pack(objects)]), {
    ...init, headers: { "content-type": "application/x-git-upload-pack-result", ...init.headers }
  }), uploadUrl);
}

function requestPackets(init?: RequestInit): string[] {
  const bytes = Buffer.from(init?.body as Uint8Array);
  const result: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = Number.parseInt(bytes.subarray(offset, offset + 4).toString("ascii"), 16);
    offset += 4;
    if (length === 0) result.push("FLUSH");
    else {
      expect(length).toBeGreaterThanOrEqual(4);
      result.push(bytes.subarray(offset, offset + length - 4).toString("utf8"));
      offset += length - 4;
    }
  }
  expect(offset).toBe(bytes.length);
  return result;
}

function stubGithub(data: Fixture = fixture(), options: {
  refs?: Response | (() => Response);
  initial?: Response | (() => Response);
  blobs?: (wants: string[]) => Response;
} = {}) {
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    expect(init).toMatchObject({ redirect: "manual", credentials: "omit", signal: expect.any(AbortSignal) });
    if (url === refsUrl) return typeof options.refs === "function" ? options.refs() : options.refs ?? refsResponse(advertisement(data.sha));
    if (url !== uploadUrl) throw new Error(`Unexpected test request: ${url}`);
    const packets = requestPackets(init);
    if (packets.includes("filter blob:none\n")) {
      return typeof options.initial === "function" ? options.initial() : options.initial ?? packResponse([data.commit, ...data.trees], pkt(`shallow ${data.sha}`) + "0000" + pkt("NAK\n"));
    }
    const wants = packets.filter((line) => line.startsWith("want ")).map((line) => line.slice(5, 45));
    return options.blobs?.(wants) ?? packResponse(wants.flatMap((oid) => data.blobs.has(oid) ? [data.blobs.get(oid)!] : []));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function blobWants(fetch: ReturnType<typeof stubGithub>): string[] {
  return fetch.mock.calls.filter(([url, init]) => String(url) === uploadUrl && !requestPackets(init).includes("filter blob:none\n"))
    .flatMap(([, init]) => requestPackets(init).filter((line) => line.startsWith("want ")).map((line) => line.slice(5, 45)));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("GitHub public authority", () => {
  it("freezes authority with a single bounded unauthenticated public GET", async () => {
    const data = fixture();
    const fetch = stubGithub(data);
    expect(await resolveRepoAuthority(repo, "summary")).toEqual({ assessment: "scored", pinnedSha: data.sha, defaultBranch: "main", summary: "summary" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([refsUrl]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", headers: { accept: "application/x-git-upload-pack-advertisement" } });
  });

  it.each([401, 403, 404])("keeps refs status %i missing/private and cancels its body", async (status) => {
    const cancels: ReturnType<typeof vi.fn>[] = [];
    const data = fixture();
    const fetch = stubGithub(data, { refs: () => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return refsResponse(new ReadableStream({ cancel }), { status });
    } });
    expect(await resolveRepoAuthority(repo, "summary")).toMatchObject({ assessment: "missing_or_private", pinnedSha: null });
    expect(await resolveRepoEvidence(repo, "summary")).toMatchObject({ assessment: "missing_or_private", files: [] });
    expect(await fetchRepoEvidence(repo, data.sha, "main", "summary")).toMatchObject({ assessment: "missing_or_private", files: [] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
  });

  it.each([429, 500, 503])("makes refs status %i retryable without upstream text or headers", async (status) => {
    stubGithub(fixture(), { refs: refsResponse("secret body", { status, headers: { "retry-after": "secret".repeat(1000) } }) });
    await expect(resolveRepoAuthority(repo, "summary")).rejects.toThrow(`GitHub public refs failed with status ${status}`);
  });

  it("rejects malformed advertisements instead of guessing public authority", async () => {
    const data = fixture();
    const valid = advertisement(data.sha);
    const malformed = [
      "zzzz" + valid.slice(4), "0003" + valid.slice(4), advertisement(data.sha, { service: "# service=other\n" }),
      pkt("# service=git-upload-pack\n") + pkt(`${data.sha} HEAD\0${capabilities}\n`) + "0000",
      advertisement(data.sha, { end: "" }), valid + "junk", advertisement(data.sha, { head: "g".repeat(40) }),
      advertisement(data.sha, { head: "0".repeat(40) }), advertisement(data.sha, { refSha: otherSha }), valid.slice(0, -8),
      advertisement(data.sha, { capabilities: `${capabilities}  agent=git/2.0` }),
      advertisement(data.sha, { capabilities: `${capabilities} filter` }),
      ...["symref=HEAD:refs/heads/other", "symref=HEAD:refs/tags/main", "symref=HEAD:refs/heads/../main"].map((value) => advertisement(data.sha, { capabilities: `${capabilities} ${value}` })),
      valid.slice(0, -4) + pkt(`${data.sha} refs/heads/main\n`) + "0000",
      valid.slice(0, -4) + pkt(`${data.sha} refs/heads/../unsafe\n`) + "0000"
    ];
    for (const body of malformed) {
      const fetch = stubGithub(data, { refs: refsResponse(body) });
      await expect(resolveRepoAuthority(repo, "summary")).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const bytes = encoder.encode(valid);
    bytes[12] = 0xff;
    stubGithub(data, { refs: refsResponse(bytes) });
    await expect(resolveRepoAuthority(repo, "summary")).rejects.toThrow();
  });

  it("keeps genuine empty and no-default-branch classifications refs-only", async () => {
    const data = fixture();
    for (const [body, assessment] of [[emptyAdvertisement(), "empty_repository"], [advertisement(data.sha, { capabilities }), "no_default_branch"]]) {
      const fetch = stubGithub(data, { refs: () => refsResponse(body!) });
      expect(await resolveRepoAuthority(repo, "summary")).toMatchObject({ assessment, pinnedSha: null });
      expect(await resolveRepoEvidence(repo, "summary")).toMatchObject({ assessment, pinnedSha: null, files: [] });
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([refsUrl, refsUrl]);
    }
  });

  it("enforces 256KB stated and streamed refs limits and exact content length", async () => {
    const data = fixture();
    for (const response of [
      refsResponse(advertisement(data.sha), { headers: { "content-length": "256001" } }),
      refsResponse(advertisement(data.sha) + "x".repeat(256_000)),
      refsResponse(advertisement(data.sha), { headers: { "content-length": "1" } }),
      refsResponse(advertisement(data.sha), { headers: { "content-length": "NaN" } })
    ]) {
      stubGithub(data, { refs: response });
      await expect(resolveRepoAuthority(repo, "summary")).rejects.toThrow(/exceeds|content length/);
    }
  });

  it("rejects redirects, changed response identity, non-200 and wrong refs MIME", async () => {
    const data = fixture();
    for (const response of [
      ...[301, 302, 303, 307, 308].map((status) => new Response(null, { status, headers: { location: uploadUrl } })),
      canonical(refsResponse(advertisement(data.sha)), refsUrl, true),
      canonical(refsResponse(advertisement(data.sha)), "https://github.com/other/project.git/info/refs?service=git-upload-pack"),
      refsResponse("html", { headers: { "content-type": "text/html" } }), refsResponse("", { status: 201 })
    ]) {
      const fetch = stubGithub(data, { refs: response });
      await expect(resolveRepoAuthority(repo, "summary")).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("validates canonical repo and frozen authority before requesting anything", async () => {
    const data = fixture();
    const fetch = stubGithub(data);
    for (const invalid of [{ ...repo, normalized: "other/repo" }, { ...repo, canonicalUrl: "https://github.com/other/repo" }, { ...repo, owner: ".." }, { ...repo, repo: "../project" }]) {
      await expect(resolveRepoAuthority(invalid, "summary")).rejects.toThrow(/canonical/);
      await expect(resolveRepoEvidence(invalid, "summary")).rejects.toThrow(/canonical/);
      await expect(fetchRepoEvidence(invalid, data.sha, "main", "summary")).rejects.toThrow(/canonical/);
    }
    await expect(fetchRepoEvidence(repo, "wrong", "main", "summary")).rejects.toThrow(/authority/);
    await expect(fetchRepoEvidence(repo, data.sha, "../main", "summary")).rejects.toThrow(/authority/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GitHub partial-clone tracked evidence", () => {
  it("uses only canonical v0 GET/POST with shallow blob:none then exact blob wants", async () => {
    const data = fixture([{ path: "src/日本語.ts", content: "あいう\n" }]);
    const fetch = stubGithub(data);
    expect(await resolveRepoEvidence(repo, "summary")).toEqual({
      repo, pinnedSha: data.sha, defaultBranch: "main", assessment: "scored", summary: `summary ${provenance}`, fullSource: true,
      files: [{ path: "src/日本語.ts", content: "あいう\n", size: 10, truncated: false }]
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([refsUrl, uploadUrl, uploadUrl]);
    expect(requestPackets(fetch.mock.calls[1]?.[1])).toEqual([`want ${data.sha} no-progress ofs-delta filter\n`, "deepen 1\n", "filter blob:none\n", "FLUSH", "done\n"]);
    expect(requestPackets(fetch.mock.calls[2]?.[1])).toEqual([`want ${data.paths.get("src/日本語.ts")} no-progress ofs-delta\n`, "FLUSH", "done\n"]);
    const signals = fetch.mock.calls.map(([, init]) => init?.signal);
    expect(new Set(signals).size).toBe(1);
    for (const [url, init] of fetch.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("git-protocol")).toBe(false);
      if (url === uploadUrl) {
        expect(init?.method).toBe("POST");
        expect(headers.get("content-type")).toBe("application/x-git-upload-pack-request");
        expect(headers.get("accept")).toBe("application/x-git-upload-pack-result");
        expect(Buffer.from(init?.body as Uint8Array).toString()).not.toMatch(/side-band|thin-pack/);
      }
    }
  });

  it("rejects unsupported partial-clone capabilities before any POST", async () => {
    const data = fixture();
    for (const missing of ["filter", "shallow", "ofs-delta", "no-progress"]) {
      const caps = capabilities.split(" ").filter((value) => value !== missing).join(" ");
      const fetch = stubGithub(data, { refs: refsResponse(advertisement(data.sha, { capabilities: `${caps} symref=HEAD:refs/heads/main` })) });
      await expect(fetchRepoEvidence(repo, data.sha, "main", "summary")).rejects.toThrow(/capabilities/);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("never replaces historical frozen SHA or branch with current refs", async () => {
    const data = fixture();
    let reads = 0;
    const fetch = stubGithub(data, { refs: () => refsResponse(advertisement(reads++ === 0 ? data.sha : otherSha, { branch: reads === 1 ? "main" : "later" })) });
    const authority = await resolveRepoAuthority(repo, "frozen");
    const first = await fetchRepoEvidence(repo, authority.pinnedSha!, authority.defaultBranch!, authority.summary);
    const second = await fetchRepoEvidence(repo, authority.pinnedSha!, authority.defaultBranch!, authority.summary);
    expect(first).toMatchObject({ pinnedSha: data.sha, defaultBranch: "main", summary: `frozen ${provenance}` });
    expect(second).toEqual(first);
    const initialWants = fetch.mock.calls.filter(([, init]) => init?.method === "POST" && requestPackets(init).includes("filter blob:none\n"));
    expect(initialWants).toHaveLength(2);
    expect(initialWants.every(([, init]) => requestPackets(init)[0]?.startsWith(`want ${data.sha} `))).toBe(true);
  });

  it("reads pinned historical objects even when current public refs are empty or lack a default branch", async () => {
    const data = fixture();
    for (const body of [emptyAdvertisement(), advertisement(otherSha, { capabilities })]) {
      stubGithub(data, { refs: refsResponse(body) });
      expect(await fetchRepoEvidence(repo, data.sha, "historical", "frozen")).toMatchObject({ assessment: "scored", pinnedSha: data.sha, defaultBranch: "historical" });
    }
  });

  it("keeps more than 24 files, 12KB per file, 120KB total and exact UTF-8 content", async () => {
    const entries = Array.from({ length: 31 }, (_, i) => ({ path: `src/file-${i}.unknown`, content: `${i}:` + "あ".repeat(5000) }));
    const data = fixture(entries);
    const fetch = stubGithub(data);
    const result = await fetchRepoEvidence(repo, data.sha, "main", "summary");
    expect(result.files).toHaveLength(31);
    expect(result.files.reduce((sum, file) => sum + file.size, 0)).toBeGreaterThan(120_000);
    for (const entry of entries) expect(result.files.find((file) => file.path === entry.path)).toEqual({ ...entry, size: Buffer.byteLength(entry.content), truncated: false });
    expect(blobWants(fetch)).toHaveLength(31);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1 + Math.ceil(31 / 64));
  });

  it("includes unknown, extensionless, docs, tests, config and original tracked policy files without executing or applying them", async () => {
    const entries = [
      { path: "README.md", content: "readme" }, { path: "docs/guide.rst", content: "guide" },
      { path: "tests/main.spec.ts", content: "throw new Error('do not execute')" }, { path: "config/example.ini", content: "setting=true" },
      { path: "src/code.unrecognized", content: "$Format:%H$\nexport-ignore source" }, { path: "LICENSE", content: "license" },
      { path: ".gitignore", content: "src/\ndocs/\ntests/\nconfig/\n" },
      { path: ".gitattributes", content: "src/* export-ignore\nsrc/* export-subst\n" },
      { path: "repomix.config.json", content: '{"ignore":{"customPatterns":["**/*"]},"output":{"filePath":"stolen"}}' },
      { path: ".gitmodules", content: '[submodule "external"]\nurl = https://attacker.example/submodule' },
      { path: "src/generated-name.ts", content: "tracked source" }, { path: "src/app.min.js", content: "tracked minified source" },
      { path: "src/credentials.ts", content: "export const readCredential = () => process.env.APP_KEY" },
      { path: "src/secrets.py", content: "def read_secret(): return None" },
      { path: "src/bom", content: "\ufefforiginal BOM" }
    ];
    const data = fixture(entries);
    const fetch = stubGithub(data);
    const result = await fetchRepoEvidence(repo, data.sha, "main", "summary");
    expect(result.files).toHaveLength(entries.length);
    for (const entry of entries) expect(result.files.find((file) => file.path === entry.path)).toEqual({ ...entry, size: Buffer.byteLength(entry.content), truncated: false });
    expect(fetch.mock.calls.every(([url]) => url === refsUrl || url === uploadUrl)).toBe(true);
  });

  it("never wants fixed secret, dependency, build, lock or known binary objects", async () => {
    const excluded = [
      "node_modules/lib.ts", "vendor/lib.py", ".venv/lib.py", "venv/lib.py", "site-packages/lib.py", "dist/app.js", "build/app.js", "target/app.rs",
      "coverage/app.ts", ".git/config", ".next/app.js", ".nuxt/app.js", "generated/app.ts", "__generated__/app.ts", "cache/app.ts", ".cache/app.ts",
      "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "uv.lock", "poetry.lock",
      ".env", ".env.production", ".env.example", "src/.env.local", "id_rsa", "id_ed25519.pub", "tls/private.key", "certificate.pem", "cert.crt",
      "credentials.json", "aws-credentials", "service-account.json", "secrets.yaml", ".npmrc", ".netrc", ".aws/config",
      "image.png", "image.avif", "font.woff2", "sound.flac", "movie.webm", "archive.zip", "lib.wasm", "app.exe", "lib.so", "asset.pdf", "classes.jar"
    ];
    const data = fixture([{ path: "src/main.ts", content: "allowed" }, ...excluded.map((path) => ({ path, content: `excluded:${path}` }))]);
    const fetch = stubGithub(data);
    expect((await fetchRepoEvidence(repo, data.sha, "main", "summary")).files).toEqual([{ path: "src/main.ts", content: "allowed", size: 7, truncated: false }]);
    expect(blobWants(fetch)).toEqual([data.paths.get("src/main.ts")]);
    expect(excluded.every((path) => !blobWants(fetch).includes(data.paths.get(path)!))).toBe(true);
  });

  it("never wants excluded media, models or generated source maps even when every blob is unique UTF-8 XML", async () => {
    const excluded = [
      "assets/lower.svg", "assets/upper.SVG", "assets/mixed.SvG", "assets/lower.svgz", "assets/upper.SVGZ", "assets/mixed.SvGz",
      "assets/image.PNG", "assets/photo.JPEG", "assets/image.WEBP", "assets/font.WOFF2", "assets/font.TTF",
      "assets/audio.MP3", "assets/audio.WAV", "assets/video.MP4", "assets/video.WEBM", "assets/archive.ZIP", "assets/archive.GZ",
      "assets/model.GlTf", "assets/model.GLB", "assets/model.OBJ", "assets/model.USDZ", "models/model.ONNX",
      "models/weights.SafeTensors", "models/model.GGUF", "models/model.CKPT", "src/app.JS.MAP", "assets/theme.CSS.MAP"
    ];
    const source = { path: "src/main.ts", content: "export const title = '雪';\n" };
    const data = fixture([
      ...excluded.map((path) => ({ path, content: `<svg xmlns="http://www.w3.org/2000/svg"><text>${path} 雪</text></svg>\n` })),
      source
    ]);
    const fetch = stubGithub(data);
    const result = await fetchRepoEvidence(repo, data.sha, "main", "summary");
    expect(result.files).toEqual([{ ...source, size: Buffer.byteLength(source.content), truncated: false }]);
    const wants = blobWants(fetch);
    expect(wants).toEqual([data.paths.get(source.path)]);
    expect(new Set(excluded.map((path) => data.paths.get(path))).size).toBe(excluded.length);
    for (const path of excluded) expect(wants).not.toContain(data.paths.get(path));
  });

  it("retains source without a capacity error or blob request for an oversized UTF-8 SVG", async () => {
    const svg = {
      path: "assets/oversized.SvG",
      content: `<svg xmlns="http://www.w3.org/2000/svg"><text>${"雪".repeat(MAX_EVIDENCE_FILE_BYTES)}</text></svg>\n`
    };
    const source = { path: "src/main.ts", content: "export const answer = 42;\n" };
    expect(Buffer.byteLength(svg.content)).toBeGreaterThan(MAX_EVIDENCE_FILE_BYTES);
    const data = fixture([svg, source]);
    const fetch = stubGithub(data);
    const result = await fetchRepoEvidence(repo, data.sha, "main", "summary");
    expect(result).toMatchObject({ assessment: "scored", fullSource: true });
    expect(result.files).toEqual([{ ...source, size: Buffer.byteLength(source.content), truncated: false }]);
    expect(blobWants(fetch)).toEqual([data.paths.get(source.path)]);
    expect(blobWants(fetch)).not.toContain(data.paths.get(svg.path));
  });

  it("retains exact implementation and unknown UTF-8 text referencing excluded assets", async () => {
    const entries = [
      { path: "public/index.html", content: '<!doctype html>\n<html lang="ja"><body><img src="/assets/logo.SVG" alt="雪"><video src="/assets/intro.MP4" poster="/assets/hero.PNG"></video></body></html>\n' },
      { path: "assets/theme.css", content: '@font-face { font-family: "Demo"; src: url("./demo.WOFF2") format("woff2"); }\r\n.hero { background-image: url("./pattern.svgz"), url("./hero.PNG"); }\r\n' },
      { path: "src/App.tsx", content: 'import logo from "../assets/logo.SVG";\nexport const App = () => <img src={logo} alt="雪" />;\n' },
      { path: "src/Icon.tsx", content: 'export const Icon = () => <svg viewBox="0 0 8 8"><path d="M0 0L8 8" /></svg>;\n' },
      { path: "src/Preview.jsx", content: 'import hero from "../assets/hero.PNG";\nexport const Preview = () => <img src={hero} alt="写真" />;\n' },
      { path: "src/Player.vue", content: '<script setup>\r\nimport clip from "../assets/intro.MP4";\r\n</script>\r\n<template><video :src="clip" poster="/assets/hero.PNG"></video></template>\r\n' },
      { path: "assets/copy.unrecognized", content: '\ufefftitle=雪\r\nimage=./hero.PNG\r\nicon=./logo.SVG\r\n' },
      { path: "assets/shaders/basic.glsl", content: 'void main() { gl_FragColor = vec4(1.0); }\n' },
      { path: "assets/routes.map", content: 'north=東京\nsouth=大阪\n' },
      { path: "templates/page.pt", content: '<html><body tal:content="context/title">Title</body></html>\n' },
      { path: "config/runtime.pth", content: 'import application_startup\n../application\n' }
    ];
    const assets = [
      { path: "assets/logo.SVG", content: '<svg xmlns="http://www.w3.org/2000/svg"><text>logo</text></svg>\n' },
      { path: "assets/pattern.svgz", content: '<svg xmlns="http://www.w3.org/2000/svg"><text>pattern</text></svg>\n' },
      { path: "assets/hero.PNG", content: "unique image fixture" },
      { path: "assets/demo.WOFF2", content: "unique font fixture" },
      { path: "assets/intro.MP4", content: "unique video fixture" }
    ];
    const data = fixture([...entries, ...assets]);
    const fetch = stubGithub(data);
    const result = await fetchRepoEvidence(repo, data.sha, "main", "summary");
    expect(result.files).toHaveLength(entries.length);
    for (const entry of entries) {
      const file = result.files.find((candidate) => candidate.path === entry.path);
      expect(file).toEqual({ ...entry, size: Buffer.byteLength(entry.content), truncated: false });
      expect(Buffer.from(file!.content)).toEqual(Buffer.from(entry.content));
    }
    const wants = blobWants(fetch);
    expect(wants).toHaveLength(entries.length);
    expect(new Set(wants)).toEqual(new Set(entries.map((entry) => data.paths.get(entry.path))));
    for (const asset of assets) expect(wants).not.toContain(data.paths.get(asset.path));
  });

  it("classifies NUL and malformed UTF-8 as binary without partial decoding", async () => {
    const data = fixture([
      { path: "unknown-format", content: "text\0binary" }, { path: "another.unknown", content: new Uint8Array([0x61, 0xc3, 0x28]) },
      { path: "src/readable.ts", content: "source" }, { path: "empty", content: "" }
    ]);
    stubGithub(data);
    expect((await fetchRepoEvidence(repo, data.sha, "main", "summary")).files).toEqual([
      { path: "empty", content: "", size: 0, truncated: false },
      { path: "src/readable.ts", content: "source", size: 6, truncated: false }
    ]);
  });

  it.each(["files", "file bytes", "total bytes", "serialized bytes"])("rejects all evidence beyond shared %s capacity without returning a prefix", async (kind) => {
    const entries = kind === "files" ? Array.from({ length: MAX_EVIDENCE_FILES + 1 }, (_, i) => ({ path: `source-${i}`, content: "same" }))
      : kind === "file bytes" ? [{ path: "source", content: "x".repeat(MAX_EVIDENCE_FILE_BYTES + 1) }]
      : kind === "total bytes" ? [{ path: "one", content: "a".repeat(Math.floor(MAX_EVIDENCE_TOTAL_BYTES / 2) + 1) }, { path: "two", content: "b".repeat(Math.floor(MAX_EVIDENCE_TOTAL_BYTES / 2) + 1) }]
      : [{ path: "escaped", content: "\u0001".repeat(Math.ceil(MAX_SNAPSHOT_SERIALIZED_BYTES / 6)) }];
    const data = fixture(entries);
    stubGithub(data);
    await expect(fetchRepoEvidence(repo, data.sha, "main", "summary")).rejects.toThrow(/capacity/);
  });

  it("accepts exact shared file-count and file-byte boundaries without truncation", async () => {
    for (const entries of [
      Array.from({ length: MAX_EVIDENCE_FILES }, (_, i) => ({ path: `source-${i}`, content: `source-${i}` })),
      [{ path: "source", content: "あ".repeat(Math.floor(MAX_EVIDENCE_FILE_BYTES / 3)) }]
    ]) {
      const data = fixture(entries);
      const fetch = stubGithub(data);
      const result = await fetchRepoEvidence(repo, data.sha, "main", "summary");
      expect(result.files).toHaveLength(entries.length);
      expect(result.files.every((file) => !file.truncated && file.size === Buffer.byteLength(file.content))).toBe(true);
      expect(fetch.mock.calls.length).toBeLessThanOrEqual(34);
    }
  });

  it("allows the same tree in multiple directories and deduplicates blob wants", async () => {
    const data = fixture([{ path: "one/file", content: "same" }, { path: "two/file", content: "same" }]);
    expect(data.trees).toHaveLength(2);
    const fetch = stubGithub(data);
    expect((await fetchRepoEvidence(repo, data.sha, "main", "summary")).files.map((file) => file.path)).toEqual(["one/file", "two/file"]);
    expect(blobWants(fetch)).toEqual([data.paths.get("one/file")]);
  });

  it("does not follow symlinks, executable content or gitlinks", async () => {
    const data = fixture([
      { path: "symlink", content: "https://attacker.example/source", mode: "120000" },
      { path: "submodule", content: "external repository", mode: "160000" },
      { path: "script", content: "exit 42", mode: "100755" }
    ]);
    const fetch = stubGithub(data);
    expect((await fetchRepoEvidence(repo, data.sha, "main", "summary")).files).toEqual([{ path: "script", content: "exit 42", size: 7, truncated: false }]);
    expect(blobWants(fetch)).toEqual([data.paths.get("script")]);
  });

  it("returns zero only for a genuine empty root tree", async () => {
    const data = fixture([]);
    const fetch = stubGithub(data);
    const snapshot = await fetchRepoEvidence(repo, data.sha, "main", "summary");
    expect(snapshot).toMatchObject({ assessment: "empty_repository", pinnedSha: data.sha, files: [], summary: expect.stringContaining(provenance) });
    expect(zeroResultForAssessment(snapshot)).toMatchObject({ total: 0, pinnedSha: data.sha });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { path: "binary", content: "x\0y" }, { path: "invalid", content: new Uint8Array([0xff]) },
    { path: "image.png", content: "binary" }, { path: "vendor/main.ts", content: "excluded" },
    { path: "link", content: "../external", mode: "120000" }, { path: "module", content: "external", mode: "160000" }
  ])("fails nonempty unjudgeable material rather than zero: $path", async (entry) => {
    const data = fixture([entry]);
    stubGithub(data);
    await expect(fetchRepoEvidence(repo, data.sha, "main", "summary")).rejects.toThrow(/no readable source evidence/);
  });

  it("preserves an empty tracked text file without labeling its tree empty", async () => {
    const data = fixture([{ path: "empty", content: "" }]);
    stubGithub(data);
    expect(await fetchRepoEvidence(repo, data.sha, "main", "summary")).toMatchObject({
      assessment: "scored", fullSource: true, files: [{ path: "empty", content: "", size: 0, truncated: false }]
    });
  });

  it("rejects missing/wrong pinned commits, missing trees and initial blobs or unrelated objects", async () => {
    const data = fixture();
    const wrongCommit = object("commit", `tree ${data.trees[0]!.oid}\n\nwrong commit\n`);
    const unrelated = tree([{ mode: "100644", name: "extra", oid: otherSha }]);
    for (const objects of [
      data.trees, [wrongCommit, ...data.trees], [data.commit], [data.commit, ...data.trees.slice(1)],
      [data.commit, ...data.trees, ...data.blobs.values()], [data.commit, ...data.trees, unrelated],
      [data.commit, ...data.trees, object("tag", "unrelated tag")]
    ]) {
      const fetch = stubGithub(data, { initial: packResponse(objects) });
      await expect(fetchRepoEvidence(repo, data.sha, "main", "summary")).rejects.toThrow(/commit|tree|blobs|unreachable/);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    const blob = object("blob", "not a commit");
    const invalid = { ...data, sha: blob.oid };
    stubGithub(invalid, { initial: packResponse([blob]) });
    await expect(fetchRepoEvidence(repo, blob.oid, "main", "summary")).rejects.toThrow(/commit/);
  });

  it("rejects missing blobs, wrong OIDs/types and extra substantive objects", async () => {
    const data = fixture();
    for (const objects of [[], [object("blob", "different")], [...data.blobs.values(), object("blob", "extra")], [...data.blobs.values(), data.commit]]) {
      stubGithub(data, { blobs: () => packResponse(objects) });
      await expect(fetchRepoEvidence(repo, data.sha, "main", "summary")).rejects.toThrow(/blob/);
    }
    const wrongType = tree([]);
    const root = tree([{ mode: "100644", name: "pretend-blob", oid: wrongType.oid }]);
    const invalid = atRoot(root);
    stubGithub(invalid, { blobs: () => packResponse([wrongType]) });
    await expect(fetchRepoEvidence(repo, invalid.sha, "main", "summary")).rejects.toThrow(/blob/);
  });

  it("rejects unsafe, duplicate, malformed UTF-8, unsupported-mode and overlong tree paths", async () => {
    const blob = object("blob", "source");
    const badRoots = [
      ...["", ".", "..", "/absolute", "a/b", "a\\b", "C:drive", "line\nbreak", "control\u007f", "nul", "trailing.", "x".repeat(1025), "あ".repeat(342)].map((name) => tree([{ name, mode: "100644", oid: blob.oid }])),
      tree([{ name: new Uint8Array([0xff]), mode: "100644", oid: blob.oid }]),
      tree([{ name: "file", mode: "100600", oid: blob.oid }]),
      tree([{ name: "duplicate", mode: "100644", oid: blob.oid }, { name: "duplicate", mode: "100644", oid: blob.oid }]),
      object("tree", "100644 unterminated"), object("tree", "100644 file\0short")
    ];
    for (const root of badRoots) {
      const data = atRoot(root, [root], [blob]);
      const fetch = stubGithub(data);
      await expect(fetchRepoEvidence(repo, data.sha, "main", "summary")).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("bounds tree depth and all entries including excluded material", async () => {
    const deep = fixture([{ path: `${"dir/".repeat(65)}file`, content: "source" }]);
    stubGithub(deep);
    await expect(fetchRepoEvidence(repo, deep.sha, "main", "summary")).rejects.toThrow(/depth/);
    const blob = object("blob", "excluded");
    const root = tree(Array.from({ length: 50_001 }, (_, i) => ({ name: `file-${i}.png`, mode: "100644", oid: blob.oid })));
    const data = atRoot(root);
    stubGithub(data);
    await expect(fetchRepoEvidence(repo, data.sha, "main", "summary")).rejects.toThrow(/entry capacity/);
  });
});

describe("GitHub upload HTTP bounds and deadlines", () => {
  it.each([403, 429, 500, 503])("makes upload status %i safely retryable and cancels error bodies", async (status) => {
    const data = fixture();
    const cancel = vi.fn();
    const fetch = stubGithub(data, { initial: new Response(new ReadableStream({ cancel }), { status, headers: { "retry-after": "secret".repeat(1000) } }) });
    const error = await fetchRepoEvidence(repo, data.sha, "main", "summary").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(RetryableGithubError);
    expect((error as Error).message).toBe(`GitHub upload-pack failed with status ${status}`);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([201, 204, 206, 400, 401, 404, 409, 422])("fails unavailable/protocol upload status %i without zero evidence", async (status) => {
    const data = fixture();
    stubGithub(data, { initial: new Response(null, { status }) });
    const error = await fetchRepoEvidence(repo, data.sha, "main", "summary").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RetryableGithubError);
    expect((error as Error).message).toBe(`Pinned GitHub upload-pack failed with status ${status}`);
  });

  it("rejects every redirect and response identity change at both POST stages", async () => {
    const data = fixture();
    for (const stage of ["initial", "blobs"] as const) {
      for (const response of [
        ...[300, 301, 302, 303, 304, 307, 308].map((status) => new Response(null, { status, headers: { location: "https://attacker.example/source" } })),
        canonical(packResponse([]), uploadUrl, true), canonical(packResponse([]), "https://github.com/other/project.git/git-upload-pack")
      ]) {
        const fetch = stubGithub(data, stage === "initial" ? { initial: response } : { blobs: () => response });
        await expect(fetchRepoEvidence(repo, data.sha, "main", "summary")).rejects.toThrow(/redirected from canonical repository/);
        expect(fetch).toHaveBeenCalledTimes(stage === "initial" ? 2 : 3);
      }
    }
  });

  it("rejects missing/wrong MIME, malformed PACK, sideband, remote ERR and damaged checksum", async () => {
    const data = fixture();
    const damaged = pack([data.commit, ...data.trees]);
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    for (const response of [
      new Response(new Uint8Array(pack([data.commit, ...data.trees]))), packResponse([data.commit, ...data.trees], pkt("NAK\n"), { headers: { "content-type": "text/html" } }),
      new Response("html", { headers: { "content-type": "application/x-git-upload-pack-result" } }),
      packResponse([data.commit, ...data.trees], pkt("ERR unavailable private details\n")),
      packResponse([data.commit, ...data.trees], pkt("\u0001side-band\n")),
      new Response(new Uint8Array(damaged), { headers: { "content-type": "application/x-git-upload-pack-result" } })
    ]) {
      stubGithub(data, { initial: response });
      const error = await fetchRepoEvidence(repo, data.sha, "main", "summary").catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RetryableGithubError);
      expect((error as Error).message).not.toContain("private details");
    }
  });

  it("enforces 16MiB wire headers/stream counts, exact lengths and body cancellation", async () => {
    const data = fixture();
    for (const stage of ["initial", "blobs"] as const) {
      for (const stated of [String(16 * 1024 * 1024 + 1), "-1", "NaN", "9007199254740992", "1", null]) {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
          start(controller) { if (stated === "1") { controller.enqueue(new Uint8Array([1, 2])); controller.close(); } },
          pull(controller) { if (stated === null) controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel
        });
        const response = new Response(body, { headers: { "content-type": "application/x-git-upload-pack-result", ...(stated === null ? {} : { "content-length": stated }) } });
        stubGithub(data, stage === "initial" ? { initial: response } : { blobs: () => response });
        await expect(fetchRepoEvidence(repo, data.sha, "main", "summary")).rejects.toThrow(/exceeds|content length/);
        if (stated !== "1") expect(cancel).toHaveBeenCalledOnce();
      }
    }
  });

  it("aborts stalled refs headers and body at 45 seconds", async () => {
    vi.useFakeTimers();
    for (const stage of ["headers", "body"]) {
      let signal: AbortSignal | undefined;
      const cancel = vi.fn();
      vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return stage === "headers" ? new Promise<Response>(() => undefined) : Promise.resolve(refsResponse(new ReadableStream({ cancel })));
      }));
      const result = expect(resolveRepoAuthority(repo, "summary")).rejects.toThrow("GitHub evidence collection timed out");
      await vi.advanceTimersByTimeAsync(44_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(signal?.aborted).toBe(true);
      if (stage === "body") expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it.each(["initial headers", "initial body", "blob headers", "blob body"])("keeps %s inside the same cumulative deadline", async (stage) => {
    vi.useFakeTimers();
    const data = fixture();
    const signals: (AbortSignal | undefined)[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      if (url === refsUrl) return new Promise<Response>((resolve) => setTimeout(() => resolve(refsResponse(advertisement(data.sha))), 30_000));
      const initial = requestPackets(init).includes("filter blob:none\n");
      if (initial && stage.startsWith("blob")) return Promise.resolve(packResponse([data.commit, ...data.trees]));
      if (stage.endsWith("headers")) return new Promise<Response>(() => undefined);
      return Promise.resolve(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/x-git-upload-pack-result" } }));
    }));
    const result = expect(fetchRepoEvidence(repo, data.sha, "main", "summary")).rejects.toThrow("GitHub evidence collection timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signals).toHaveLength(stage.startsWith("blob") ? 3 : 2);
    expect(new Set(signals).size).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    if (stage.endsWith("body")) expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("admits four source acquisitions in FIFO order with only one active through PACK processing", async () => {
    vi.useFakeTimers();
    const data = fixture();
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const order: number[] = [];
    let active = 0;
    let maximum = 0;
    const repos = gates.map((_, index) => ({ ...repo, repo: `project-${index}`, normalized: `demo/project-${index}`, canonicalUrl: `https://github.com/demo/project-${index}` }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const index = repos.findIndex((candidate) => url.startsWith(`${candidate.canonicalUrl}.git/`));
      expect(index).toBeGreaterThanOrEqual(0);
      if (init?.method === "GET") {
        order.push(index);
        maximum = Math.max(maximum, ++active);
        init.signal!.addEventListener("abort", () => { active--; }, { once: true });
        return canonical(refsResponse(advertisement(data.sha)), url);
      }
      if (requestPackets(init).includes("filter blob:none\n")) {
        await gates[index]!.promise;
        return canonical(packResponse([data.commit, ...data.trees]), url);
      }
      return canonical(packResponse([...data.blobs.values()]), url);
    }));
    const results = repos.map((candidate, index) => index % 2 === 0
      ? fetchRepoEvidence(candidate, data.sha, "main", String(index))
      : resolveRepoEvidence(candidate, String(index)));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([0]);
    for (let index = 0; index < gates.length; index++) {
      expect(active).toBe(1);
      gates[index]!.resolve();
      expect((await results[index]!).files).toEqual([{ path: "src/main.ts", content: "tracked source", size: 14, truncated: false }]);
      await vi.advanceTimersByTimeAsync(50);
      expect(order).toEqual(Array.from({ length: Math.min(index + 2, gates.length) }, (_, position) => position));
    }
    expect(maximum).toBe(1);
    expect(active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts each acquisition deadline after admission while authority freezing stays concurrent", async () => {
    vi.useFakeTimers();
    const data = fixture();
    const fetch = vi.fn((url: string) => url === refsUrl ? Promise.resolve(refsResponse(advertisement(data.sha))) : new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const first = expect(fetchRepoEvidence(repo, data.sha, "main", "first")).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5_000);
    const queued = expect(fetchRepoEvidence(repo, data.sha, "main", "queued")).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await resolveRepoAuthority(repo, "freeze")).toMatchObject({ pinnedSha: data.sha });
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(35_000);
    await first;
    expect(fetch).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await queued;
    expect(vi.getTimerCount()).toBe(0);
    stubGithub(data);
    expect((await fetchRepoEvidence(repo, data.sha, "main", "after timeout")).assessment).toBe("scored");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out admission at 120 seconds, removes expired tickets and admits a later live caller", async () => {
    vi.useFakeTimers();
    const data = fixture();
    const fetch = stubGithub(data);
    const respond = fetch.getMockImplementation()!;
    let acquisitions = 0;
    fetch.mockImplementation(async (url, init) => {
      if (String(url) === refsUrl) acquisitions++;
      if (String(url) === uploadUrl && requestPackets(init).includes("filter blob:none\n")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 44_000));
      }
      return respond(url, init);
    });
    const admitted = Array.from({ length: 3 }, (_, index) => fetchRepoEvidence(repo, data.sha, "main", String(index)));
    const expired = Array.from({ length: 2 }, () => fetchRepoEvidence(repo, data.sha, "main", "expires").catch((error: unknown) => error));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(acquisitions).toBe(3);
    expect(vi.getTimerCount()).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    for (const result of await Promise.all(expired)) {
      expect(result).toBeInstanceOf(RetryableGithubError);
      expect((result as Error).message).toBe("GitHub source acquisition admission timed out");
    }
    expect(acquisitions).toBe(3);
    expect(vi.getTimerCount()).toBe(2);
    fetch.mockImplementation(respond);
    const later = fetchRepoEvidence(repo, data.sha, "main", "after expired waiters");
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await later).assessment).toBe("scored");
    expect((await Promise.all(admitted)).every((snapshot) => snapshot.fullSource)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires abandoned owner and waiting tickets without invoking their cancelled timers", async () => {
    vi.useFakeTimers();
    const data = fixture();
    const fetch = stubGithub(data);
    const respond = fetch.getMockImplementation()!;
    fetch.mockImplementation((url, init) => String(url) === uploadUrl ? new Promise<Response>(() => undefined) : respond(url, init));
    void fetchRepoEvidence(repo, data.sha, "main", "abandoned owner");
    await vi.advanceTimersByTimeAsync(0);
    void fetchRepoEvidence(repo, data.sha, "main", "abandoned waiter");
    expect(vi.getTimerCount()).toBe(2);
    vi.clearAllTimers();
    await vi.advanceTimersByTimeAsync(1_000);
    fetch.mockImplementation(respond);
    const live = fetchRepoEvidence(repo, data.sha, "main", "live waiter");
    await vi.advanceTimersByTimeAsync(118_999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await live).assessment).toBe("scored");
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a resumed expired owner before PACK processing and never releases a later owner", async () => {
    vi.useFakeTimers();
    const data = fixture();
    const fetch = stubGithub(data);
    const respond = fetch.getMockImplementation()!;
    const stalePack = deferred<Response>();
    const currentPack = deferred<Response>();
    let initialRequests = 0;
    fetch.mockImplementation((url, init) => {
      if (String(url) === uploadUrl && requestPackets(init).includes("filter blob:none\n")) {
        if (++initialRequests === 1) return stalePack.promise;
        if (initialRequests === 2) return currentPack.promise;
      }
      return respond(url, init);
    });
    const stale = expect(fetchRepoEvidence(repo, data.sha, "main", "stale")).rejects.toThrow("GitHub evidence collection timed out");
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
    vi.setSystemTime(Date.now() + 45_000);
    const current = fetchRepoEvidence(repo, data.sha, "main", "current");
    await vi.advanceTimersByTimeAsync(0);
    const later = fetchRepoEvidence(repo, data.sha, "main", "later");
    const cancel = vi.fn();
    stalePack.resolve(canonical(new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "application/x-git-upload-pack-result" }
    }), uploadUrl));
    await stale;
    await vi.advanceTimersByTimeAsync(50);
    expect(initialRequests).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(2);
    currentPack.resolve(packResponse([data.commit, ...data.trees]));
    expect((await current).assessment).toBe("scored");
    await vi.advanceTimersByTimeAsync(50);
    expect((await later).assessment).toBe("scored");
    expect(initialRequests).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks an admission's elapsed deadline before a suspended caller starts source I/O", async () => {
    vi.useFakeTimers();
    const data = fixture();
    const fetch = stubGithub(data);
    const expired = expect(fetchRepoEvidence(repo, data.sha, "main", "suspended")).rejects.toThrow("GitHub evidence collection timed out");
    vi.setSystemTime(Date.now() + 45_000);
    const current = fetchRepoEvidence(repo, data.sha, "main", "current");
    await expired;
    expect((await current).assessment).toBe("scored");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a failed owner and preserves FIFO for its successors", async () => {
    vi.useFakeTimers();
    const data = fixture();
    const fetch = stubGithub(data);
    fetch.mockRejectedValueOnce(new TypeError("request context cancelled"));
    const failed = expect(fetchRepoEvidence(repo, data.sha, "main", "failed")).rejects.toThrow("GitHub evidence collection request failed");
    const next = fetchRepoEvidence(repo, data.sha, "main", "next");
    const last = resolveRepoEvidence(repo, "last");
    await failed;
    await vi.advanceTimersByTimeAsync(100);
    expect((await next).summary).toBe(`next ${provenance}`);
    expect((await last).summary).toBe(`last ${provenance}`);
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});
