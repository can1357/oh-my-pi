import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileType } from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { GlobTool } from "../../src/tools/glob";
import { findUniqueWorkspaceSuffixWithGlobForTest } from "../../src/tools/path-utils";
import { ToolAbortError } from "../../src/tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

function createSession(cwd = process.cwd()): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

const ROOT_SEARCH_ERROR = "Searching from root directory '/' is not allowed";

async function expectRootSearchRejected(searchPath: string): Promise<void> {
	const tool = new GlobTool(createSession());
	let thrown: unknown;
	try {
		await tool.execute("glob-root-regression", { path: searchPath });
	} catch (error) {
		thrown = error;
	}

	if (!(thrown instanceof Error)) {
		throw new Error(`Expected glob path ${JSON.stringify(searchPath)} to reject`);
	}

	expect(thrown).toBeInstanceOf(ToolError);
	expect(thrown.message).toBe(ROOT_SEARCH_ERROR);
}

describe("GlobTool.execute", () => {
	test.each(["/", "//"])("rejects bare root search path %s", async searchPath => {
		await expectRootSearchRejected(searchPath);
	});

	test("retrieves every match when following the result-limit retry hint", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "glob-limit-"));
		const filenames = Array.from({ length: 230 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`);
		try {
			await Promise.all(filenames.map(filename => Bun.write(path.join(cwd, filename), "")));
			const tool = new GlobTool(createSession(cwd));
			const initial = await tool.execute("glob-limit-initial", { path: "*.txt", gitignore: false });
			expect(initial.details?.files).toHaveLength(200);

			const hint = formatOutputNotice(initial.details?.meta);
			const suggestedLimit = /Use limit=(\d+) for more/.exec(hint)?.[1];
			expect(suggestedLimit).toBeDefined();
			const retry = await tool.execute("glob-limit-retry", {
				path: "*.txt",
				limit: Number(suggestedLimit),
				gitignore: false,
			});
			expect(new Set(retry.details?.files)).toEqual(new Set(filenames));
		} finally {
			await removeWithRetries(cwd);
		}
	});

	test("rejects a large limit instead of collecting unbounded matches", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "glob-limit-large-"));
		try {
			await Bun.write(path.join(cwd, "a.txt"), "");
			await expect(
				new GlobTool(createSession(cwd)).execute("glob-limit-large", {
					path: "*.txt",
					limit: 1_000_000,
					gitignore: false,
				}),
			).rejects.toThrow(/Limit cannot exceed 1000;.*partition the pattern/);
		} finally {
			await removeWithRetries(cwd);
		}
	});

	test("rejects a caller abort during preparation without launching a native scan", async () => {
		const controller = new AbortController();
		const statStarted = Promise.withResolvers<void>();
		const releaseStat = Promise.withResolvers<void>();
		const statSettled = Promise.withResolvers<void>();
		let nativeStarted = false;
		const tool = new GlobTool(createSession(), {
			stat: async () => {
				statStarted.resolve();
				try {
					await releaseStat.promise;
					throw new Error("Released blocked stat");
				} finally {
					statSettled.resolve();
				}
			},
			nativeGlob: async () => {
				nativeStarted = true;
				return { matches: [], totalMatches: 0 };
			},
		});
		const execution = tool.execute("glob-preparation-abort", { path: "." }, controller.signal);

		await statStarted.promise;
		try {
			controller.abort();
			await expect(execution).rejects.toThrow("Aborted");
			expect(nativeStarted).toBe(false);
		} finally {
			releaseStat.resolve();
			await statSettled.promise;
		}
		expect(nativeStarted).toBe(false);
	});

	test("does not finish a timeout until the native scan has stopped", async () => {
		const started = Promise.withResolvers<void>();
		const timeoutObserved = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let nativeSettled = false;
		const tool = new GlobTool(createSession(), {
			timeoutMs: 100,
			nativeGlob: async options => {
				if (!(options.signal instanceof AbortSignal)) {
					started.resolve();
					timeoutObserved.resolve();
					throw new Error("Missing native cancellation signal");
				}
				const nativeSignal = options.signal;
				nativeSignal.addEventListener("abort", () => timeoutObserved.resolve(), { once: true });
				started.resolve();
				await timeoutObserved.promise;
				await release.promise;
				nativeSettled = true;
				throw new Error("GenericFailure, Aborted: Timeout");
			},
		});

		const execution = tool.execute("glob-timeout-cleanup", { path: "." });
		let executionSettled = false;
		void execution.then(
			() => {
				executionSettled = true;
			},
			() => {
				executionSettled = true;
			},
		);
		await started.promise;
		await timeoutObserved.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(executionSettled).toBe(false);

		release.resolve();
		const result = await execution;

		expect(nativeSettled).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Glob timed out after 0.1s");
	});

	test("waits for every native scan to settle before rejecting an abort", async () => {
		const controller = new AbortController();
		const allStarted = Promise.withResolvers<void>();
		const allAborted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let startedCount = 0;
		let abortedCount = 0;
		let settledCount = 0;
		const tool = new GlobTool(createSession(), {
			timeoutMs: 5000,
			nativeGlob: async options => {
				if (!(options.signal instanceof AbortSignal)) throw new Error("Missing native cancellation signal");
				const nativeSignal = options.signal;
				const abortObserved = Promise.withResolvers<void>();
				nativeSignal.addEventListener(
					"abort",
					() => {
						abortedCount += 1;
						if (abortedCount === 2) allAborted.resolve();
						abortObserved.resolve();
					},
					{ once: true },
				);
				startedCount += 1;
				if (startedCount === 2) allStarted.resolve();
				await abortObserved.promise;
				await release.promise;
				settledCount += 1;
				throw new Error("GenericFailure, Aborted: Signal");
			},
		});
		const execution = tool.execute(
			"glob-abort-cleanup",
			{ path: `.; ${path.dirname(process.cwd())}` },
			controller.signal,
		);
		let executionSettled = false;
		void execution.then(
			() => {
				executionSettled = true;
			},
			() => {
				executionSettled = true;
			},
		);

		await allStarted.promise;
		controller.abort();
		await allAborted.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(executionSettled).toBe(false);

		release.resolve();
		await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
		expect(settledCount).toBe(2);
	});
	test("suffix recovery rejects a caller abort after native completion", async () => {
		const controller = new AbortController();
		const nativeCompleted = Promise.withResolvers<void>();
		const releaseResult = Promise.withResolvers<void>();
		const execution = findUniqueWorkspaceSuffixWithGlobForTest(
			"target.ts",
			"/workspace",
			controller.signal,
			async () => {
				nativeCompleted.resolve();
				await releaseResult.promise;
				return {
					matches: [{ path: "nested/target.ts", fileType: FileType.File }],
					totalMatches: 1,
				};
			},
		);

		await nativeCompleted.promise;
		controller.abort();
		releaseResult.resolve();
		await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
	});
});
