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
		const preferences = { ...COMPOSER_DEFAULTS, composerShape: "rail", autocompleteMaxVisible: 7 };
		const theme = { symbolPreset: "ascii" as const, colorBlindMode: true, darkTheme: "dark", lightTheme: "light" };
		const status = statusFor(ThinkingLevel.High);

		const writer = ComposerCache.open(dbPath);
		writer.writeUi(project, preferences, theme, false);
		writer.writeStatus(project, status);
		writer.close();

		// A separate connection sees everything: the next launch reads what this one wrote.
		const reader = ComposerCache.open(dbPath);
		expect(reader.read(project)).toEqual({ preferences, theme, status });
		// Theme and status follow the user.
		expect(reader.read(other)).toEqual({ preferences, theme, status });
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

	it("reuses session usage only for the exact session being resumed", () => {
		const project = path.join(root, "project");
		const sessionFile = path.join(root, "sessions", "session-a.jsonl");
		const status = statusFor(ThinkingLevel.High);
		const statusWithUsage: ComposerStatusCache = {
			...status,
			statusLine: {
				...status.statusLine,
				contextPercent: 37.5,
				tokenBreakdown: {
					input: 25_000,
					output: 500,
					cacheWrite: 100,
					orchestrationInput: 250,
					orchestrationOutput: 50,
				},
			},
		};

		const cache = ComposerCache.open(dbPath);
		cache.writeStatus(project, statusWithUsage, sessionFile);
		expect(cache.cachedSessionFile(project)).toBe(sessionFile);
		expect(cache.cachedSessionFile(path.join(root, "fresh"))).toBeUndefined();

		const fresh = cache.read(project).status?.statusLine;
		expect(fresh?.thinkingLevel).toBe(ThinkingLevel.High);
		expect(fresh?.contextPercent).toBeUndefined();
		expect(fresh?.tokenBreakdown).toBeUndefined();
		cache.writeUi(project, COMPOSER_DEFAULTS, {}, true);
		const resumed = cache.read(project, { allowSessionUsage: true, sessionFile }).status?.statusLine;
		expect(resumed?.contextPercent).toBe(37.5);
		expect(resumed?.tokenBreakdown).toEqual(statusWithUsage.statusLine.tokenBreakdown);
		const otherTerminal = cache.read(project, {
			allowSessionUsage: true,
			sessionFile: path.join(root, "sessions", "session-b.jsonl"),
		}).status?.statusLine;
		expect(otherTerminal?.contextPercent).toBeUndefined();
		expect(otherTerminal?.tokenBreakdown).toBeUndefined();
		cache.writeUi(project, COMPOSER_DEFAULTS, {}, false);
		const disabled = cache.read(project, { allowSessionUsage: true, sessionFile }).status?.statusLine;
		expect(disabled?.contextPercent).toBeUndefined();
		expect(disabled?.tokenBreakdown).toBeUndefined();
		const fallback = cache.read(path.join(root, "fresh")).status?.statusLine;
		expect(fallback?.thinkingLevel).toBe(ThinkingLevel.High);
		expect(fallback?.contextPercent).toBeUndefined();
		expect(fallback?.tokenBreakdown).toBeUndefined();
		cache.close();
	});

	it("updates live auto-resume intent without replacing the cached UI snapshot", () => {
		const project = path.join(root, "project");
		const otherProject = path.join(root, "other-project");
		const sessionFile = path.join(root, "sessions", "session.jsonl");
		const otherSessionFile = path.join(root, "sessions", "other-session.jsonl");
		const preferences = { ...COMPOSER_DEFAULTS, composerShape: "rail" };
		const otherPreferences = { ...COMPOSER_DEFAULTS, composerShape: "box" };
		const theme = { symbolPreset: "ascii" as const, colorBlindMode: true };
		const status = statusFor(ThinkingLevel.High);
		const statusWithUsage: ComposerStatusCache = {
			...status,
			statusLine: { ...status.statusLine, contextPercent: 42 },
		};
		const cache = ComposerCache.open(dbPath);
		cache.writeUi(project, preferences, theme, true);
		cache.writeStatus(project, statusWithUsage, sessionFile);
		cache.writeUi(otherProject, otherPreferences, theme, true, true);
		cache.writeStatus(otherProject, statusWithUsage, otherSessionFile);

		cache.writeAutoResume(project, false);
		expect(cache.read(project)).toMatchObject({ preferences, theme });
		expect(cache.read(otherProject)).toMatchObject({ preferences: otherPreferences, theme });
		expect(
			cache.read(project, { allowSessionUsage: true, sessionFile }).status?.statusLine.contextPercent,
		).toBeUndefined();
		expect(
			cache.read(otherProject, { allowSessionUsage: true, sessionFile: otherSessionFile }).status?.statusLine
				.contextPercent,
		).toBe(42);
		expect(
			cache.read(path.join(root, "fresh"), { allowSessionUsage: true, sessionFile: otherSessionFile }).status
				?.statusLine.contextPercent,
		).toBeUndefined();

		cache.writeAutoResume(project, true);
		expect(cache.read(project, { allowSessionUsage: true, sessionFile }).status?.statusLine.contextPercent).toBe(42);
		expect(
			cache.read(otherProject, { allowSessionUsage: true, sessionFile: otherSessionFile }).status?.statusLine
				.contextPercent,
		).toBe(42);
		cache.close();
	});

	it("refreshes zero-turn status while preserving resumable-session usage", () => {
		const project = path.join(root, "project");
		const sessionFile = path.join(root, "sessions", "resumable.jsonl");
		const cached = statusFor(ThinkingLevel.Low);
		const cachedWithUsage: ComposerStatusCache = {
			...cached,
			statusLine: {
				...cached.statusLine,
				contextPercent: 37.5,
				tokenBreakdown: {
					input: 25_000,
					output: 500,
					cacheWrite: 100,
					orchestrationInput: 250,
					orchestrationOutput: 50,
				},
			},
		};
		const refreshed = statusFor(ThinkingLevel.High);
		const cache = ComposerCache.open(dbPath);
		cache.writeUi(project, COMPOSER_DEFAULTS, {}, true);
		cache.writeStatus(project, cachedWithUsage, sessionFile);

		cache.writeStatusPreservingSessionUsage(project, refreshed);

		expect(cache.cachedSessionFile(project)).toBe(sessionFile);
		const resumed = cache.read(project, { allowSessionUsage: true, sessionFile }).status?.statusLine;
		expect(resumed?.thinkingLevel).toBe(ThinkingLevel.High);
		expect(resumed?.contextPercent).toBe(37.5);
		expect(resumed?.tokenBreakdown).toEqual(cachedWithUsage.statusLine.tokenBreakdown);
		cache.close();
	});

	it("skips write transactions for identical payloads", () => {
		const project = path.join(root, "project");
		const cache = ComposerCache.open(dbPath);
		const observer = new Database(dbPath, { readonly: true });
		// data_version moves only when another connection commits a change.
		const dataVersion = () => observer.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version;
		const statementRuns = vi.spyOn(Statement.prototype, "run");
		const transactions = vi.spyOn(Database.prototype, "transaction");
		try {
			cache.writeStatus(project, statusFor(ThinkingLevel.High));
			const written = dataVersion();
			statementRuns.mockClear();
			transactions.mockClear();

			// Same connection: nothing reaches SQLite.
			cache.writeStatus(project, statusFor(ThinkingLevel.High));
			// Next launch: values learned by read() are not written back either.
			const next = ComposerCache.open(dbPath);
			next.read(project);
			next.writeStatus(project, statusFor(ThinkingLevel.High));
			expect(statementRuns).not.toHaveBeenCalled();
			expect(transactions).not.toHaveBeenCalled();

			// Without a prior read, the upsert guard still leaves identical rows untouched.
			const blind = ComposerCache.open(dbPath);
			blind.writeStatus(project, statusFor(ThinkingLevel.High));
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
			"status",
			JSON.stringify(statusFor(ThinkingLevel.High)),
		]);
		legacy.close();

		const cache = ComposerCache.open(dbPath);
		expect(cache.read(project).status).toBeUndefined();
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
			`cache.writeUi(${JSON.stringify(project)}, {}, {}, false);`,
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
