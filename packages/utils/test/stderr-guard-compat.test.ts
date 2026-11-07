import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isTerminalStderrSuppressed,
	restoreTerminalStderr,
	setStderrRedirectTarget,
	suppressTerminalStderr,
} from "../src/stderr-guard";
import * as utils from "../src/index";

const temporaryDirectories: string[] = [];

afterAll(() => {
	for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

describe("stderr-guard compatibility surface", () => {
	it("re-exports the 16.5.1 stderr-guard symbols from the package root", () => {
		expect(utils.suppressTerminalStderr).toBe(suppressTerminalStderr);
		expect(utils.restoreTerminalStderr).toBe(restoreTerminalStderr);
		expect(utils.setStderrRedirectTarget).toBe(setStderrRedirectTarget);
		expect(utils.isTerminalStderrSuppressed).toBe(isTerminalStderrSuppressed);
	});

	it.skipIf(process.platform === "win32")(
		"suppressTerminalStderr redirects fd 2 to the caller's path and restores it",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "stderr-guard-compat-"));
			temporaryDirectories.push(root);
			const chunks: Buffer[] = [];
			const terminalExited = Promise.withResolvers<void>();
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "fixtures/stderr-guard-compat-probe.ts"),
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
				expect(state).toContain("fd1-kept=true");
				expect(state).toContain("active=true");
				expect(state).toContain("restored=true");
				expect(state).toContain("unified=true");
				expect(state).toContain("delegated=true");
				expect(state).toContain("fd1-still-redirected=true");
				expect(state).toContain("still-suppressed-after-legacy-restore=true");
				expect(state).toContain("all-restored=true");
				const redirected = fs.readFileSync(path.join(root, "legacy-stderr.log"), "utf8");
				expect(redirected).toContain("legacy-marker");
				expect(redirected).not.toContain("stdout-live-marker");
				const output = Buffer.concat(chunks).toString("utf8");
				expect(output).toContain("stdout-live-marker");
				expect(output).toContain("post-restore-marker");
				expect(output).toContain("stdout-back-marker");
				expect(output).not.toContain("legacy-marker");
				expect(output).not.toContain("still-hidden-marker");
			} finally {
				child.kill();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"fd 2 follows log rotation while only the legacy guard is active",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-stderr-rotation-"));
			temporaryDirectories.push(root);
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "fixtures/legacy-stderr-rotation-probe.ts"),
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
				const state = fs.readFileSync(path.join(root, "state.txt"), "utf8");
				expect(state).toContain("has-active=true");
				expect(state).toContain("suppressed=true");
				expect(state).toContain("marker-followed-rotation=true");
			} finally {
				child.kill();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"the postmortem fatal-restore sequence returns fd 2 under legacy suppression",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-fatal-restore-"));
			temporaryDirectories.push(root);
			const chunks: Buffer[] = [];
			const terminalExited = Promise.withResolvers<void>();
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "fixtures/legacy-fatal-restore-probe.ts"),
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
				const output = Buffer.concat(chunks).toString("utf8");
				expect(output).toContain("fatal-report-marker");
				const redirected = fs.readFileSync(path.join(root, "legacy-stderr.log"), "utf8");
				expect(redirected).not.toContain("fatal-report-marker");
			} finally {
				child.kill();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"a legacy restore during unified suppression completes when the unified guard releases",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-deferred-restore-"));
			temporaryDirectories.push(root);
			const chunks: Buffer[] = [];
			const terminalExited = Promise.withResolvers<void>();
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "fixtures/legacy-deferred-restore-probe.ts"),
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
				expect(state).toContain("legacy=true");
				expect(state).toContain("unified=true");
				expect(state).toContain("suppressed-after=false");
				const output = Buffer.concat(chunks).toString("utf8");
				expect(output).toContain("after-tui-stop-marker");
				expect(output).not.toContain("during-tui-marker");
				const redirected = fs.readFileSync(path.join(root, "legacy-stderr.log"), "utf8");
				expect(redirected).toContain("during-tui-marker");
				expect(redirected).not.toContain("after-tui-stop-marker");
			} finally {
				child.kill();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"suppressTerminalStderr reports false when fd 2 was redirected before the unified guard",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-unshared-stderr-"));
			temporaryDirectories.push(root);
			const chunks: Buffer[] = [];
			const terminalExited = Promise.withResolvers<void>();
			const child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "fixtures/legacy-unshared-stderr-probe.ts"),
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
				expect(state).toContain("unified=true");
				// fd 2 never shared the terminal, so neither guard fenced it;
				// the default legacy call must not claim coverage it does not have.
				expect(state).toContain("default=false");
			} finally {
				child.kill();
			}
		},
	);

	it.skipIf(process.platform === "win32")("a legacy re-suppression cancels a queued release", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-resuppress-"));
		temporaryDirectories.push(root);
		const chunks: Buffer[] = [];
		const terminalExited = Promise.withResolvers<void>();
		const child = Bun.spawn(
			[
				process.execPath,
				path.resolve(import.meta.dir, "fixtures/legacy-resuppress-probe.ts"),
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
			expect(state).toContain("resuppressed=true");
			expect(state).toContain("still-suppressed-after-tui=true");
			expect(state).toContain("final-restored=true");
			const output = Buffer.concat(chunks).toString("utf8");
			expect(output).not.toContain("after-tui-stop-marker");
			expect(output).toContain("after-final-restore-marker");
			const redirected = fs.readFileSync(path.join(root, "legacy-stderr.log"), "utf8");
			expect(redirected).toContain("after-tui-stop-marker");
			expect(redirected).not.toContain("after-final-restore-marker");
		} finally {
			child.kill();
		}
	});
});
