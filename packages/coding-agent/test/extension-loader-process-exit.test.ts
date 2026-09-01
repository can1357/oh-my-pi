/**
 * Regression test for #3680: third-party extension / hook modules that call
 * `process.exit()` at the top level must not terminate the host OMP process.
 *
 * The harness intercepts the load via `withHostGuard`; this test pins that the
 * intercepted error surfaces as a per-module load failure (so OMP keeps going)
 * instead of crashing the test runner.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { loadHooks } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/loader";
import { ExtensionExitError, withHostGuard } from "@oh-my-pi/pi-coding-agent/extensibility/utils";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("extension/hook loader process.exit guard (#3680)", () => {
	let project: TempDir | undefined;

	beforeEach(() => {
		project = TempDir.createSync("@omp-exit-guard-");
	});

	afterEach(() => {
		project?.removeSync();
		project = undefined;
	});

	const writeModule = (relativePath: string, source: string): string => {
		expect(project).toBeDefined();
		const filePath = path.join(project!.path(), relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, source);
		return filePath;
	};

	const runProbe = async (probe: string, preload: string[] = []) => {
		const preloadArgs = preload.flatMap(file => ["--preload", file]);
		const proc = Bun.spawn([process.execPath, ...preloadArgs, "-e", probe], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		// Real process signals cannot use fake timers; this only bounds a wedged child.
		const watchdog = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 2000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return { exitCode, stdout, stderr };
		} finally {
			clearTimeout(watchdog);
		}
	};

	const runGuardedShutdownProbe = (trigger: "sigint" | "fatal") => {
		const action =
			trigger === "sigint"
				? 'process.kill(process.pid, "SIGINT");'
				: 'void Promise.reject(new Error("probe fatal"));';
		return runProbe(`
import { postmortem } from "@oh-my-pi/pi-utils";
import { withHostGuard } from "@oh-my-pi/pi-coding-agent/extensibility/utils";

postmortem.register("probe-cleanup", reason => {
	process.stdout.write(\`cleanup:\${reason}\\n\`);
});
void withHostGuard(async () => {
	process.stdout.write("guard-active\\n");
	${action}
	// Keep the real child event loop alive so the platform can deliver SIGINT.
	await Bun.sleep(10_000);
});
`);
	};

	it("converts extension and hook exits into load errors without blocking siblings", async () => {
		const topLevelExtension = writeModule("top-level-exit-extension.ts", "process.exit(0)\n");
		const factoryExtension = writeModule(
			"factory-exit-extension.ts",
			"export default function(pi) { process.exit(31); }\n",
		);
		const reallyExitExtension = writeModule(
			"factory-really-exit-extension.ts",
			"export default function(pi) { process.reallyExit(33); }\n",
		);
		const goodExtension = writeModule(
			"good-extension.ts",
			"export default function(pi) { pi.registerCommand('ok', { handler: async () => {} }); }\n",
		);
		const topLevelHook = writeModule("top-level-exit-hook.ts", "process.exit(42)\n");
		const factoryHook = writeModule("factory-exit-hook.ts", "export default function(pi) { process.exit(32); }\n");
		const cwd = project!.path();
		const originalExit = process.exit;
		const originalReallyExit = process.reallyExit;

		const extensionResult = await loadExtensions(
			[topLevelExtension, factoryExtension, reallyExitExtension, goodExtension],
			cwd,
		);
		const hookResult = await loadHooks([topLevelHook, factoryHook], cwd);

		expect(process.exit).toBe(originalExit);
		expect(process.reallyExit).toBe(originalReallyExit);
		expect(extensionResult.extensions.map(extension => path.basename(extension.path))).toEqual(["good-extension.ts"]);
		expect(
			extensionResult.errors.map(({ path: modulePath, error }) => [
				modulePath,
				error.match(/process\.(?:exit|reallyExit)\(\d+\)/)?.[0],
			]),
		).toEqual([
			[topLevelExtension, "process.exit(0)"],
			[factoryExtension, "process.exit(31)"],
			[reallyExitExtension, "process.reallyExit(33)"],
		]);
		expect(hookResult.hooks).toEqual([]);
		expect(
			hookResult.errors.map(({ path: modulePath, error }) => [modulePath, error.match(/process\.exit\(\d+\)/)?.[0]]),
		).toEqual([
			[topLevelHook, "process.exit(42)"],
			[factoryHook, "process.exit(32)"],
		]);
	});

	it("restores process.exit after a synchronous throw inside the guarded callback", async () => {
		const originalExit = process.exit;

		await expect(
			withHostGuard(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(process.exit).toBe(originalExit);
	});

	it("raises ExtensionExitError when the guarded callback calls process.exit", async () => {
		const originalExit = process.exit;

		await expect(withHostGuard(async () => process.exit(7))).rejects.toBeInstanceOf(ExtensionExitError);

		expect(process.exit).toBe(originalExit);
	});

	it("keeps postmortem.quit behind the extension exit guard", async () => {
		const { exitCode, stdout, stderr } = await runProbe(`
import { postmortem } from "@oh-my-pi/pi-utils";
import { withHostGuard } from "@oh-my-pi/pi-coding-agent/extensibility/utils";

try {
	await withHostGuard(() => postmortem.quit(37));
} catch (err) {
	process.stdout.write(\`\${err instanceof Error ? err.name : "UnknownError"}:\${String(err)}\\n\`);
}
`);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("ExtensionExitError:ExtensionExitError: Module called process.exit(37)");
		expect(stderr).toBe("");
	});

	it("lets host SIGINT exit once while a guarded callback remains pending", async () => {
		const { exitCode, stdout, stderr } = await runGuardedShutdownProbe("sigint");

		expect(exitCode).toBe(130);
		expect(stdout).toBe("guard-active\ncleanup:sigint\n");
		expect(stderr).not.toContain("[Unhandled Rejection]");
		expect(stderr).not.toContain("ExtensionExitError");
	});

	it("lets fatal cleanup exit once while a guarded callback remains pending", async () => {
		const { exitCode, stdout, stderr } = await runGuardedShutdownProbe("fatal");

		expect(exitCode).toBe(1);
		expect(stdout).toBe("guard-active\ncleanup:unhandled_rejection\n");
		expect(stderr.match(/\[Unhandled Rejection\]/g)).toHaveLength(1);
		expect(stderr).toContain("Error: probe fatal");
		expect(stderr).not.toContain("ExtensionExitError");
	});

	it("exits cleanly on host SIGHUP when postmortem initialized inside a guard window (#7393)", async () => {
		// Mirror the shipped bundle: postmortem's exit primitive is first resolved
		// while withHostGuard has replaced process.reallyExit with a throwing stub.
		// A preload swaps reallyExit before the entry's static postmortem import
		// evaluates; the entry then restores it (as the guard's finally does) and
		// self-SIGHUPs (the TUI terminal-disconnect path). A lazily resolved exit
		// primitive must pick up the restored native reallyExit and exit 129
		// instead of looping on ExtensionExitError.
		const preload = writeModule(
			"guard-init-preload.ts",
			"globalThis.__ompNativeReallyExit = process.reallyExit;\n" +
				'process.reallyExit = (() => { throw new Error("guarded during init"); });\n',
		);
		const { exitCode, stdout, stderr } = await runProbe(
			`
import { postmortem } from "@oh-my-pi/pi-utils";
postmortem.register("probe", reason => process.stdout.write(\`cleanup:\${reason}\\n\`));
process.reallyExit = globalThis.__ompNativeReallyExit;
process.stdout.write("armed\\n");
process.kill(process.pid, "SIGHUP");
// Keep the real child event loop alive so the platform can deliver SIGHUP;
// real signal delivery cannot be driven by fake timers.
await Bun.sleep(10_000);
`,
			[preload],
		);

		expect(exitCode).toBe(129);
		expect(stdout).toBe("armed\ncleanup:sighup\n");
		expect(stderr).not.toContain("ExtensionExitError");
		expect(stderr).not.toContain("Unhandled Rejection");
	});

	it("only the outermost guard restores process.exit when guards nest", async () => {
		const originalExit = process.exit;

		await withHostGuard(async () => {
			const outer = process.exit;
			expect(outer).not.toBe(originalExit);

			await withHostGuard(async () => {
				expect(process.exit).toBe(outer);
			});

			expect(process.exit).toBe(outer);
		});

		expect(process.exit).toBe(originalExit);
	});
});
