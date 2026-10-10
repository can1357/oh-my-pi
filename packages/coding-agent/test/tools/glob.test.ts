import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { FileType } from "@oh-my-pi/pi-natives";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { GlobTool } from "../../src/tools/glob";
import type { GlobToolDetails } from "@oh-my-pi/pi-tui/tools/glob";
import { findUniqueWorkspaceSuffixWithGlobForTest } from "../../src/tools/path-utils";
import { ToolAbortError } from "../../src/tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";

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

describe("GlobTool hard-cap limit notice", () => {
	const files230 = Array.from({ length: 230 }, (_, i) => `file-${String(i).padStart(3, "0")}.txt`);

	function globToolWith(files: string[]): GlobTool {
		return new GlobTool(createSession(), {
			nativeGlob: async () => ({
				matches: files.map(file => ({ path: file, mtime: 0, fileType: FileType.File })),
				totalMatches: files.length,
			}),
		});
	}

	type GlobExecuteResult = Awaited<ReturnType<GlobTool["execute"]>>;

	function textOf(result: GlobExecuteResult): string {
		const first = result.content[0];
		return first?.type === "text" && first.text !== undefined ? first.text : "";
	}

	function limitNotice(result: GlobExecuteResult): string {
		return formatOutputNotice((result.details as { meta?: OutputMeta } | undefined)?.meta);
	}

	test("discloses a clamped request and never advises a value that clamps back", async () => {
		const result = await globToolWith(files230).execute("glob-clamp-notice", {
			path: ".",
			limit: 1000,
			gitignore: false,
		});

		expect(textOf(result)).toContain("Requested limit 1000 clamped to the max of 200");
		expect(limitNotice(result)).toContain("200 results limit reached");
		expect(limitNotice(result)).not.toContain("Use limit=");
	});

	test("the default limit sitting on the cap keeps the reached notice without doomed advice", async () => {
		const result = await globToolWith(files230).execute("glob-cap-default", { path: ".", gitignore: false });

		expect(textOf(result)).not.toContain("clamped");
		expect(limitNotice(result)).toContain("200 results limit reached");
		expect(limitNotice(result)).not.toContain("Use limit=");
	});

	test("below the cap the doubled suggestion is capped at the hard limit and stays usable", async () => {
		const result = await globToolWith(files230).execute("glob-below-cap", { path: ".", limit: 50, gitignore: false });

		expect(limitNotice(result)).toContain("[50 results limit reached. Use limit=100 for more]");
	});
});

