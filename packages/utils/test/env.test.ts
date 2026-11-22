import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$envExact,
	$otelEnv,
	claimOmpOtelEnvFileEntry,
	filterChildShellEnv,
	filterProcessEnv,
	getDbBusyTimeoutMs,
	parseEnvFile,
	setInteractiveHost,
	stripGitRepoLocationEnv,
	withOmpOtelEnv,
} from "@oh-my-pi/pi-utils/env";

const tempDirs: string[] = [];

// Every variable `dirs.ts` consults to pick the profile, agent dir or config/state roots. A probe child
// must not inherit any of them from the developer's shell (e.g. OMP_PROFILE beats PI_PROFILE, and a
// named profile ignores PI_CODING_AGENT_DIR), or it would read a different agent dir than its fixture.
const DIR_RESOLUTION_ENV_RESET = {
	OMP_PROFILE: undefined,
	PI_PROFILE: undefined,
	PI_CONFIG_DIR: undefined,
	XDG_DATA_HOME: undefined,
	XDG_STATE_HOME: undefined,
	XDG_CACHE_HOME: undefined,
};

const runtimeProbePath = path.join(import.meta.dir, "fixtures", "test-runtime-probe.ts");

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

function writeTempEnv(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-"));
	tempDirs.push(dir);
	const filePath = path.join(dir, ".env");
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("getDbBusyTimeoutMs", () => {
	it("defaults to the bounded headless timeout", () => {
		const previous = setInteractiveHost(false);
		try {
			expect(getDbBusyTimeoutMs()).toBe(1000);
		} finally {
			setInteractiveHost(previous);
		}
	});

	it("keeps the interactive timeout for interactive hosts", () => {
		const previous = setInteractiveHost(true);
		try {
			expect(getDbBusyTimeoutMs()).toBe(5000);
		} finally {
			setInteractiveHost(previous);
		}
	});
});
async function runRuntimeProbe(
	env: Record<string, string | undefined>,
	probePath = runtimeProbePath,
): Promise<boolean> {
	const cwd = path.dirname(writeTempEnv(""));
	const proc = Bun.spawn([process.execPath, probePath], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as boolean;
}

describe("parseEnvFile", () => {
	it("ignores malformed names and nul-containing values", () => {
		const filePath = writeTempEnv(
			[
				"GOOD=value",
				"_ALSO_GOOD='quoted value'",
				"1BAD=value",
				"BAD-NAME=value",
				"BAD NAME=value",
				"BAD_VALUE=before\0after",
				"# comment",
				"NO_EQUALS",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			GOOD: "value",
			_ALSO_GOOD: "quoted value",
		});
	});

	it("mirrors valid OMP_ variables to PI_ variables", () => {
		const filePath = writeTempEnv("OMP_FEATURE=enabled\nOMP_BAD=before\0after\n");

		expect(parseEnvFile(filePath)).toEqual({
			OMP_FEATURE: "enabled",
			PI_FEATURE: "enabled",
		});
	});

	it("matches Bun dotenv syntax for export prefixes and inline comments", () => {
		const filePath = writeTempEnv(
			[
				"export EXPORTED=value",
				"COMMENTED=secret # trailing comment",
				'QUOTED_HASH="keep # this"',
				"NO_SPACE=http://host/path#frag",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			EXPORTED: "value",
			COMMENTED: "secret",
			QUOTED_HASH: "keep # this",
			NO_SPACE: "http://host/path",
		});
	});

	it("keeps escaped quotes inside quoted values literal, matching Bun", () => {
		const filePath = writeTempEnv(['JSON="{\\"a\\":1}"', "SINGLE='it\\'s'"].join("\n"));

		expect(parseEnvFile(filePath)).toEqual({
			JSON: '{\\"a\\":1}',
			SINGLE: "it\\'s",
		});
	});

	it("parses quoted multiline and escaped-newline values across the whole file", () => {
		const filePath = writeTempEnv(
			['MULTILINE="first', 'second"', 'ESCAPED_NEWLINE="first\\nsecond"', "BACKTICK=`first", "second`"].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			MULTILINE: "first\nsecond",
			ESCAPED_NEWLINE: "first\nsecond",
			BACKTICK: "first\nsecond",
		});
	});
});

describe("filterProcessEnv", () => {
	it("drops entries that cannot be passed to process spawn env", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				EMPTY: "",
				"BAD=NAME": "value",
				BAD_VALUE: "before\0after",
				MISSING: undefined,
			}),
		).toEqual({
			GOOD: "value",
			EMPTY: "",
		});
	});

	it("drops macOS malloc stack logging toggles instead of forwarding disabled values", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				MallocStackLogging: "0",
				MallocStackLoggingNoCompact: "0",
			}),
		).toEqual({
			GOOD: "value",
		});
	});

	it("preserves Windows-style variable names containing parentheses", () => {
		// `ProgramFiles(x86)` and friends are standard on Windows and must
		// survive the scrub so Git Bash discovery in procmgr.ts can resolve
		// 32-bit Program Files installations.
		expect(
			filterProcessEnv({
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
			}),
		).toEqual({
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
		});
	});
});

