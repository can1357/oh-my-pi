import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type {
	BlobBrokerDoctorResponse,
	BlobBrokerProbeResponse,
	BlobBrokerPurgeRequest,
	BlobBrokerPurgeResponse,
	BlobBrokerStatus,
} from "@oh-my-pi/pi-coding-agent/blob-broker/protocol";
import { ProviderFileCache } from "@oh-my-pi/pi-coding-agent/blob-broker/provider-file-types";
import {
	type ImagesCliDependencies,
	type ImagesCommandArgs,
	type ImagesResolvedConfig,
	runImagesCommand,
} from "@oh-my-pi/pi-coding-agent/cli/images-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { FetchImpl } from "@oh-my-pi/pi-utils";

interface CapturedRequest {
	readonly method: string;
	readonly pathname: string;
	readonly body: unknown;
}

type RouteHandler = (request: CapturedRequest) => unknown | Promise<unknown>;

let root: string;
let socketPath: string;
let server: Bun.Server<undefined> | undefined;
let requests: CapturedRequest[];
let routes: Map<string, RouteHandler>;
let stdout: string[];
let stderr: string[];
let stdoutSpy: { mockRestore(): void } | undefined;
let stderrSpy: { mockRestore(): void } | undefined;
const originalExitCode = process.exitCode;

const status: BlobBrokerStatus = {
	baseUrl: "https://public.example.test/capability/never-render-this",
	lazy: true,
	configKey: "test-config",
	savings: {
		journalPath: "/daemon/image-savings.jsonl",
		entries: 2,
		imageCount: 3,
		inlineBytes: 15_000,
		referenceBytes: 600,
		savedBytes: 14_400,
		byDestination: {
			direct: {
				entries: 1,
				imageCount: 2,
				inlineBytes: 10_000,
				referenceBytes: 400,
				savedBytes: 9_600,
			},
			"provider-files": {
				entries: 1,
				imageCount: 1,
				inlineBytes: 5_000,
				referenceBytes: 200,
				savedBytes: 4_800,
			},
		},
	},
	metrics: {
		activeBlobs: 3,
		eagerBlobs: 1,
		lazyBlobs: 2,
		residentBytes: 1024,
		diskBytes: 2048,
		bytesServed: 8192,
		hits: 7,
		misses: 1,
		duplicateTokenGets: 2,
	},
	recentFetches: [
		{
			fetcherId: "openai",
			corroborated: true,
			timestamp: 1_777_000_000_000,
			method: "GET",
			found: true,
			tokenSuffix: "safe-tail",
		},
		{
			fetcherId: null,
			corroborated: false,
			timestamp: 1_777_000_000_001,
			method: "HEAD",
			found: false,
			tokenSuffix: null,
		},
	],
};

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-images-cli-"));
	socketPath = path.join(root, "images.sock");
	requests = [];
	routes = new Map();
	stdout = [];
	stderr = [];
	process.exitCode = 0;
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout.push(String(chunk));
		return true;
	});
	stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderr.push(String(chunk));
		return true;
	});
	server = Bun.serve({
		unix: socketPath,
		async fetch(request) {
			const pathname = new URL(request.url).pathname;
			let body: unknown;
			if (request.method !== "GET") {
				const text = await request.text();
				body = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
			}
			const captured = { method: request.method, pathname, body } satisfies CapturedRequest;
			requests.push(captured);
			const handler = routes.get(pathname);
			if (!handler) return Response.json({ error: "not found" }, { status: 404 });
			return Response.json(await handler(captured));
		},
	});
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	stderrSpy?.mockRestore();
	stderrSpy = undefined;
	process.exitCode = originalExitCode;
	await fs.rm(root, { recursive: true, force: true });
});

