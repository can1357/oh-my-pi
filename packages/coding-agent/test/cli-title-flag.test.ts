import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Observation {
	error?: { name: string; message: string };
	sessionName?: string | null;
	titleSource?: string | null;
	/** Session files in the launch's session directory when the run ended. */
	files?: string[];
}

/**
 * Resume a real saved session through real CLI startup, with and without
 * `--title`, and read back the name the session carries before its first turn.
 */
async function resumeWithTitle(title: string | undefined): Promise<Observation> {
	using temp = TempDir.createSync("@omp-title-flag-");
	const home = temp.join("home");
	const agentDir = path.join(home, ".omp", "agent");
	const sourceDir = path.resolve(import.meta.dir, "../src");
	const extension = temp.join("provider.ts");
	// The fixture never reaches the network: the launch is stopped before any
	// turn, and the provider's unroutable port makes that a hard guarantee.
	await Bun.write(
		extension,
		`const credential = ["fixture", "only"].join("-");
		export default pi => pi.registerProvider("title-fixture", {
			baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: credential,
			models: [{ id: "fresh", name: "Fresh", reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072, maxTokens: 1024 }]
		});`,
	);
	const script = `
		import { parseArgs } from ${JSON.stringify(path.join(sourceDir, "cli/args.ts"))};
		import { runRootCommand } from ${JSON.stringify(path.join(sourceDir, "main.ts"))};
		import { createAgentSession } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
		import { Settings } from ${JSON.stringify(path.join(sourceDir, "config/settings.ts"))};
		import { AuthStorage } from ${JSON.stringify(path.join(sourceDir, "session/auth-storage.ts"))};
		import { SessionManager } from ${JSON.stringify(path.join(sourceDir, "session/session-manager.ts"))};
		const cwd = process.cwd();
		const stamp = "2026-11-06T07:00:00Z";
		const file = SessionManager.getDefaultSessionDir(cwd) + "/dead.jsonl";
		const rows = [
			{ type: "session", version: 3, id: "dead-session", timestamp: stamp, cwd },
			{ type: "model_change", id: "model", parentId: null, timestamp: stamp,
				model: "title-fixture/fresh", role: "temporary" },
			{ type: "message", id: "user", parentId: "model", timestamp: stamp,
				message: { role: "user", content: "rebase the ShellPortAudit pull requests", timestamp: Date.parse(stamp) } }
		];
		await Bun.write(file, rows.map(row => JSON.stringify(row)).join("\\n") + "\\n");
		const args = ["--no-tools", "--no-skills", "--no-rules", "--no-lsp", "--no-prewalk",
			"--trusted-extension", ${JSON.stringify(extension)}, "--resume", file];
		${title === undefined ? "" : `args.push("--title", ${JSON.stringify(title)});`}
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const settings = Settings.isolated({
			modelRoles: { default: "title-fixture/fresh" },
			retry: { enabled: false, modelFallback: false }, compaction: { enabled: false },
			marketplace: { autoUpdate: "off" }, telemetry: { otlpExportEnabled: false }
		});
		const authStorage = await AuthStorage.create(":memory:");
		const stop = new Error("fixture captured the session before the mode runner");
		let observation = {};
		let manager;
		try {
			await runRootCommand(parseArgs(args), args, {
				settings, discoverAuthStorage: async () => authStorage,
				createAgentSession: async options => {
					manager = options.sessionManager;
					const { session } = await createAgentSession(options);
					try {
						await session.sessionManager.flush();
						observation.sessionName = session.sessionName ?? null;
						observation.titleSource = session.sessionManager.titleSource ?? null;
					} finally {
						await session.dispose();
					}
					throw stop;
				}
			});
		} catch (error) {
			if (error !== stop) observation.error = { name: error.name, message: error.message };
		} finally {
			await manager?.close();
			authStorage.close();
			observation.files = (await Array.fromAsync(
				new Bun.Glob("*.jsonl").scan({ cwd: SessionManager.getDefaultSessionDir(cwd) })
			)).sort();
		}
		console.log("OBSERVATION_TITLE_FLAG:" + JSON.stringify(observation));
		process.exit(0);
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: temp.path(),
		env: {
			PATH: process.env.PATH,
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: agentDir,
			TMPDIR: process.env.TMPDIR,
			TMP: process.env.TMP,
			TEMP: process.env.TEMP,
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			NO_COLOR: "1",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		signal: AbortSignal.timeout(60_000),
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`Title fixture exited ${exitCode}: ${stderr}\n${stdout}`);
		const line = stdout.split("\n").find(row => row.startsWith("OBSERVATION_TITLE_FLAG:"));
		if (!line) throw new Error(`Title fixture produced no observation: ${stderr}\n${stdout}`);
		return JSON.parse(line.slice("OBSERVATION_TITLE_FLAG:".length)) as Observation;
	} finally {
		proc.kill();
		await proc.exited;
	}
}

describe("omp --title", () => {
	test("names the resumed session before its first turn, as a title the user set", async () => {
		const named = await resumeWithTitle("ShellPortAudit lane");

		expect(named.error).toBeUndefined();
		expect(named.sessionName).toBe("ShellPortAudit lane");
		// "user", so no generated title can replace it and no refresh judges it.
		expect(named.titleSource).toBe("user");
	}, 90_000);

	test("leaves the resumed session unnamed when no title is given", async () => {
		const unnamed = await resumeWithTitle(undefined);

		expect(unnamed.error).toBeUndefined();
		expect(unnamed.sessionName).toBeNull();
		expect(unnamed.titleSource).toBeNull();
	}, 90_000);

	// Whitespace and control characters alike: `cleanSessionTitle` turns both
	// into nothing, and `setSessionName` would then drop the title and return
	// false without a word, leaving the launcher to believe it had named the
	// session. The flag refuses at parse time instead, before a session exists.
	// `trim()` calls the second of these a title, which is why the check asks
	// the one cleaner rather than carrying its own notion of blank.
	test.each([
		["whitespace", "   "],
		["control characters", "\u0001\u0002"],
	])(
		"refuses a %s title instead of naming nothing",
		async (_label, title) => {
			const refused = await resumeWithTitle(title);

			expect(refused.error?.name).toBe("CliUsageError");
			expect(refused.sessionName).toBeUndefined();
			// Refused at parse time, so no session was resolved: the dead one it
			// would have resumed is the only file, with no fork left behind.
			expect(refused.files).toEqual(["dead.jsonl"]);
		},
		90_000,
	);
});
