import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const temporaryDirectories: string[] = [];
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("terminal output guard", () => {
	it.skipIf(process.platform === "win32")(
		"follows logger rotation for both descriptors and stops redirecting after release",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-output-rotation-"));
			temporaryDirectories.push(root);
			const logs = path.join(root, "logs");
			fs.mkdirSync(logs);
			const chunks: Buffer[] = [];
			const terminalExited = Promise.withResolvers<void>();
			const child = Bun.spawn(
				[
					process.execPath,
					"--preload",
					path.resolve(import.meta.dir, "fixtures/logger-fixed-date-preload.ts"),
					path.resolve(import.meta.dir, "fixtures/terminal-output-rotation-probe.ts"),
					logs,
					"2026-09-23T17:00:00Z",
					"2026-09-24T17:00:00Z",
				],
				{
					env: {
						...process.env,
						BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
						OMP_LOGGER_TEST_NOW: "2026-09-22T17:00:00Z",
						TZ: "Asia/Singapore",
					},
					terminal: {
						data(_terminal, data) {
							chunks.push(Buffer.from(data));
						},
						exit() {
							terminalExited.resolve();
						},
					},
					timeout: 10_000,
				},
			);
			try {
				expect(await child.exited).toBe(0);
				await terminalExited.promise;
				const output = Buffer.concat(chunks).toString("utf8");
				expect(output).toContain("stdout-restored");
				expect(output).toContain("stderr-restored");
				expect(output).toContain('"isolated":true');
				const first = fs.readFileSync(path.join(logs, `omp.2026-09-23.${child.pid}.log`), "utf8");
				const second = fs.readFileSync(path.join(logs, `omp.2026-09-24.${child.pid}.log`), "utf8");
				expect(first).toContain("startup-day-marker");
				expect(first).toContain("startup-stdout-marker");
				expect(first).not.toContain("next-day-marker");
				expect(second).toContain("next-day-marker");
				expect(second).toContain("next-stdout-marker");
				expect(second).not.toContain("stderr-restored");
				const third = fs.readFileSync(path.join(logs, `omp.2026-09-25.${child.pid}.log`), "utf8");
				expect(third).toContain("third-day record");
				expect(third).not.toContain("stderr-restored");
			} finally {
				child.terminal?.close();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps descriptors isolated across nested suppressions until the final release",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-output-refcount-"));
			temporaryDirectories.push(root);
			const state = path.join(root, "state.txt");
			fs.writeFileSync(state, "");
			const chunks: Buffer[] = [];
			const terminalExited = Promise.withResolvers<void>();
			const child = Bun.spawn(
				[process.execPath, path.resolve(import.meta.dir, "fixtures/guard-refcount-probe.ts"), state],
				{
					env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
					terminal: {
						data(_terminal, data) {
							chunks.push(Buffer.from(data));
						},
						exit() {
							terminalExited.resolve();
						},
					},
					timeout: 10_000,
				},
			);
			try {
				expect(await child.exited).toBe(0);
				await terminalExited.promise;
				const output = Buffer.concat(chunks).toString("utf8");
				expect(output).toContain("after-restore");
				const lines = Object.fromEntries(
					fs
						.readFileSync(state, "utf8")
						.split("\n")
						.filter(Boolean)
						.map(line => line.split("=") as [string, string]),
				);
				expect(lines["shared"]).toBe("true");
				expect(lines["isolated-after-first-release"]).toBe("true");
				expect(lines["restored-after-final-release"]).toBe("true");
			} finally {
				child.terminal?.close();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"rotates the active log and re-points fd 1 when inherited writes overflow it",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-output-overflow-"));
			temporaryDirectories.push(root);
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "fixtures/sink-external-rotation-probe.ts"),
					root,
					path.join(root, "state.txt"),
				],
				{
					env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
					terminal: {},
					timeout: 10_000,
				},
			);
			try {
				expect(await child.exited).toBe(0);
				expect(fs.readFileSync(path.join(root, "state.txt"), "utf8")).toContain("isolated=true");
				const files = fs
					.readdirSync(root)
					.filter(name => name.startsWith("omp."))
					.sort();
				expect(files.length).toBeGreaterThanOrEqual(2);
				const first = fs.readFileSync(path.join(root, files[0]), "utf8");
				const next = fs.readFileSync(path.join(root, files.at(-1)!), "utf8");
				expect(first).toContain("startup record");
				expect(first.length).toBeGreaterThan(8192);
				expect(next).toContain("post-junk record");
				expect(next).toContain("post-rotation-stdout-marker");
			} finally {
				child.terminal?.close();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"isolates writes through a bound process.stdout.write cached before suppression",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-write-isolation-"));
			temporaryDirectories.push(root);
			const chunks: Buffer[] = [];
			const terminalExited = Promise.withResolvers<void>();
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "fixtures/bound-write-isolation-probe.ts"),
					root,
					path.join(root, "state.txt"),
				],
				{
					env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
					terminal: {
						data(_terminal, data) {
							chunks.push(Buffer.from(data));
						},
						exit() {
							terminalExited.resolve();
						},
					},
					timeout: 10_000,
				},
			);
			try {
				expect(await child.exited).toBe(0);
				await terminalExited.promise;
				const state = fs.readFileSync(path.join(root, "state.txt"), "utf8");
				expect(state).toContain("suppressed=true");
				const redirected = fs.readFileSync(path.join(root, "bound-writer.log"), "utf8");
				expect(redirected).toContain("bound-write-marker");
				const output = Buffer.concat(chunks).toString("utf8");
				expect(output).not.toContain("bound-write-marker");
			} finally {
				child.kill();
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"does not leak saved or render terminal descriptors into exec'd children",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloexec-inheritance-"));
			temporaryDirectories.push(root);
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "fixtures/cloexec-inheritance-probe.ts"),
					path.join(root, "state.txt"),
				],
				{
					env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
					terminal: {},
					timeout: 10_000,
				},
			);
			try {
				expect(await child.exited).toBe(0);
				const state = fs.readFileSync(path.join(root, "state.txt"), "utf8");
				expect(state).toContain("suppressed=true");
				expect(state).toContain("leaked=0");
			} finally {
				child.kill();
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"a callback-free redirected write survives an unwritable log target",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "redirect-write-error-"));
			temporaryDirectories.push(root);
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "fixtures/redirect-write-error-probe.ts"),
					path.join(root, "state.txt"),
				],
				{
					env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
					terminal: {},
					timeout: 10_000,
				},
			);
			try {
				expect(await child.exited).toBe(0);
				const state = fs.readFileSync(path.join(root, "state.txt"), "utf8");
				expect(state).toContain("suppressed=true");
				expect(state).toContain("survived=true ret=false");
				expect(state).toContain("error-delivered=true");
				expect(state).toContain("callback-error=true");
			} finally {
				child.kill();
			}
		},
	);
});