async function unixJson<T>(pathname: string, method: "GET" | "POST", body?: unknown): Promise<T | null> {
	try {
		const response = await fetch(`http://images.test${pathname}`, {
			method,
			unix: socketPath,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

function resolvedConfig(): ImagesResolvedConfig {
	return {
		enabled: true,
		orderedBackends: ["direct"],
		configs: [
			{
				kind: "direct",
				options: {},
				credentials: {},
				publicBaseUrl: "https://public.example.test",
				bindHost: "127.0.0.1",
			},
		],
		providerFileCachePath: path.join(root, "provider-files.json"),
		savingsJournalPath: path.join(root, "savings.jsonl"),
	};
}

function dependencies(overrides: Partial<ImagesCliDependencies> = {}): Partial<ImagesCliDependencies> {
	return {
		loadSettings: async () => Settings.isolated(),
		resolveConfig: () => resolvedConfig(),
		queryStatus: () => unixJson<BlobBrokerStatus>("/status", "GET"),
		queryDoctor: (_projectDir, request) => unixJson<BlobBrokerDoctorResponse>("/doctor", "POST", request),
		queryProbe: (_projectDir, _config, options) => unixJson<BlobBrokerProbeResponse>("/probe", "POST", options),
		queryPurge: (_projectDir, request) => unixJson<BlobBrokerPurgeResponse>("/purge", "POST", request),
		...overrides,
	};
}

function args(action: ImagesCommandArgs["action"], flags: ImagesCommandArgs["flags"] = {}): ImagesCommandArgs {
	return { action, flags: { dir: root, ...flags } };
}

function output(): string {
	return stdout.join("");
}

function doctorResponse(check: BlobBrokerDoctorResponse["checks"][number]): BlobBrokerDoctorResponse {
	return { status, checks: [check] };
}

async function writeSavings(): Promise<void> {
	await Bun.write(
		resolvedConfig().savingsJournalPath,
		[
			JSON.stringify({
				timestamp: 1,
				provider: "openai",
				model: "gpt-test",
				destination: "direct",
				imageCount: 2,
				inlineBytes: 10_000,
				referenceBytes: 400,
				savedBytes: 9_600,
			}),
			JSON.stringify({
				timestamp: 2,
				provider: "anthropic",
				model: "claude-test",
				destination: "provider-files",
				imageCount: 1,
				inlineBytes: 5_000,
				referenceBytes: 200,
				savedBytes: 4_800,
			}),
			"",
		].join("\n"),
	);
}

async function writeProviderFile(credential: string): Promise<string> {
	const contentHash = "a".repeat(64);
	const cache = new ProviderFileCache(resolvedConfig().providerFileCachePath, { saveDebounceMs: 60_000 });
	cache.set("openai", credential, contentHash, {
		provider: "openai",
		id: "file-test-1",
		mimeType: "image/png",
		bytes: 321,
		delete: {
			method: "DELETE",
			url: "https://api.openai.com/v1/files/file-test-1",
			headers: { Authorization: `Bearer ${credential}` },
		},
	});
	cache.save();
	return contentHash;
}

describe("images status", () => {
	test("renders fetcher attribution, duplicate GETs, and aggregate savings as text and one JSON document", async () => {
		routes.set("/status", () => status);
		await writeSavings();

		const textResult = await runImagesCommand(args("status"), dependencies());

		expect(textResult.action).toBe("status");
		expect(output()).toContain("2 duplicate GETs");
		expect(output()).toContain("Recent fetch: openai; corroborated=yes; GET hit");
		expect(output()).toContain("Recent fetch: unknown; corroborated=no; HEAD miss");
		expect(output()).toContain("14.1 KiB");
		expect(output()).toContain("14.6 KiB inline → 600 B references");
		expect(output()).not.toContain("never-render-this");

		stdout.length = 0;
		const jsonResult = await runImagesCommand(args("status", { json: true }), dependencies());
		const parsed = JSON.parse(output()) as typeof jsonResult;

		expect(parsed).toEqual(jsonResult);
		expect(parsed.action).toBe("status");
		expect("daemon" in parsed).toBe(true);
		if (parsed.action === "status" && "daemon" in parsed) {
			expect(parsed.daemon.metrics?.duplicateTokenGets).toBe(2);
			expect(parsed.daemon.recentFetches?.map(event => event.fetcherId)).toEqual(["openai", null]);
			expect(parsed.savings).toMatchObject({
				entries: 2,
				imageCount: 3,
				inlineBytes: 15_000,
				referenceBytes: 600,
				savedBytes: 14_400,
			});
		}
		expect(stderr).toEqual([]);
	});

	test("reports a stopped daemon in text and JSON without treating it as a command failure", async () => {
		const deps = dependencies({ queryStatus: async () => null });

		const textResult = await runImagesCommand(args("status"), deps);
		expect(textResult).toMatchObject({ action: "status", exitCode: 0, daemon: { state: "stopped" } });
		expect(output()).toContain("Daemon: stopped");

		stdout.length = 0;
		await runImagesCommand(args("status", { json: true }), deps);
		const parsed = JSON.parse(output()) as { daemon: { state: string } };
		expect(parsed.daemon.state).toBe("stopped");
		expect(stderr).toEqual([]);
	});
});

describe("images doctor", () => {
	test("distinguishes passing, warning, and failing checks and exit codes", async () => {
		for (const scenario of [
			{ status: "pass" as const, ok: true, exitCode: 0, healthy: true, marker: "[OK]" },
			{ status: "warn" as const, ok: true, exitCode: 0, healthy: true, marker: "[WARN]" },
			{ status: "fail" as const, ok: false, exitCode: 1, healthy: false, marker: "[ERROR]" },
		]) {
			routes.set("/doctor", () =>
				doctorResponse({
					name: `remote-${scenario.status}`,
					ok: scenario.ok,
					status: scenario.status,
					detail: "checked",
				}),
			);
			stdout.length = 0;
			const result = await runImagesCommand(args("doctor"), dependencies());
			expect(result).toMatchObject({ action: "doctor", exitCode: scenario.exitCode, healthy: scenario.healthy });
			expect(output()).toContain(`${scenario.marker} daemon:remote-${scenario.status}`);
		}
		expect(requests.filter(request => request.pathname === "/doctor")).toHaveLength(3);
		expect(stderr).toEqual([]);
	});
});

describe("images probe", () => {
	test("renders successful and failed probes and forwards the timeout", async () => {
		routes.set("/probe", () => ({ ok: true, durationMs: 37, detail: "public URL returned 200" }));
		const success = await runImagesCommand(args("probe", { timeout: 4 }), dependencies());
		expect(success).toMatchObject({ action: "probe", exitCode: 0, ok: true, durationMs: 37 });
		expect(output()).toContain("Image probe passed in 37 ms");
		expect(requests.at(-1)?.body).toEqual({ timeoutMs: 4_000 });

		routes.set("/probe", () => ({ ok: false, durationMs: 51, detail: "public URL returned 503" }));
		stdout.length = 0;
		const failure = await runImagesCommand(args("probe"), dependencies());
		expect(failure).toMatchObject({ action: "probe", exitCode: 1, ok: false, durationMs: 51 });
		expect(output()).toContain("Image probe failed in 51 ms");
		expect(stderr).toEqual([]);
	});
});

describe("images purge", () => {
	test("is a dry-run by default and sends the apply mutation boundary explicitly", async () => {
		const credential = "dry-run-secret";
		await writeProviderFile(credential);
		let remoteDeletes = 0;
		routes.set("/purge", request => {
			const purge = request.body as BlobBrokerPurgeRequest;
			if (purge.apply) remoteDeletes++;
			return {
				applied: purge.apply === true,
				purgedBlobs: 2,
				reclaimedBytes: 700,
				publications: [],
				remoteDeletes: [],
				attempted: purge.apply ? 2 : 0,
				deleted: purge.apply ? 2 : 0,
				errors: [],
			};
		});
		let authOpened = 0;

		const dryRun = await runImagesCommand(
			args("purge", { all: true }),
			dependencies({
				openAuthStorage: async () => {
					authOpened++;
					return AuthStorage.create(":memory:");
				},
			}),
		);

		expect(dryRun).toMatchObject({
			action: "purge",
			exitCode: 0,
			applied: false,
			providerFiles: { selected: 1, deleted: 0 },
		});
		expect(requests.at(-1)?.body).toEqual({ apply: false, all: true, expiredOnly: false });
		expect(authOpened).toBe(0);
		expect(remoteDeletes).toBe(0);
		expect(new ProviderFileCache(resolvedConfig().providerFileCachePath).status().entries).toBe(1);
		expect(output()).toContain("dry-run; pass --apply to delete");
	});

	test("--apply performs daemon and provider-native deletion when matching credentials resolve", async () => {
		const credential = "openai-native-delete-secret";
		await writeProviderFile(credential);
		routes.set("/purge", request => {
			const purge = request.body as BlobBrokerPurgeRequest;
			return {
				applied: purge.apply === true,
				purgedBlobs: 1,
				reclaimedBytes: 321,
				publications: [],
				remoteDeletes: [],
				attempted: 1,
				deleted: 1,
				errors: [],
			};
		});
		const providerRequests: Array<{ url: string; method: string; authorization: string | null }> = [];
		const providerFetch: FetchImpl = async (input, init) => {
			const headers = new Headers(init?.headers);
			providerRequests.push({
				url: String(input),
				method: init?.method ?? "GET",
				authorization: headers.get("authorization"),
			});
			return Response.json({ deleted: true });
		};

		const result = await runImagesCommand(
			args("purge", { apply: true, all: true, json: true }),
			dependencies({
				openAuthStorage: async () => {
					const storage = await AuthStorage.create(":memory:");
					storage.setRuntimeApiKey("openai", credential);
					return storage;
				},
				fetch: providerFetch,
			}),
		);

		expect(result).toMatchObject({
			action: "purge",
			exitCode: 0,
			applied: true,
			providerFiles: { selected: 1, deleted: 1, skippedAuth: 0 },
		});
		expect(requests.at(-1)?.body).toEqual({ apply: true, all: true, expiredOnly: false });
		expect(providerRequests).toEqual([
			{
				url: "https://api.openai.com/v1/files/file-test-1",
				method: "DELETE",
				authorization: `Bearer ${credential}`,
			},
		]);
		expect(new ProviderFileCache(resolvedConfig().providerFileCachePath).status().entries).toBe(0);
		expect(JSON.parse(output())).toEqual(result);
		expect(output()).not.toContain(credential);
		expect(stderr).toEqual([]);
	});

	test("keeps provider-file metadata and fails safely when the matching credential is unavailable", async () => {
		await writeProviderFile("unavailable-secret");
		routes.set("/purge", () => ({
			applied: true,
			purgedBlobs: 0,
			reclaimedBytes: 0,
			publications: [],
			remoteDeletes: [],
			attempted: 0,
			deleted: 0,
			errors: [],
		}));

		const result = await runImagesCommand(
			args("purge", { apply: true, all: true }),
			dependencies({ openAuthStorage: () => AuthStorage.create(":memory:") }),
		);

		expect(result).toMatchObject({
			action: "purge",
			exitCode: 1,
			providerFiles: { selected: 1, deleted: 0, skippedAuth: 1 },
		});
		expect(new ProviderFileCache(resolvedConfig().providerFileCachePath).status().entries).toBe(1);
		expect(output()).toContain("matching authentication was unavailable");
		expect(output()).not.toContain("unavailable-secret");
	});

	test("redacts daemon remote-deletion credentials and capability URLs from text and JSON errors", async () => {
		const secret = "deletion-secret";
		const capability = "https://hooks.example.test/delete/full-capability?token=full-token";
		routes.set("/purge", () => ({
			applied: true,
			purgedBlobs: 1,
			reclaimedBytes: 12,
			publications: [{ url: "https://cdn.example.test/full-read-token", destination: "direct", bytes: 12 }],
			remoteDeletes: [{ method: "DELETE", url: capability, headers: { Authorization: `Bearer ${secret}` } }],
			attempted: 1,
			deleted: 0,
			errors: [`DELETE ${capability} failed with Bearer ${secret}`],
		}));

		const textResult = await runImagesCommand(args("purge", { apply: true, all: true }), dependencies());
		expect(textResult).toMatchObject({ action: "purge", exitCode: 1 });
		expect(output()).toContain("https://hooks.example.test");
		expect(output()).toContain("Bearer [redacted]");
		expect(output()).not.toContain(secret);
		expect(output()).not.toContain("full-token");
		expect(output()).not.toContain("full-capability");
		expect(output()).not.toContain("full-read-token");

		stdout.length = 0;
		await runImagesCommand(args("purge", { apply: true, all: true, json: true }), dependencies());
		const parsed = JSON.parse(output()) as {
			daemon: { publications?: unknown[]; remoteDeletes?: unknown[]; errors: string[] };
		};
		expect(parsed.daemon.publications).toBeUndefined();
		expect(parsed.daemon.remoteDeletes).toBeUndefined();
		expect(parsed.daemon.errors.join(" ")).not.toContain(secret);
		expect(output()).not.toContain("full-token");
		expect(output()).not.toContain("full-read-token");
		expect(stderr).toEqual([]);
	});
});
