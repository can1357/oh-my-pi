import { afterAll, afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { encodeArchive } from "../src/ar";
import {
	BrowserPlatform,
	computeExecutablePath,
	detectBrowserPlatform,
	getDownloadUrl,
	install,
} from "../src/browsers";

const BUILD_ID = "123.0.6312.58";
const ROOTS: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-browsers-test-"));
	ROOTS.push(root);
	return root;
}

afterAll(async () => {
	for (const root of ROOTS) await fs.rm(root, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Chrome-for-Testing layout goldens", () => {
	const goldens = [
		{
			platform: BrowserPlatform.LINUX,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${BUILD_ID}/linux64/chrome-linux64.zip`,
			executable: path.join("/cache", "chrome", `linux-${BUILD_ID}`, "chrome-linux64", "chrome"),
		},
		{
			platform: BrowserPlatform.MAC,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${BUILD_ID}/mac-x64/chrome-mac-x64.zip`,
			executable: path.join(
				"/cache",
				"chrome",
				`mac-${BUILD_ID}`,
				"chrome-mac-x64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			),
		},
		{
			platform: BrowserPlatform.MAC_ARM,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${BUILD_ID}/mac-arm64/chrome-mac-arm64.zip`,
			executable: path.join(
				"/cache",
				"chrome",
				`mac_arm-${BUILD_ID}`,
				"chrome-mac-arm64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			),
		},
		{
			platform: BrowserPlatform.WIN32,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${BUILD_ID}/win32/chrome-win32.zip`,
			executable: path.join("/cache", "chrome", `win32-${BUILD_ID}`, "chrome-win32", "chrome.exe"),
		},
		{
			platform: BrowserPlatform.WIN64,
			url: `https://storage.googleapis.com/chrome-for-testing-public/${BUILD_ID}/win64/chrome-win64.zip`,
			executable: path.join("/cache", "chrome", `win64-${BUILD_ID}`, "chrome-win64", "chrome.exe"),
		},
	] as const;

	for (const golden of goldens) {
		test(golden.platform, () => {
			expect(String(getDownloadUrl(golden.platform, BUILD_ID))).toBe(golden.url);
			expect(computeExecutablePath({ platform: golden.platform, buildId: BUILD_ID, cacheDir: "/cache" })).toBe(
				golden.executable,
			);
		});
	}
});

test("Chrome-for-Testing rejects linux/arm64 before producing archive or cache paths", async () => {
	const unsupported = "Chrome for Testing does not provide linux/arm64 builds";
	expect(() => getDownloadUrl(BrowserPlatform.LINUX_ARM, BUILD_ID)).toThrow(unsupported);
	expect(() =>
		computeExecutablePath({ platform: BrowserPlatform.LINUX_ARM, buildId: BUILD_ID, cacheDir: "/cache" }),
	).toThrow(unsupported);
	await expect(
		install({
			platform: BrowserPlatform.LINUX_ARM,
			buildId: BUILD_ID,
			cacheDir: "/cache",
			baseUrl: "http://127.0.0.1:1",
		}),
	).rejects.toThrow(unsupported);
});

test("install streams and extracts stored, deflated, nested, executable, and symlink entries", async () => {
	const root = await makeRoot();
	const fixture = Bun.file(path.join(import.meta.dir, "fixtures/browsers/synthetic-chrome.zip"));
	const server = Bun.serve({ port: 0, fetch: () => new Response(fixture) });
	const progress: Array<{ downloadedBytes: number; totalBytes: number }> = [];
	try {
		const installed = await install({
			platform: BrowserPlatform.LINUX,
			buildId: BUILD_ID,
			cacheDir: root,
			baseUrl: String(server.url),
			downloadProgressCallback: update => progress.push(update),
		});
		const executable = await fs.readFile(installed.executablePath, "utf8");
		expect(executable).toBe("#!/bin/sh\necho synthetic chrome\n");
		if (process.platform !== "win32") {
			expect((await fs.stat(installed.executablePath)).mode & 0o777).toBe(0o755);
		}
		expect(await fs.readFile(path.join(installed.path, "chrome-linux64/nested/data.txt"), "utf8")).toBe(
			"nested fixture\n",
		);
		if (process.platform !== "win32") {
			expect((await fs.stat(path.join(installed.path, "chrome-linux64/nested/data.txt"))).mode & 0o777).toBe(0o640);
		}
		expect(await fs.readlink(path.join(installed.path, "chrome-linux64/chrome-link"))).toBe("chrome");
		expect(progress.at(-1)?.downloadedBytes).toBe(fixture.size);
		expect(progress.at(-1)?.totalBytes).toBe(fixture.size);
	} finally {
		server.stop(true);
	}
});

test("install extracts a member larger than the default 64 MiB archive cap", async () => {
	// Regression for #9534: the managed Chrome-for-Testing binary (~269 MB)
	// exceeds DEFAULT_ARCHIVE_LIMITS.maxMemberSize (64 MiB), so install() must
	// extract with a ceiling sized for the trusted download.
	const root = await makeRoot();
	const bigSize = 65 * 1024 * 1024; // > 64 MiB default member cap
	const zip = await encodeArchive("zip", [["chrome-linux64/chrome", new Uint8Array(bigSize)]]);
	const server = Bun.serve({ port: 0, fetch: () => new Response(new Blob([zip])) });
	try {
		const installed = await install({
			platform: BrowserPlatform.LINUX,
			buildId: BUILD_ID,
			cacheDir: root,
			baseUrl: String(server.url),
		});
		expect((await fs.stat(installed.executablePath)).size).toBe(bigSize);
	} finally {
		server.stop(true);
	}
});

test("install rejects archive traversal", async () => {
	const root = await makeRoot();
	const fixture = Bun.file(path.join(import.meta.dir, "fixtures/browsers/traversal.zip"));
	const server = Bun.serve({ port: 0, fetch: () => new Response(fixture) });
	try {
		// Traversal member names are dropped while indexing, so extraction
		// succeeds without them and the install fails its executable check —
		// nothing may escape the cache root either way.
		await expect(
			install({ platform: BrowserPlatform.LINUX, buildId: BUILD_ID, cacheDir: root, baseUrl: String(server.url) }),
		).rejects.toThrow("did not contain its expected executable");
		expect(await fs.readdir(root)).not.toContain("escaped.txt");
	} finally {
		server.stop(true);
	}
});

test("concurrent installs download once without replacing the winner's browser", async () => {
	const root = await makeRoot();
	const fixture = Bun.file(path.join(import.meta.dir, "fixtures/browsers/synthetic-chrome.zip"));
	const requested = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		async fetch() {
			requests++;
			requested.resolve();
			await release.promise;
			return new Response(fixture);
		},
	});
	const options = { platform: BrowserPlatform.LINUX, buildId: BUILD_ID, cacheDir: root, baseUrl: String(server.url) };
	try {
		const first = install(options);
		const second = install(options);
		await requested.promise;
		release.resolve();
		const results = await Promise.all([first, second]);
		expect(requests).toBe(1);
		for (const result of results) {
			expect(await Bun.file(result.executablePath).text()).toBe("#!/bin/sh\necho synthetic chrome\n");
		}
	} finally {
		release.resolve();
		server.stop(true);
	}
});

