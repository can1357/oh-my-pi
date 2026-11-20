import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CODEX_CLIENT_VERSION } from "@oh-my-pi/pi-catalog/wire/codex";
import {
	__awaitCodexClientVersionRefreshForTests,
	__resetCodexClientVersionCacheForTests,
	getCodexClientVersion,
} from "@oh-my-pi/pi-catalog/wire/codex-version";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

const ENV_KEYS = [
	"NODE_ENV",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"XDG_CACHE_HOME",
	"PI_AI_CODEX_CLIENT_VERSION",
] as const;
const xdgPlatform = process.platform === "linux" || process.platform === "darwin";

function stubFetch(version: string): { restore: () => void; calls: () => number } {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return Response.json({ version });
	}) as unknown as typeof fetch;
	return {
		restore: () => {
			globalThis.fetch = original;
		},
		calls: () => calls,
	};
}

describe("Codex client version cache", () => {
	let tempRoot = "";
	let configDir = "";
	let defaultAgentDir = "";
	let originalAgentDir = "";
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalEnv = {};
		for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
		tempRoot = path.join(os.tmpdir(), "pi-catalog-codex-version", crypto.randomUUID());
		configDir = `.omp-codex-version-${crypto.randomUUID()}`;
		defaultAgentDir = path.join(os.homedir(), configDir, "agent");
		const xdgCache = path.join(tempRoot, "cache");
		await fs.mkdir(path.join(xdgCache, "omp"), { recursive: true });
		process.env.PI_CONFIG_DIR = configDir;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_AI_CODEX_CLIENT_VERSION;
		process.env.XDG_CACHE_HOME = xdgCache;
		// bun test's NODE_ENV=test pins the version and would bypass the on-disk record.
		process.env.NODE_ENV = "production";
		// A fresh resolver is required because XDG roots are resolved and cached per DirResolver.
		setAgentDir(defaultAgentDir);
		__resetCodexClientVersionCacheForTests();
	});

	afterEach(async () => {
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		setAgentDir(originalAgentDir);
		const agentDirEnv = originalEnv.PI_CODING_AGENT_DIR;
		if (agentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = agentDirEnv;
		__resetCodexClientVersionCacheForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
		await fs.rm(path.join(os.homedir(), configDir), { recursive: true, force: true });
	});

	it.skipIf(!xdgPlatform)("reads the recorded version from $XDG_CACHE_HOME/omp without refetching", async () => {
		const recordPath = path.join(process.env.XDG_CACHE_HOME!, "omp", "codex-client-version.json");
		await Bun.write(recordPath, JSON.stringify({ version: "99.0.0", checkedAt: Date.now() }));
		const fetch = stubFetch("1.0.0");
		try {
			expect(getCodexClientVersion()).toBe("99.0.0");
			expect(fetch.calls()).toBe(0);
		} finally {
			fetch.restore();
		}
	});

	it.skipIf(!xdgPlatform)("refreshes a stale record into $XDG_CACHE_HOME/omp, not the agent dir", async () => {
		const recordPath = path.join(process.env.XDG_CACHE_HOME!, "omp", "codex-client-version.json");
		const fetch = stubFetch("98.1.2");
		try {
			expect(getCodexClientVersion()).toBe(CODEX_CLIENT_VERSION);
			await __awaitCodexClientVersionRefreshForTests();
			expect(await Bun.file(recordPath).json()).toMatchObject({ version: "98.1.2" });
			expect(await Bun.file(path.join(defaultAgentDir, "codex-client-version.json")).exists()).toBe(false);

			__resetCodexClientVersionCacheForTests();
			expect(getCodexClientVersion()).toBe("98.1.2");
		} finally {
			fetch.restore();
		}
	});
});
