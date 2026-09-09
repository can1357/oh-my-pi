import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$envExact,
	filterProcessEnv,
	getDbBusyTimeoutMs,
	parseEnvFile,
	setInteractiveHost,
} from "@oh-my-pi/pi-utils/env";

const tempDirs: string[] = [];
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
			NO_SPACE: "http://host/path#frag",
		});
	});

	it("keeps escaped quotes inside quoted values literal, matching Bun", () => {
		const filePath = writeTempEnv(['JSON="{\\"a\\":1}"', "SINGLE='it\\'s'"].join("\n"));

		expect(parseEnvFile(filePath)).toEqual({
			JSON: '{\\"a\\":1}',
			SINGLE: "it\\'s",
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
	it("returns the value for an exact-case key", () => {
		const env = { OPENCODE_API_KEY: "sk-live", PATH: "/usr/bin" };
		expect($envExact("OPENCODE_API_KEY", env)).toBe("sk-live");
	});

	it("returns undefined for an absent name", () => {
		expect($envExact("MISSING_VAR", { PATH: "/usr/bin" })).toBeUndefined();
	});

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