test("a timed-out download releases its lock and partial archive so installation can be retried", async () => {
	const root = await makeRoot();
	const fixture = Bun.file(path.join(import.meta.dir, "fixtures/browsers/synthetic-chrome.zip"));
	const progressed = Promise.withResolvers<void>();
	const deadline = new AbortController();
	let stall = true;
	const server = Bun.serve({
		port: 0,
		fetch() {
			if (!stall) return new Response(fixture);
			return new Response(
				new ReadableStream({
					start(controller) {
						// Flush beyond the HTTP server's small-chunk buffer before stalling.
						controller.enqueue(new Uint8Array(64 * 1024));
					},
				}),
			);
		},
	});
	const options = {
		platform: BrowserPlatform.LINUX,
		buildId: BUILD_ID,
		cacheDir: root,
		baseUrl: String(server.url),
		downloadProgressCallback: () => progressed.resolve(),
	};
	// Drive the real fetch/body abort without waiting for the five-minute CDN deadline.
	const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
	try {
		const pending = install(options);
		await progressed.promise;
		deadline.abort(new DOMException("Download deadline elapsed", "TimeoutError"));
		await expect(pending).rejects.toThrow();
		expect((await fs.readdir(root)).filter(name => name.startsWith(".browser-"))).toEqual([]);
		timeout.mockRestore();
		stall = false;
		const installed = await install(options);
		expect(await Bun.file(installed.executablePath).text()).toBe("#!/bin/sh\necho synthetic chrome\n");
	} finally {
		timeout.mockRestore();
		server.stop(true);
	}
});

const networkTest = process.env.OMP_TEST_BROWSER_INSTALL ? test : test.skip;
networkTest(
	"network: downloads and installs the pinned Chrome-for-Testing build",
	async () => {
		const root = await makeRoot();
		const platform = detectBrowserPlatform();
		if (!platform) throw new Error("Network browser test requires a supported platform");
		const installed = await install({ platform, buildId: BUILD_ID, cacheDir: root });
		expect((await fs.stat(installed.executablePath)).isFile()).toBe(true);
	},
	300_000,
);