describe("GlobTool custom backend contract", () => {
	type GlobExecuteResult = AgentToolResult<GlobToolDetails>;

	function detailsOf(result: GlobExecuteResult): GlobToolDetails {
		return result.details ?? {};
	}

	function textOf(result: GlobExecuteResult): string {
		const first = result.content[0];
		return first?.type === "text" && first.text !== undefined ? first.text : "";
	}

	test("stops reporting at the tool deadline when a custom backend never settles", async () => {
		// A custom backend is third-party code that can hang forever. Before the
		// deadline was applied to this branch, execute() simply awaited it, so the
		// call never returned at all: the test failed by timing out, not by
		// asserting.
		let receivedSignal: AbortSignal | undefined;
		const tool = new GlobTool(createSession(), {
			timeoutMs: 200,
			operations: {
				exists: () => true,
				glob: (_pattern, _cwd, options) => {
					receivedSignal = options.signal;
					return Promise.withResolvers<string[]>().promise;
				},
			},
		});

		const started = Date.now();
		const result = await tool.execute("glob-custom-deadline", { path: "src/**/*.ts" });
		const elapsed = Date.now() - started;

		// The point is that it returned at the deadline rather than running on:
		// before the fix this never resolved and the harness killed the test at
		// 5s. The bound is loose enough to survive a loaded CI box.
		expect(elapsed).toBeLessThan(3000);
		expect(receivedSignal?.aborted).toBe(true);
		expect(detailsOf(result).timedOut).toBe(true);
		expect(textOf(result)).toContain("timed out");
		// A zero-match scan that died mid-walk is not proof of absence.
		expect(textOf(result)).not.toContain("No files found");
	});

	test("reports a timeout, not a missing path, when the deadline expires during exists()", async () => {
		// exists() is the first call a custom backend sees, so a backend that is
		// slow to answer (a cold SSH round trip, say) burns the whole deadline
		// before any match is looked for. The old `false` fallback for the
		// un-answered call then read as "the root does not exist" and the
		// single-root path threw `Path not found: <root>`, telling the model the
		// directory is gone when in fact the scan simply ran out of time.
		const tool = new GlobTool(createSession(), {
			timeoutMs: 100,
			operations: {
				exists: () => Promise.withResolvers<boolean>().promise,
				glob: () => ["src/kept.ts"],
			},
		});

		let thrown: unknown;
		let result: GlobExecuteResult | undefined;
		try {
			result = await tool.execute("glob-custom-exists-deadline", { path: "src/**/*.ts" });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeUndefined();
		expect(detailsOf(result as GlobExecuteResult).timedOut).toBe(true);
		expect(textOf(result as GlobExecuteResult)).toContain("timed out");
		expect(textOf(result as GlobExecuteResult)).not.toContain("No files found");
	});

	test("applies the caller's hidden and gitignore policy through the backend options", async () => {
		// Asserted on what the caller ends up seeing, never on the bag the backend
		// was handed: a backend that read a missing field as its own default left
		// the previous version of this test green whether or not the tool
		// forwarded anything. Both flags are read here the way a remote delegate
		// must read a decision rather than a preference, so a field that never
		// arrives (undefined) is visibly not the `false` the caller asked for.
		// The corpus is small enough that the result cap cannot trim the evidence.
		const corpus = [
			...Array.from({ length: 3 }, (_, i) => `src/.hidden-${i}.ts`),
			...Array.from({ length: 3 }, (_, i) => `src/gitignored-${i}.ts`),
			...Array.from({ length: 3 }, (_, i) => `src/plain-${i}.ts`),
		];
		const tool = new GlobTool(createSession(), {
			operations: {
				exists: () => true,
				glob: (_pattern, _cwd, options) => {
					let visible = corpus;
					if (options.hidden === false) visible = visible.filter(p => !p.includes("/."));
					if (options.gitignore !== false) visible = visible.filter(p => !p.includes("gitignored-"));
					return visible;
				},
			},
		});

		const result = await tool.execute("glob-custom-policy-flags", {
			path: "src/**/*.ts",
			hidden: false,
			gitignore: false,
		});

		const text = textOf(result);
		// `hidden: false` reached the backend, so no dotfile came back.
		expect(text).not.toContain(".hidden-");
		// `gitignore: false` reached the backend, so the ignored sources did.
		expect(text).toContain("gitignored-");
		expect(detailsOf(result).fileCount).toBe(6);
	});

	test("applies the caller's result limit inside the custom backend", async () => {
		// `fileCount` alone cannot pin this: the tool re-caps the returned array at
		// its own limit, so a backend that ignored `options.limit` still reports
		// seven. What differs is *which* seven, so the backend slices from the end
		// and the assertions name the boundary entries.
		const corpus = Array.from({ length: 20 }, (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`);
		const tool = new GlobTool(createSession(), {
			operations: {
				exists: () => true,
				glob: (_pattern, _cwd, options) => corpus.slice(-options.limit),
			},
		});

		const result = await tool.execute("glob-custom-policy-limit", {
			path: "src/**/*.ts",
			limit: 7,
		});

		const text = textOf(result);
		// The newest seven, which only happens if the backend sliced to the limit
		// it was handed; the tool's own cap would have kept the oldest seven.
		expect(text).toContain("file-19.ts");
		expect(text).not.toContain("file-06.ts");
		expect(detailsOf(result).fileCount).toBe(7);
	});
});