describe("filterChildShellEnv", () => {
	it("removes quoted multiline project values without a launch snapshot", () => {
		const cwd = path.dirname(
			writeTempEnv(['MULTILINE="first', 'second"', 'ESCAPED_NEWLINE="first\\nsecond"'].join("\n")),
		);

		expect(
			filterChildShellEnv(
				{
					MULTILINE: "first\nsecond",
					ESCAPED_NEWLINE: "first\nsecond",
					UNCHANGED: "parent-value",
				},
				cwd,
			),
		).toEqual({ UNCHANGED: "parent-value" });
	});

	it("uses the supplied mode for an isolated environment and cwd", async () => {
		const cwd = path.dirname(writeTempEnv(""));
		fs.writeFileSync(
			path.join(cwd, ".env.development.local"),
			"OMP_DOTENV_REPRO_MARKER=synthetic-mode-local-value\n",
		);
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const script = [
			`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
			"const child = filterChildShellEnv(",
			'  { OMP_DOTENV_REPRO_MARKER: "synthetic-mode-local-value", UNCHANGED: "parent-value" },',
			`  ${JSON.stringify(cwd)},`,
			");",
			"process.stdout.write(JSON.stringify(child));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			env: { ...process.env, NODE_ENV: "test", OMP_DOTENV_REPRO_MARKER: undefined },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ UNCHANGED: "parent-value" });
	});

	it("drops inherited git repo-location overrides", () => {
		const cwd = path.dirname(writeTempEnv(""));
		// A bash call with `cwd` in a secondary worktree must not mutate the
		// primary one: forwarding the agent's own repo-location variables makes
		// child `git` ignore the command's cwd (issue #11082).
		expect(
			filterChildShellEnv(
				{
					GIT_DIR: "/primary/.git",
					GIT_COMMON_DIR: "/primary/.git",
					GIT_WORK_TREE: "/primary",
					GIT_INDEX_FILE: "/primary/.git/index",
					GIT_OBJECT_DIRECTORY: "/primary/.git/objects",
					GIT_ALTERNATE_OBJECT_DIRECTORIES: "/primary/.git/objects",
					GIT_EDITOR: "true",
					GIT_AUTHOR_NAME: "Agent",
				},
				cwd,
			),
		).toEqual({ GIT_EDITOR: "true", GIT_AUTHOR_NAME: "Agent" });
	});

	it("uses the launch mode when dotenv changes NODE_ENV", async () => {
		const cwd = path.dirname(writeTempEnv("NODE_ENV=production\n"));
		fs.writeFileSync(
			path.join(cwd, ".env.development.local"),
			"OMP_DOTENV_REPRO_MARKER=synthetic-mode-local-value\n",
		);
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const script = [
			`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
			"const child = filterChildShellEnv(process.env, process.cwd());",
			"process.stdout.write(JSON.stringify({",
			"  processValue: process.env.OMP_DOTENV_REPRO_MARKER ?? null,",
			"  childValue: child.OMP_DOTENV_REPRO_MARKER ?? null,",
			"  nodeEnv: process.env.NODE_ENV ?? null,",
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: { ...process.env, NODE_ENV: undefined, OMP_DOTENV_REPRO_MARKER: undefined },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			processValue: "synthetic-mode-local-value",
			childValue: null,
			nodeEnv: "production",
		});
	});

	it.skipIf(process.platform === "win32")(
		"keeps filtering after the process working directory is deleted",
		async () => {
			const cwd = path.dirname(writeTempEnv(""));
			const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
			const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
			const script = [
				'import * as fs from "node:fs";',
				`import { filterChildShellEnv } from ${JSON.stringify(envModulePath)};`,
				`import { getProjectDir } from ${JSON.stringify(dirsModulePath)};`,
				"getProjectDir();",
				"fs.rmSync(process.cwd(), { recursive: true });",
				'const child = filterChildShellEnv({ UNCHANGED: "parent-value" });',
				"process.stdout.write(JSON.stringify(child));",
			].join("\n");
			const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual({ UNCHANGED: "parent-value" });
		},
	);
});

describe("stripGitRepoLocationEnv", () => {
	it("matches case-insensitively on win32 and exactly on POSIX", () => {
		// Windows env lookups are case-insensitive, so a `git_dir` block binds
		// there; POSIX names are case-sensitive and must not be over-stripped.
		const win32Env: Record<string, string> = { GIT_DIR: "a", git_dir: "b", GIT_WORK_TREE: "c", KEEP: "d" };
		stripGitRepoLocationEnv(win32Env, "win32");
		expect(win32Env).toEqual({ KEEP: "d" });

		const posixEnv: Record<string, string> = { GIT_DIR: "a", git_dir: "b", KEEP: "d" };
		stripGitRepoLocationEnv(posixEnv, "linux");
		expect(posixEnv).toEqual({ git_dir: "b", KEEP: "d" });
	});
});

