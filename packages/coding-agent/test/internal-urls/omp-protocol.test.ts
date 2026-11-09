import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { getDocsDiskRoot, getEmbeddedDoc } from "@oh-my-pi/pi-coding-agent/internal-urls/docs-index";

describe("OmpProtocolHandler", () => {
	// `locate` materializes docs into the docs cache, so point it at a throwaway
	// root — never the real ~/.omp/cache/docs. The override is set and restored
	// per test: a file-wide `beforeAll` override leaves a process-global path
	// active for sibling suites that run interleaved in the same worker.
	let root: string;
	let cacheDir: string;
	let originalCacheDir: string | undefined;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-docs-"));
		cacheDir = path.join(root, "cache");
		originalCacheDir = process.env.OMP_DOCS_CACHE_DIR;
	});

	beforeEach(async () => {
		process.env.OMP_DOCS_CACHE_DIR = cacheDir;
		// Each test starts from an empty cache: the containment tests leave a
		// symlinked digest dir behind, and a cache hit must not leak across tests.
		await fs.rm(cacheDir, { recursive: true, force: true });
	});

	afterEach(() => {
		if (originalCacheDir === undefined) delete process.env.OMP_DOCS_CACHE_DIR;
		else process.env.OMP_DOCS_CACHE_DIR = originalCacheDir;
	});

	afterAll(() => {
		if (originalCacheDir === undefined) delete process.env.OMP_DOCS_CACHE_DIR;
		else process.env.OMP_DOCS_CACHE_DIR = originalCacheDir;
		return fs.rm(root, { recursive: true, force: true });
	});

	it("treats omp://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("omp://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("omp://tools/read.md");
		const prefixed = await router.resolve("omp://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});

	it("locates a doc to the file the active corpus was read from", async () => {
		const router = InternalUrlRouter.instance();
		// A source checkout reads docs from disk; a bundled or embedded corpus
		// (e.g. after `gen:bundle`) leaves the sync paths no file to name.
		const diskRoot = getDocsDiskRoot();
		const onDisk = diskRoot === null ? undefined : path.join(diskRoot, "tools", "read.md");

		// The sync render paths name the corpus file: it is the doc `resolve`
		// serves. The embedded body can only be inflated off the render path, so
		// the async locate is what materializes a cache copy for installs that
		// have no checkout to name.
		expect(router.locateSync("omp://tools/read.md")).toBe(onDisk);
		expect(router.locateSync("omp://docs/tools/read.md:1-20")).toBe(onDisk);
	});

	it("never links a cache entry that resolves outside the docs cache", async () => {
		// The doc path is joined into the cache root, so containment is proven
		// before the write: an entry resolving elsewhere (here a symlink standing
		// in for the content-addressed dir) degrades to a plain-text link.
		const outside = path.join(root, "outside");
		await fs.mkdir(outside, { recursive: true });
		const located = await InternalUrlRouter.instance().locate("omp://tui.md");
		expect(located).toBeString();

		await Bun.write(path.join(outside, "tui.md"), "not the harness doc");
		await fs.rm(path.dirname(located!), { recursive: true, force: true });
		await fs.symlink(outside, path.dirname(located!));

		expect(await InternalUrlRouter.instance().locate("omp://tui.md")).toBeNull();
	});

	it("refuses to write a missing doc through a symlinked cache parent", async () => {
		// The digest dir stands in for the cache entry as a symlink outside the
		// root, and the outside leaf is absent: containment must resolve the
		// existing parent chain and refuse, not follow the link with mkdir.
		const router = InternalUrlRouter.instance();
		const located = await router.locate("omp://tui.md");
		expect(located).toBeString();

		const outside = path.join(root, "outside-missing");
		await fs.mkdir(outside, { recursive: true });
		await fs.rm(path.dirname(located!), { recursive: true, force: true });
		await fs.symlink(outside, path.dirname(located!));

		expect(await router.locate("omp://tui.md")).toBeNull();
		await expect(fs.stat(path.join(outside, "tui.md"))).rejects.toThrow();
	});

	it("regenerates a cache entry whose bytes no longer match the embedded doc", async () => {
		const router = InternalUrlRouter.instance();
		const located = await router.locate("omp://tui.md");
		expect(located).toBeString();
		const embedded = (await getEmbeddedDoc("tui.md"))!;
		expect(await Bun.file(located!).text()).toBe(embedded);

		// Replace the body in place: the path still names the old digest, but the
		// bytes are no longer the embedded doc.
		await fs.chmod(located!, 0o644);
		await Bun.write(located!, "# Forged documentation");

		const again = await router.locate("omp://tui.md");
		expect(again).toBeString();
		expect(await Bun.file(again!).text()).toBe(embedded);
	});

	it("keeps the link when the docs cache root is a symlink", async () => {
		// A cache root behind a symlink (`/var` → `/private/var`, a symlinked
		// `XDG_CACHE_HOME` or home) makes the resolved cache file live outside
		// the configured root. The link must survive the cache hit, not only
		// the first materialization.
		const realRoot = path.join(root, "real-cache");
		const linkedRoot = path.join(root, "linked-cache");
		await fs.mkdir(realRoot, { recursive: true });
		await fs.symlink(realRoot, linkedRoot);

		const previousCacheDir = process.env.OMP_DOCS_CACHE_DIR;
		process.env.OMP_DOCS_CACHE_DIR = linkedRoot;
		try {
			const router = InternalUrlRouter.instance();
			const first = await router.locate("omp://tui.md");
			expect(first).toBeString();
			// Second render is a cache hit: the file exists, so containment is
			// checked against the resolved path.
			const second = await router.locate("omp://tui.md");
			expect(second).toBeString();
			expect(second).toBe(first);
		} finally {
			if (previousCacheDir === undefined) delete process.env.OMP_DOCS_CACHE_DIR;
			else process.env.OMP_DOCS_CACHE_DIR = previousCacheDir;
		}
	});

	it("never locates a URL that names no doc on disk", async () => {
		const router = InternalUrlRouter.instance();

		// The docs root is a listing, and an unknown doc has no file: linking it
		// would open something `omp://` does not serve.
		expect(router.locateSync("omp://")).toBeUndefined();
		expect(router.locateSync("omp://docs")).toBeUndefined();
		expect(router.locateSync("omp://no-such-doc.md")).toBeUndefined();
		expect(await router.locate("omp://no-such-doc.md")).toBeNull();

		// Render paths must survive a model-authored traversal URL.
		expect(router.locateSync("omp://../AGENTS.md")).toBeUndefined();
	});
});
