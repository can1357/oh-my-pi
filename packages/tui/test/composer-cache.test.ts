import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Database, Statement } from "bun:sqlite";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { COMPOSER_DEFAULTS, type ComposerStatusCache } from "@oh-my-pi/pi-tui/prompt/composer";
import { ComposerCache } from "@oh-my-pi/pi-tui/prompt/composer-cache";

function statusFor(thinkingLevel: ThinkingLevel): ComposerStatusCache {
	return {
		borderColor: { prefix: "\x1b[36m", suffix: "\x1b[39m" },
		statusLine: {
			settings: { leftSegments: ["model", "path", "git"], contextLine: "embedded" },
			gitEnabled: true,
			thinkingLevel,
			autoThinking: false,
			fastMode: false,
			usingSubscription: true,
			autoCompactEnabled: true,
			compactionBoundaries: { thresholdPercent: 80, speculationPercent: null },
		},
	};
}

describe("composer startup cache", () => {
	let root: string;
	let dbPath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-composer-cache-"));
		dbPath = path.join(root, "cache", "composer.db");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("round-trips per-project speculation and serves settings-derived rows to projects without their own", () => {
		const project = path.join(root, "project");
		const other = path.join(root, "other");
		const preferences = {
			...COMPOSER_DEFAULTS,
			stickyPrompt: "viewport" as const,
			composerShape: "rail",
			autocompleteMaxVisible: 7,
		};
		const theme = { symbolPreset: "ascii" as const, colorBlindMode: true, darkTheme: "dark", lightTheme: "light" };
		const sessions = ["a", "b", "c", "d", "e"].map(name => ({ name, timeAgo: "3m ago" }));
		const lspServers = [{ name: "rust-analyzer", status: "connecting" as const, fileTypes: [".rs"] }];
		const status = statusFor(ThinkingLevel.High);

		const writer = ComposerCache.open(dbPath);
		writer.writeUi(project, preferences, theme);
		writer.writeWelcome(project, { modelName: "Claude Fable 5", providerName: "anthropic" });
		writer.writeRecentSessions(project, sessions);
		writer.writeLspServers(project, lspServers);
		writer.writeStatus(project, status);
		writer.close();

		// A separate connection sees everything: the next launch reads what this one wrote.
		const reader = ComposerCache.open(dbPath);
		expect(reader.read(project)).toEqual({
			preferences,
			theme,
			welcome: { modelName: "Claude Fable 5", providerName: "anthropic" },
			recentSessions: sessions.slice(0, 4),
			lspServers,
			status,
		});
		// Theme, model labels, and status follow the user; sessions and LSP rows are project facts.
		expect(reader.read(other)).toEqual({
			preferences,
			theme,
			welcome: { modelName: "Claude Fable 5", providerName: "anthropic" },
			recentSessions: [],
			lspServers: [],
			status,
		});

		// Disabling LSP must replace the cached rows so the next prepaint hides the section.
		reader.writeLspServers(project, null);
		expect(reader.read(project).lspServers).toBeNull();
		reader.close();
	});

	it("defaults cached UI payloads without sticky presentation to off", () => {
		const project = path.join(root, "legacy-project");
		const writer = ComposerCache.open(dbPath);
		writer.writeUi(project, COMPOSER_DEFAULTS, {});
		writer.close();

		const database = new Database(dbPath);
		const row = database
			.prepare<{ value: string }, [string, string]>("SELECT value FROM entries WHERE project = ? AND kind = ?")
			.get(project, "ui");
		expect(row).toBeDefined();
		const payload = JSON.parse(row!.value) as { preferences: Record<string, unknown> };
		delete payload.preferences.stickyPrompt;
		database
			.prepare("UPDATE entries SET value = ? WHERE project = ? AND kind = ?")
			.run(JSON.stringify(payload), project, "ui");
		database.close();

		const reader = ComposerCache.open(dbPath);
		expect(reader.read(project).preferences?.stickyPrompt).toBe("off");
		reader.close();
	});

	it("prefers a project's own status over the last status written elsewhere", () => {
		const cache = ComposerCache.open(dbPath);
		cache.writeStatus(path.join(root, "a"), statusFor(ThinkingLevel.Low));
		cache.writeStatus(path.join(root, "b"), statusFor(ThinkingLevel.High));

		expect(cache.read(path.join(root, "a")).status?.statusLine.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(cache.read(path.join(root, "fresh")).status?.statusLine.thinkingLevel).toBe(ThinkingLevel.High);
		cache.close();
	});

	it("skips write transactions for identical payloads", () => {
		const project = path.join(root, "project");
		const sessions = [{ name: "a", timeAgo: "1m ago" }];
		const cache = ComposerCache.open(dbPath);
		const observer = new Database(dbPath, { readonly: true });
		// data_version moves only when another connection commits a change.
		const dataVersion = () => observer.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version;
		const statementRuns = vi.spyOn(Statement.prototype, "run");
		const transactions = vi.spyOn(Database.prototype, "transaction");
		try {
			cache.writeStatus(project, statusFor(ThinkingLevel.High));
			cache.writeRecentSessions(project, sessions);
			const written = dataVersion();
			statementRuns.mockClear();
			transactions.mockClear();

			// Same connection: nothing reaches SQLite.
			cache.writeStatus(project, statusFor(ThinkingLevel.High));
			cache.writeRecentSessions(project, sessions);
			// Next launch: values learned by read() are not written back either.
			const next = ComposerCache.open(dbPath);
			next.read(project);
			next.writeStatus(project, statusFor(ThinkingLevel.High));
			next.writeRecentSessions(project, sessions);
			expect(statementRuns).not.toHaveBeenCalled();
			expect(transactions).not.toHaveBeenCalled();

			// Without a prior read, the upsert guard still leaves identical rows untouched.
			const blind = ComposerCache.open(dbPath);
			blind.writeStatus(project, statusFor(ThinkingLevel.High));
			blind.writeRecentSessions(project, sessions);
			expect(dataVersion()).toBe(written);

			next.writeStatus(project, statusFor(ThinkingLevel.Low));
			expect(dataVersion()).not.toBe(written);
			expect(cache.read(path.join(root, "fresh")).status?.statusLine.thinkingLevel).toBe(ThinkingLevel.Low);
			next.close();
			blind.close();
		} finally {
			statementRuns.mockRestore();
			transactions.mockRestore();
			observer.close();
			cache.close();
		}
	});

	it("drops a store written in an older payload format", async () => {
		const project = path.join(root, "project");
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const legacy = new Database(dbPath);
		legacy.run(
			"CREATE TABLE entries (project TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project, kind)) WITHOUT ROWID",
		);
		legacy.run("INSERT INTO entries VALUES (?, ?, ?)", [
			project,
			"welcome",
			JSON.stringify({ modelName: "Stale", providerName: "stale" }),
		]);
		legacy.close();

		const cache = ComposerCache.open(dbPath);
		expect(cache.read(project).welcome).toBeUndefined();
		cache.close();
	});

	it("loads XDG_CACHE_HOME from the home .env before the first cache access", async () => {
		if (process.platform === "win32") return;

		const home = path.join(root, "home");
		const xdgCache = path.join(root, "xdg-cache");
		const project = path.join(root, "project");
		await Promise.all([
			fs.mkdir(home, { recursive: true }),
			fs.mkdir(path.join(xdgCache, "omp"), { recursive: true }),
		]);
		await Bun.write(path.join(home, ".env"), `XDG_CACHE_HOME=${xdgCache}\n`);

		const composerCacheModule = Bun.resolveSync("@oh-my-pi/pi-tui/prompt/composer-cache", import.meta.dir);
		const script = [
			'import * as path from "node:path";',
			`import { ComposerCache } from ${JSON.stringify(composerCacheModule)};`,
			"const cache = ComposerCache.open();",
			`cache.writeWelcome(${JSON.stringify(project)}, { modelName: "model", providerName: "provider" });`,
			"cache.close();",
			`const expected = path.join(${JSON.stringify(xdgCache)}, "omp", "cache", "composer.db");`,
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
	});
});