describe("isBunTestRuntime", () => {
	it("does not treat shared application env names as a test runner signal", async () => {
		expect(await runRuntimeProbe({ NODE_ENV: "test", BUN_ENV: undefined, PI_TEST_RUNTIME: undefined })).toBe(false);
		expect(await runRuntimeProbe({ NODE_ENV: undefined, BUN_ENV: "test", PI_TEST_RUNTIME: undefined })).toBe(false);
	});

	it("honors the private test runner signal", async () => {
		expect(await runRuntimeProbe({ NODE_ENV: undefined, BUN_ENV: undefined, PI_TEST_RUNTIME: "1" })).toBe(true);
	});

	it("recognizes Bun's underscore test entrypoints", async () => {
		const dir = path.dirname(writeTempEnv(""));
		const underscoreProbePath = path.join(dir, "runtime_test.ts");
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		fs.writeFileSync(
			underscoreProbePath,
			`import { isBunTestRuntime } from ${JSON.stringify(envModulePath)};\nprocess.stdout.write(JSON.stringify(isBunTestRuntime()));\n`,
		);
		expect(
			await runRuntimeProbe(
				{ NODE_ENV: "test", BUN_ENV: undefined, PI_TEST_RUNTIME: undefined },
				underscoreProbePath,
			),
		).toBe(true);
	});
});

/**
 * Faithful model of Windows `process.env`: case-insensitive reads, but
 * enumeration (`ownKeys`) preserves the real key casing — exactly Node
 * (`uv_os_getenv` + `uv_os_environ`) and Bun (`CaseInsensitiveASCIIStringArrayHashMap`).
 */
function windowsLikeEnv(backing: Record<string, string>): Record<string, string | undefined> {
	return new Proxy(backing, {
		get(target, prop) {
			if (typeof prop !== "string") return Reflect.get(target, prop);
			for (const key in target) {
				if (key.toLowerCase() === prop.toLowerCase()) return target[key];
			}
			return undefined;
		},
		has(target, prop) {
			if (typeof prop !== "string") return Reflect.has(target, prop);
			for (const key in target) {
				if (key.toLowerCase() === prop.toLowerCase()) return true;
			}
			return false;
		},
	}) as Record<string, string | undefined>;
}

describe("$envExact", () => {
	it("does not hijack a literal via a case-differing Windows system var", () => {
		// Windows ships PUBLIC=C:\Users\Public and reads are case-insensitive, so
		// a bare `env["public"]` returns it — the /login #7361 401 root cause.
		const env = windowsLikeEnv({ PUBLIC: "C:\\Users\\Public" });
		expect(env.public).toBe("C:\\Users\\Public");
		expect($envExact("public", env)).toBeUndefined();
	});

	it("still resolves a genuine exact-case reference on a case-insensitive env", () => {
		const env = windowsLikeEnv({ MY_KEY: "secret" });
		expect($envExact("MY_KEY", env)).toBe("secret");
		expect($envExact("my_key", env)).toBeUndefined();
	});

	it("reads process.env by default", () => {
		const name = `PI_ENVEXACT_TEST_${Date.now()}`;
		process.env[name] = "value";
		try {
			expect($envExact(name)).toBe("value");
		} finally {
			delete process.env[name];
		}
		expect($envExact(name)).toBeUndefined();
	});
});

