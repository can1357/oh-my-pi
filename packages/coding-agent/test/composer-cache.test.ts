import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { COMPOSER_DEFAULTS } from "@oh-my-pi/pi-coding-agent/modes/composer";
import {
	readComposerStartupCache,
	writeComposerLspCache,
	writeComposerRecentSessionsCache,
	writeComposerUiCache,
	writeComposerWelcomeCache,
} from "@oh-my-pi/pi-coding-agent/modes/composer-cache";
import { getComposerCacheDir } from "@oh-my-pi/pi-utils/dirs";

describe("composer startup cache", () => {
	it("round-trips per-project UI, recent-session JSONL, and LSP speculation", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-composer-cache-"));
		const otherCwd = `${cwd}-other`;
		const key = Bun.hash.wyhash(path.resolve(cwd)).toString(16).padStart(16, "0");
		const cacheDir = path.join(getComposerCacheDir(), key);
		try {
			const preferences = { ...COMPOSER_DEFAULTS, composerShape: "rail", autocompleteMaxVisible: 7 };
			const recentSessions = [{ name: "cached work", timeAgo: "3m ago" }];
			const lspServers = [{ name: "rust-analyzer", status: "connecting" as const, fileTypes: [".rs"] }];
			await Promise.all([
				writeComposerUiCache(cwd, preferences, {
					symbolPreset: "ascii",
					colorBlindMode: true,
					darkTheme: "dark",
					lightTheme: "light",
				}),
				writeComposerRecentSessionsCache(cwd, recentSessions),
				writeComposerLspCache(cwd, lspServers),
				writeComposerWelcomeCache(cwd, { modelName: "Claude Fable 5", providerName: "anthropic" }),
			]);

			expect(readComposerStartupCache(cwd)).toEqual({
				preferences,
				theme: {
					symbolPreset: "ascii",
					colorBlindMode: true,
					darkTheme: "dark",
					lightTheme: "light",
				},
				welcome: { modelName: "Claude Fable 5", providerName: "anthropic" },
				recentSessions,
				lspServers,
			});
			expect(readComposerStartupCache(otherCwd)).toEqual({
				preferences: undefined,
				theme: undefined,
				welcome: undefined,
				recentSessions: [],
				lspServers: [],
			});
			const jsonl: unknown = Bun.JSONL.parse(await Bun.file(path.join(cacheDir, "recent-sessions.jsonl")).text());
			expect(jsonl).toEqual(recentSessions);
		} finally {
			await Promise.all([
				fs.rm(cwd, { recursive: true, force: true }),
				fs.rm(cacheDir, { recursive: true, force: true }),
			]);
		}
	});
	it("loads XDG_CACHE_HOME from the home .env before the first cache access", async () => {
		if (process.platform === "win32") return;

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-composer-cache-dotenv-"));
		const home = path.join(root, "home");
		const xdgCache = path.join(root, "xdg-cache");
		const project = path.join(root, "project");
		try {
			await Promise.all([
				fs.mkdir(home, { recursive: true }),
				fs.mkdir(path.join(xdgCache, "omp"), { recursive: true }),
			]);
			await Bun.write(path.join(home, ".env"), `XDG_CACHE_HOME=${xdgCache}\n`);

			const composerCacheModule = path.resolve(import.meta.dir, "../src/modes/composer-cache.ts");
			const script = [
				'import * as path from "node:path";',
				`import { writeComposerWelcomeCache } from ${JSON.stringify(composerCacheModule)};`,
				`const project = ${JSON.stringify(project)};`,
				'await writeComposerWelcomeCache(project, { modelName: "model", providerName: "provider" });',
				'const key = Bun.hash.wyhash(path.resolve(project)).toString(16).padStart(16, "0");',
				`const expected = path.join(${JSON.stringify(xdgCache)}, "omp", "cache", "composer", key, "welcome.json");`,
				"process.stdout.write(String(await Bun.file(expected).exists()));",
			].join("\n");
			const proc = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", script], {
				cwd: root,
				env: {
					...process.env,
					HOME: home,
					XDG_CACHE_HOME: undefined,
					PI_CODING_AGENT_DIR: undefined,
					OMP_PROFILE: undefined,
					PI_PROFILE: undefined,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			expect(stdout).toBe("true");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