describe("OTEL_* from omp's own .env files", () => {
	interface ProbeResult {
		bunEnv: Record<string, string | null>;
		otelEnv: Record<string, string | null>;
		insideWindow: Record<string, string | null>;
		afterWindow: Record<string, string | null>;
		bashChildEnv: Record<string, string>;
		/** `process.env` and `stripOmpDotenvEnv(process.env)` over the own-file, project and shell names. */
		loaded: Record<string, string | null>;
		stripped: Record<string, string | null>;
	}

	// The dotenv loader runs at module load, so each case needs a fresh process
	// whose agent dir and HOME are temp dirs.
	async function runProbe(shellEnv: Record<string, string>): Promise<ProbeResult> {
		const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-utils-otel-home-"));
		const agentDir = path.join(home, "agent");
		const cwd = path.join(home, "project");
		tempDirs.push(home);
		await Bun.write(
			path.join(agentDir, ".env"),
			[
				"OTEL_PROBE_AGENT=agent",
				"OTEL_PROBE_SHELL=agent-file",
				"OTEL_PROBE_BOTH=agent",
				"PLAIN_PROBE_AGENT=plain",
				"OMP_STRIP_PROBE=omp-token",
			].join("\n"),
		);
		await Bun.write(
			path.join(home, ".env"),
			[
				"OTEL_PROBE_HOME=home",
				"OTEL_PROBE_AGENT=home-loses",
				"OTEL_PROBE_CONFIG=home-loses",
				"STRIP_PROBE_HOME=home",
			].join("\n"),
		);
		await Bun.write(
			path.join(home, ".omp", ".env"),
			["OTEL_PROBE_CONFIG=config-root", "STRIP_PROBE_CONFIG=config-root"].join("\n"),
		);
		await Bun.write(path.join(cwd, ".env"), ["OTEL_PROBE_PROJECT=project", "OTEL_PROBE_BOTH=project"].join("\n"));
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const names = [
			"OTEL_PROBE_AGENT",
			"OTEL_PROBE_HOME",
			"OTEL_PROBE_SHELL",
			"OTEL_PROBE_BOTH",
			"OTEL_PROBE_PROJECT",
			"OTEL_PROBE_CONFIG",
			"PLAIN_PROBE_AGENT",
		];
		const strippedNames = [
			"PLAIN_PROBE_AGENT",
			"OMP_STRIP_PROBE",
			"PI_STRIP_PROBE",
			"STRIP_PROBE_HOME",
			"STRIP_PROBE_CONFIG",
			"OTEL_PROBE_SHELL",
			"OTEL_PROBE_BOTH",
			"OTEL_PROBE_PROJECT",
		];
		const script = [
			`import { $otelEnv, stripOmpDotenvEnv, withOmpOtelEnv } from ${JSON.stringify(envModulePath)};`,
			`const names = ${JSON.stringify(names)};`,
			"const pick = read => Object.fromEntries(names.map(name => [name, read(name) ?? null]));",
			"const insideWindow = withOmpOtelEnv(() => pick(name => process.env[name]));",
			"const bash = Bun.spawn(['bash', '-c', 'env'], { env: process.env, stdout: 'pipe' });",
			"const bashText = await new Response(bash.stdout).text();",
			"const bashChildEnv = Object.fromEntries(bashText.split('\\n').filter(line => line.startsWith('OTEL_PROBE_') || line.startsWith('PLAIN_PROBE_')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));",
			`const strippedNames = ${JSON.stringify(strippedNames)};`,
			"const stripped = stripOmpDotenvEnv(process.env);",
			"process.stdout.write(JSON.stringify({",
			"  bunEnv: pick(name => Bun.env[name]),",
			"  otelEnv: pick(name => $otelEnv(name)),",
			"  insideWindow,",
			"  afterWindow: pick(name => process.env[name]),",
			"  bashChildEnv,",
			"  loaded: Object.fromEntries(strippedNames.map(name => [name, process.env[name] ?? null])),",
			"  stripped: Object.fromEntries(strippedNames.map(name => [name, stripped[name] ?? null])),",
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--eval", script], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: agentDir,
				...DIR_RESOLUTION_ENV_RESET,
				OTEL_PROBE_CONFIG: undefined,
				OTEL_PROBE_AGENT: undefined,
				OTEL_PROBE_HOME: undefined,
				OTEL_PROBE_SHELL: undefined,
				OTEL_PROBE_BOTH: undefined,
				OTEL_PROBE_PROJECT: undefined,
				PLAIN_PROBE_AGENT: undefined,
				OMP_STRIP_PROBE: undefined,
				PI_STRIP_PROBE: undefined,
				STRIP_PROBE_HOME: undefined,
				STRIP_PROBE_CONFIG: undefined,
				...shellEnv,
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
		return JSON.parse(stdout);
	}

	it.skipIf(process.platform === "win32")(
		"keeps agent/home .env OTEL_* out of Bun.env and any child, but readable through $otelEnv",
		async () => {
			const result = await runProbe({});
			// Neither the agent nor the home file reaches the process environment;
			// the project .env keeps its existing behavior (loaded into Bun.env), and
			// non-OTEL names from the agent file are untouched.
			expect(result.bunEnv).toEqual({
				OTEL_PROBE_AGENT: null,
				OTEL_PROBE_HOME: null,
				OTEL_PROBE_SHELL: null,
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
				OTEL_PROBE_CONFIG: null,
				PLAIN_PROBE_AGENT: "plain",
			});
			// agent beats home; config root beats home; project beats agent.
			expect(result.otelEnv).toEqual({
				OTEL_PROBE_AGENT: "agent",
				OTEL_PROBE_HOME: "home",
				OTEL_PROBE_SHELL: "agent-file",
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
				OTEL_PROBE_CONFIG: "config-root",
				PLAIN_PROBE_AGENT: "plain",
			});
			// The SDK-facing window exposes the file values, then removes them.
			expect(result.insideWindow).toMatchObject({
				OTEL_PROBE_AGENT: "agent",
				OTEL_PROBE_HOME: "home",
				OTEL_PROBE_SHELL: "agent-file",
				OTEL_PROBE_BOTH: "project",
			});
			expect(result.afterWindow).toEqual(result.bunEnv);
			// A bash child handed the live environment sees none of the file-owned values.
			expect(result.bashChildEnv).toEqual({
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
				PLAIN_PROBE_AGENT: "plain",
			});
			// The loader put every own-file value (agent dir with its OMP_→PI_ mirror, home, config
			// root) into the process env; a sandboxed process starts without them, but keeps the
			// project's, even for a name the agent file sets.
			expect(result.loaded).toEqual({
				PLAIN_PROBE_AGENT: "plain",
				OMP_STRIP_PROBE: "omp-token",
				PI_STRIP_PROBE: "omp-token",
				STRIP_PROBE_HOME: "home",
				STRIP_PROBE_CONFIG: "config-root",
				OTEL_PROBE_SHELL: null,
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
			});
			expect(result.stripped).toEqual({
				PLAIN_PROBE_AGENT: null,
				OMP_STRIP_PROBE: null,
				PI_STRIP_PROBE: null,
				STRIP_PROBE_HOME: null,
				STRIP_PROBE_CONFIG: null,
				OTEL_PROBE_SHELL: null,
				OTEL_PROBE_BOTH: "project",
				OTEL_PROBE_PROJECT: "project",
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"lets a shell-exported OTEL_* win in Bun.env and $otelEnv",
		async () => {
			const result = await runProbe({ OTEL_PROBE_SHELL: "from-shell" });
			expect(result.bunEnv.OTEL_PROBE_SHELL).toBe("from-shell");
			expect(result.otelEnv.OTEL_PROBE_SHELL).toBe("from-shell");
			expect(result.insideWindow.OTEL_PROBE_SHELL).toBe("from-shell");
			expect(result.afterWindow.OTEL_PROBE_SHELL).toBe("from-shell");
			// Still visible to children, as any exported variable is.
			expect(result.bashChildEnv.OTEL_PROBE_SHELL).toBe("from-shell");
			// A sandboxed process keeps it too: it differs from the agent file's value.
			expect(result.stripped.OTEL_PROBE_SHELL).toBe("from-shell");
			// The agent-file-only names stay private.
			expect(result.bashChildEnv.OTEL_PROBE_AGENT).toBeUndefined();
		},
		20_000,
	);

	describe("claimOmpOtelEnvFileEntry", () => {
		it("claims only OTEL_* names and applies the live value first", () => {
			expect(claimOmpOtelEnvFileEntry("PLAIN_CLAIM_PROBE", "x", "linux")).toBe(false);
			expect(claimOmpOtelEnvFileEntry("otel_lower_claim_probe", "x", "linux")).toBe(false);
			expect($otelEnv("PLAIN_CLAIM_PROBE")).toBeUndefined();

			process.env.OTEL_CLAIM_LIVE_PROBE = "live";
			try {
				expect(claimOmpOtelEnvFileEntry("OTEL_CLAIM_LIVE_PROBE", "file", "linux")).toBe(true);
				expect($otelEnv("OTEL_CLAIM_LIVE_PROBE")).toBe("live");
			} finally {
				delete process.env.OTEL_CLAIM_LIVE_PROBE;
			}
			// The file value was dropped, not deferred.
			expect($otelEnv("OTEL_CLAIM_LIVE_PROBE")).toBeUndefined();
		});

		it("keeps the first non-empty value across files", () => {
			claimOmpOtelEnvFileEntry("OTEL_CLAIM_ORDER_PROBE", "first", "linux");
			claimOmpOtelEnvFileEntry("OTEL_CLAIM_ORDER_PROBE", "second", "linux");
			expect($otelEnv("OTEL_CLAIM_ORDER_PROBE")).toBe("first");
		});

		it("folds a lowercase name to its upper-case form on win32 only", () => {
			expect(claimOmpOtelEnvFileEntry("otel_claim_win_probe", "win", "win32")).toBe(true);
			expect(Bun.env.otel_claim_win_probe).toBeUndefined();
			expect(Bun.env.OTEL_CLAIM_WIN_PROBE).toBeUndefined();
			withOmpOtelEnv(() => {
				expect(process.env.OTEL_CLAIM_WIN_PROBE).toBe("win");
			});
			expect(process.env.OTEL_CLAIM_WIN_PROBE).toBeUndefined();
		});
	});

	describe("withOmpOtelEnv", () => {
		it("exposes file values only inside the callback and returns its result", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_A", "a", "linux");
			expect(process.env.OTEL_WINDOW_PROBE_A).toBeUndefined();
			const result = withOmpOtelEnv(() => {
				expect(process.env.OTEL_WINDOW_PROBE_A).toBe("a");
				return 42;
			});
			expect(result).toBe(42);
			expect(process.env.OTEL_WINDOW_PROBE_A).toBeUndefined();
		});

		it("removes the values when the callback throws", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_THROW", "t", "linux");
			expect(() =>
				withOmpOtelEnv(() => {
					expect(process.env.OTEL_WINDOW_PROBE_THROW).toBe("t");
					throw new Error("boom");
				}),
			).toThrow("boom");
			expect(process.env.OTEL_WINDOW_PROBE_THROW).toBeUndefined();
		});

		it("restores a name that was set to the empty string instead of deleting it", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_EMPTY", "file", "linux");
			process.env.OTEL_WINDOW_PROBE_EMPTY = "";
			try {
				withOmpOtelEnv(() => {
					expect(process.env.OTEL_WINDOW_PROBE_EMPTY).toBe("file");
				});
				expect(process.env.OTEL_WINDOW_PROBE_EMPTY).toBe("");
			} finally {
				delete process.env.OTEL_WINDOW_PROBE_EMPTY;
			}
		});

		it("never overwrites or deletes a name that is already set", () => {
			claimOmpOtelEnvFileEntry("OTEL_WINDOW_PROBE_SET", "file", "linux");
			process.env.OTEL_WINDOW_PROBE_SET = "live";
			try {
				withOmpOtelEnv(() => {
					expect(process.env.OTEL_WINDOW_PROBE_SET).toBe("live");
				});
				expect(process.env.OTEL_WINDOW_PROBE_SET).toBe("live");
			} finally {
				delete process.env.OTEL_WINDOW_PROBE_SET;
			}
		});
	});
});

describe("PI_CONFIG_FILES provenance", () => {
	/** Operator-only names besides PI_CONFIG_FILES/OMP_CONFIG_FILES: each selects an omp directory. */
	const DIR_SELECTING_NAMES = [
		"PI_CODING_AGENT_DIR",
		"OMP_CODING_AGENT_DIR",
		"PI_CONFIG_DIR",
		"OMP_CONFIG_DIR",
		"PI_PROFILE",
		"OMP_PROFILE",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"PI_NATIVES_DIR",
		"OMP_NATIVES_DIR",
	] as const;

	interface ConfigFilesProbe {
		home: string;
		pi: string | null;
		omp: string | null;
		/** The directory-selecting names as the loaded process sees them. */
		env: Record<string, string | null>;
		agentDir: string;
		configRoot: string;
		pluginsDir: string;
		nativesDir: string;
		activeProfile: string | null;
	}

	// The loader runs at module load, so each case is a fresh process with temp HOME, agent dir and
	// project. `autoload` keeps Bun's own dotenv autoload of the project `.env` on (the real launch
	// path); without it only omp's loader reads the file.
	async function runProbe(options: {
		/** Project `.env` contents; `{home}` expands to the temp HOME. */
		project: string;
		agent?: string;
		/** Launch environment overrides; `{home}` in values expands to the temp HOME. */
		launch?: Record<string, string | undefined>;
		/** Extra files to create, keyed by path relative to the temp HOME. */
		files?: Record<string, string>;
		/**
		 * Code run after `dirs` loads and before `env` does, the order `cli.ts` uses
		 * (`setProfile(...)` before anything imports `env`). Without it `env` loads first.
		 */
		cli?: string;
		autoload: boolean;
	}): Promise<ConfigFilesProbe> {
		const home = fs.realpathSync(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-utils-config-files-")));
		tempDirs.push(home);
		const expand = (value: string) => value.replaceAll("{home}", home);
		const agentDir = path.join(home, "agent");
		const cwd = path.join(home, "project");
		await Bun.write(path.join(cwd, ".env"), expand(options.project));
		await Bun.write(path.join(agentDir, ".env"), options.agent ?? "");
		for (const [file, content] of Object.entries(options.files ?? {})) {
			await Bun.write(path.join(home, file), content);
		}
		const launch: Record<string, string | undefined> = {};
		for (const [name, value] of Object.entries(options.launch ?? {})) {
			launch[name] = value === undefined ? undefined : expand(value);
		}
		const envModulePath = path.join(import.meta.dir, "..", "src", "env.ts");
		const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
		const output = [
			`const names = ${JSON.stringify(DIR_SELECTING_NAMES)};`,
			"process.stdout.write(JSON.stringify({",
			"  pi: process.env.PI_CONFIG_FILES ?? null,",
			"  omp: process.env.OMP_CONFIG_FILES ?? null,",
			"  env: Object.fromEntries(names.map(name => [name, process.env[name] ?? null])),",
			"  agentDir: getAgentDir(),",
			"  configRoot: getConfigRootDir(),",
			"  pluginsDir: getPluginsDir(),",
			"  nativesDir: getNativesDir(),",
			"  activeProfile: getActiveProfile() ?? null,",
			"}));",
		];
		const dirsImport = `import { getActiveProfile, getAgentDir, getConfigRootDir, getNativesDir, getPluginsDir, resolveProfileEnv, setProfile } from ${JSON.stringify(dirsModulePath)};`;
		const script = (
			options.cli === undefined
				? [`import ${JSON.stringify(envModulePath)};`, dirsImport, ...output]
				: // Dynamic `env` import on purpose: it must load after `dirs` and the CLI's profile step.
					[dirsImport, options.cli, `await import(${JSON.stringify(envModulePath)});`, ...output]
		).join("\n");
		const flags = options.autoload ? [] : ["--no-env-file"];
		const proc = Bun.spawn([process.execPath, "--no-install", ...flags, "--eval", script], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: agentDir,
				...DIR_RESOLUTION_ENV_RESET,
				OMP_CODING_AGENT_DIR: undefined,
				OMP_CONFIG_DIR: undefined,
				PI_NATIVES_DIR: undefined,
				OMP_NATIVES_DIR: undefined,
				NODE_ENV: undefined,
				PI_CONFIG_FILES: undefined,
				OMP_CONFIG_FILES: undefined,
				...launch,
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
		return { ...JSON.parse(stdout), home };
	}

	/** Project `.env` that points every PI_ and OMP_ directory-selecting name into the workspace. */
	const HOSTILE_DIRS_ENV = [
		"PI_CODING_AGENT_DIR={home}/evil-agent",
		"PI_CONFIG_DIR=.evil",
		"PI_PROFILE=evil",
		"XDG_DATA_HOME={home}/evil-xdg",
		"XDG_STATE_HOME={home}/evil-xdg",
		"XDG_CACHE_HOME={home}/evil-xdg",
		"PI_NATIVES_DIR={home}/evil-natives",
		"OMP_CODING_AGENT_DIR={home}/evil-agent",
		"OMP_CONFIG_DIR=.evil",
		"OMP_PROFILE=evil",
		"",
	].join("\n");
	/** The hostile agent dir's `.env` (loaded if the redirect took) and the hostile XDG app root. */
	const HOSTILE_DIRS_FILES = {
		"evil-agent/.env": "PI_CONFIG_FILES=evil-agent.yml\n",
		"evil-xdg/omp/.keep": "",
	};

	for (const autoload of [false, true]) {
		const mode = autoload ? "with Bun's dotenv autoload" : "without Bun's dotenv autoload";

		it.skipIf(process.platform === "win32")(
			`never takes the value from the project .env (${mode})`,
			async () => {
				const pi = await runProbe({ project: "PI_CONFIG_FILES=evil.yml\n", autoload });
				expect({ pi: pi.pi, omp: pi.omp }).toEqual({ pi: null, omp: null });
				const omp = await runProbe({ project: "OMP_CONFIG_FILES=evil.yml\n", autoload });
				expect({ pi: omp.pi, omp: omp.omp }).toEqual({ pi: null, omp: null });
			},
			20_000,
		);

		it.skipIf(process.platform === "win32")(
			`keeps a launch-environment value over the project .env (${mode})`,
			async () => {
				const result = await runProbe({
					project: "PI_CONFIG_FILES=evil.yml\n",
					launch: { PI_CONFIG_FILES: "operator.yml" },
					autoload,
				});
				expect(result.pi).toBe("operator.yml");
			},
			20_000,
		);

		it.skipIf(process.platform === "win32")(
			`takes the agent-dir .env value over the project .env (${mode})`,
			async () => {
				const result = await runProbe({
					project: "PI_CONFIG_FILES=evil.yml\n",
					agent: "PI_CONFIG_FILES=agent.yml\n",
					autoload,
				});
				expect(result.pi).toBe("agent.yml");
			},
			20_000,
		);

		it.skipIf(process.platform === "win32")(
			`never lets the project .env choose omp's directories (${mode})`,
			async () => {
				const result = await runProbe({
					project: HOSTILE_DIRS_ENV,
					files: HOSTILE_DIRS_FILES,
					launch: { PI_CODING_AGENT_DIR: undefined },
					autoload,
				});
				const root = path.join(result.home, ".omp");
				expect(result.env).toEqual(Object.fromEntries(DIR_SELECTING_NAMES.map(name => [name, null])));
				expect(result.agentDir).toBe(path.join(root, "agent"));
				expect(result.configRoot).toBe(root);
				expect(result.pluginsDir).toBe(path.join(root, "plugins"));
				expect(result.nativesDir).toBe(path.join(root, "natives"));
				// The redirected agent dir's `.env` was never located.
				expect(result.pi).toBeNull();
			},
			20_000,
		);

		it.skipIf(process.platform === "win32")(
			`keeps launch-environment directory names over the project .env (${mode})`,
			async () => {
				const result = await runProbe({
					project: HOSTILE_DIRS_ENV,
					files: { ...HOSTILE_DIRS_FILES, "op-xdg/omp/.keep": "" },
					launch: {
						PI_CODING_AGENT_DIR: undefined,
						PI_CONFIG_DIR: ".op",
						XDG_DATA_HOME: "{home}/op-xdg",
						XDG_STATE_HOME: "{home}/op-xdg",
						XDG_CACHE_HOME: "{home}/op-xdg",
						PI_NATIVES_DIR: "{home}/op-natives",
					},
					autoload,
				});
				const home = result.home;
				expect(result.env).toMatchObject({
					PI_CODING_AGENT_DIR: null,
					PI_CONFIG_DIR: ".op",
					PI_PROFILE: null,
					XDG_DATA_HOME: path.join(home, "op-xdg"),
					PI_NATIVES_DIR: path.join(home, "op-natives"),
				});
				expect(result.agentDir).toBe(path.join(home, ".op", "agent"));
				expect(result.configRoot).toBe(path.join(home, ".op"));
				// XDG only redirects the default (non-overridden) agent dir.
				expect(result.pluginsDir).toBe(path.join(home, "op-xdg", "omp", "plugins"));
				expect(result.nativesDir).toBe(path.join(home, "op-natives"));
			},
			20_000,
		);

		it.skipIf(process.platform === "win32")(
			`keeps a launch-environment agent dir over the project .env (${mode})`,
			async () => {
				const result = await runProbe({
					project: HOSTILE_DIRS_ENV,
					files: HOSTILE_DIRS_FILES,
					launch: { PI_CODING_AGENT_DIR: "{home}/op-agent" },
					autoload,
				});
				expect(result.env.PI_CODING_AGENT_DIR).toBe(path.join(result.home, "op-agent"));
				expect(result.agentDir).toBe(path.join(result.home, "op-agent"));
			},
			20_000,
		);

		it.skipIf(process.platform === "win32")(
			`keeps a launch-environment profile over the project .env (${mode})`,
			async () => {
				const result = await runProbe({
					project: "PI_PROFILE=evil\nOMP_PROFILE=evil\n",
					launch: { PI_CODING_AGENT_DIR: undefined, OMP_PROFILE: "work" },
					autoload,
				});
				expect(result.env).toMatchObject({ OMP_PROFILE: "work", PI_PROFILE: null });
				expect(result.configRoot).toBe(path.join(result.home, ".omp", "profiles", "work"));
			},
			20_000,
		);

		it.skipIf(process.platform === "win32")(
			`never lets the project .env pick the profile the CLI activates (${mode})`,
			async () => {
				const result = await runProbe({
					project: "OMP_PROFILE=evil\nPI_PROFILE=evil2\n",
					launch: { PI_CODING_AGENT_DIR: undefined },
					cli: "setProfile(resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE));",
					autoload,
				});
				const root = path.join(result.home, ".omp");
				expect(result.activeProfile).toBeNull();
				expect(result.configRoot).toBe(root);
				expect(result.agentDir).toBe(path.join(root, "agent"));
			},
			20_000,
		);

		it.skipIf(process.platform === "win32")(
			`keeps an explicit --profile over a project .env profile (${mode})`,
			async () => {
				const result = await runProbe({
					project: "OMP_PROFILE=evil\n",
					launch: { PI_CODING_AGENT_DIR: undefined },
					cli: 'setProfile("work");',
					autoload,
				});
				const root = path.join(result.home, ".omp", "profiles", "work");
				expect(result.activeProfile).toBe("work");
				expect(result.env.OMP_PROFILE).toBe("work");
				expect(result.configRoot).toBe(root);
				expect(result.agentDir).toBe(path.join(root, "agent"));
			},
			20_000,
		);
	}

	/** Runs `script` with Bun's autoload in a project whose `.env` is `project`, under a temp HOME. */
	async function runInProject(project: string, script: string, env: Record<string, string> = {}) {
		const home = fs.realpathSync(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-utils-config-files-")));
		tempDirs.push(home);
		const cwd = path.join(home, "project");
		await Bun.write(path.join(cwd, ".env"), project);
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				...DIR_RESOLUTION_ENV_RESET,
				PI_CODING_AGENT_DIR: undefined,
				OMP_CODING_AGENT_DIR: undefined,
				OMP_CONFIG_DIR: undefined,
				...env,
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
		return { home, stdout };
	}

	/** Starts a worker that imports `dirs` and reports its profile, after `before` ran on the main thread. */
	async function runWorkerProbe(before: string, workerOptions: string) {
		const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
		const scratch = fs.realpathSync(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-utils-worker-")));
		tempDirs.push(scratch);
		const workerPath = path.join(scratch, "worker.ts");
		await Bun.write(
			workerPath,
			[
				`import { getActiveProfile, getConfigRootDir } from ${JSON.stringify(dirsModulePath)};`,
				"postMessage({ active: getActiveProfile() ?? null, root: getConfigRootDir() });",
			].join("\n"),
		);
		const { home, stdout } = await runInProject(
			"OMP_PROFILE=evil\n",
			[
				before.replaceAll("{dirs}", JSON.stringify(dirsModulePath)),
				`const worker = new Worker(${JSON.stringify(workerPath)}${workerOptions});`,
				"worker.onmessage = event => { process.stdout.write(JSON.stringify(event.data)); worker.terminate(); };",
			].join("\n"),
		);
		return { home, report: JSON.parse(stdout) as { active: string | null; root: string } };
	}

	it.skipIf(process.platform === "win32")(
		"keeps the main thread's --profile in a worker when the project .env names another profile",
		async () => {
			// omp's worker spawn path: options given, so the worker inherits the main thread's live env.
			const { home, report } = await runWorkerProbe(
				'import { setProfile } from {dirs};\nsetProfile("work");',
				', { type: "module" }',
			);
			expect(report).toEqual({ active: "work", root: path.join(home, ".omp", "profiles", "work") });
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"never lets the project .env pick a worker thread's profile",
		async () => {
			// No options and a main thread that never loaded pi-utils: Bun starts the worker from a fresh
			// dotenv autoload, so the worker scrubs the autoloaded profile itself.
			const { home, report } = await runWorkerProbe("", "");
			expect(report).toEqual({ active: null, root: path.join(home, ".omp") });
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"loads when the working directory no longer exists",
		async () => {
			const dirsModulePath = path.join(import.meta.dir, "..", "src", "dirs.ts");
			const { home, stdout } = await runInProject(
				"",
				[
					'import * as fs from "node:fs";',
					"const gone = fs.mkdtempSync(`${process.env.HOME}/gone-`);",
					"process.chdir(gone);",
					"fs.rmdirSync(gone);",
					// Dynamic on purpose: `dirs` must first load after the cwd is gone.
					`const dirs = await import(${JSON.stringify(dirsModulePath)});`,
					"process.stdout.write(dirs.getConfigRootDir());",
				].join("\n"),
				{ XDG_CACHE_HOME: "/tmp/xdg-cache" },
			);
			expect(stdout).toBe(path.join(home, ".omp"));
		},
		20_000,
	);
});
