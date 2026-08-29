import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { EDIT_MODE_STRATEGIES, type PerFileDiffPreview } from "@oh-my-pi/pi-coding-agent/edit";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// The reveal controller pushes streamed args at ~30fps; a whole-file diff can
// outlast a frame. The component must coalesce those ticks into one compute at a
// time — running the current compute to completion and re-running with the latest
// args once it settles — rather than aborting the in-flight compute on every
// tick, which starved the diff so no preview ever landed until args completed
// (the "blank edit box for the whole stream" regression).
describe("streaming edit preview coalescing", () => {
	let tmpDir: string;
	let file: string;
	let themed = false;
	let restore: (() => void) | undefined;

	beforeEach(async () => {
		if (!themed) {
			await initTheme();
			themed = true;
		}
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "preview-coalesce-"));
		file = path.join(tmpDir, "mod.ts");
		await fs.writeFile(file, "const a = 1;\n");
	});

	afterEach(async () => {
		restore?.();
		restore = undefined;
		await removeWithRetries(tmpDir);
	});

	// Read `new_string` by narrowing rather than asserting an inline shape,
	// so the captured args identity stays type-checked.
	function firstNewText(args: unknown): unknown {
		if (args && typeof args === "object" && "new_string" in args) {
			return args.new_string;
		}
		return undefined;
	}

	test("a slow compute is not aborted by a newer chunk; it lands, then re-runs with the latest args", async () => {
		const deferreds: Array<PromiseWithResolvers<PerFileDiffPreview[] | null>> = [];
		const calls: Array<{ newText: unknown; signal: AbortSignal }> = [];
		// One gate per compute invocation, resolved by the mock as each call
		// starts, so the test awaits the real "compute N began" signal instead of a
		// wall-clock delay.
		const gates: Array<PromiseWithResolvers<void>> = [];
		const gateFor = (index: number): PromiseWithResolvers<void> => {
			while (gates.length <= index) gates.push(Promise.withResolvers<void>());
			return gates[index]!;
		};
		const spy = spyOn(EDIT_MODE_STRATEGIES.replace, "computeDiffPreview").mockImplementation(async (args, ctx) => {
			calls.push({ newText: firstNewText(args), signal: ctx.signal });
			const deferred = Promise.withResolvers<PerFileDiffPreview[] | null>();
			deferreds.push(deferred);
			gateFor(calls.length - 1).resolve();
			return deferred.promise;
		});
		restore = () => spy.mockRestore();

		let renders = 0;
		const ui = {
			requestRender() {
				renders++;
			},
		} as unknown as TUI;
		const tool = { mode: "replace" } as unknown as AgentTool;

		// Construction kicks off compute #0 for the first chunk; it stays in flight
		// (mock returns an unresolved promise) so we can race a newer chunk against it.
		const component = new ToolExecutionComponent(
			"edit",
			{ path: file, old_string: "const a = 1;", new_string: "a" },
			{},
			tool,
			ui,
			tmpDir,
		);
		try {
			await gateFor(0).promise;
			expect(calls.length).toBe(1);
			expect(calls[0]!.newText).toBe("a");

			// A newer chunk arrives mid-compute. Coalescing must NOT cancel #0 and
			// must NOT launch a second concurrent compute — only mark a rerun pending.
			component.updateArgs({ path: file, old_string: "const a = 1;", new_string: "ab" });
			expect(calls.length).toBe(1);
			expect(calls[0]!.signal.aborted).toBe(false);

			// Resolving #0 lands its (now slightly stale) preview mid-stream — the
			// behavior the starvation bug suppressed — and only then drives the rerun.
			const rendersBeforeLanding = renders;
			deferreds[0]!.resolve([{ path: file, diff: "@@ -1 +1 @@\n-const a = 1;\n+a", firstChangedLine: 1 }]);

			// Awaiting compute #1's start proves the rerun fired off the back of #0
			// settling; #0's landing (requestRender) runs synchronously before it.
			await gateFor(1).promise;
			expect(renders).toBeGreaterThan(rendersBeforeLanding);
			expect(calls.length).toBe(2);
			expect(calls[1]!.newText).toBe("ab");
			expect(calls[1]!.signal.aborted).toBe(false);

			// Settle the rerun so the drain loop exits cleanly.
			deferreds[1]!.resolve([{ path: file, diff: "@@ -1 +1 @@\n-const a = 1;\n+ab", firstChangedLine: 1 }]);
			await component.whenPreviewSettled();
		} finally {
			// updateArgs starts the edit spinner interval; clear it so the timer
			// never leaks into later tests.
			component.stopAnimation();
		}
	});
	test("whenPreviewSettled waits for a cleanup-window follow-up drain", async () => {
		const deferreds: Array<PromiseWithResolvers<PerFileDiffPreview[] | null>> = [];
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		let component: ToolExecutionComponent | undefined;
		let stopped = false;
		let settled = false;
		let previewSettled: Promise<void> | undefined;
		const spy = spyOn(EDIT_MODE_STRATEGIES.replace, "computeDiffPreview").mockImplementation(() => {
			const deferred = Promise.withResolvers<PerFileDiffPreview[] | null>();
			deferreds.push(deferred);
			if (deferreds.length === 1) firstStarted.resolve();
			if (deferreds.length === 2) secondStarted.resolve();
			return deferred.promise;
		});
		restore = () => spy.mockRestore();

		const ui = { requestRender() {} } as unknown as TUI;
		const tool = { mode: "replace" } as unknown as AgentTool;
		component = new ToolExecutionComponent(
			"edit",
			{ path: file, old_string: "const a = 1;", new_string: "a" },
			{},
			tool,
			ui,
			tmpDir,
		);
		try {
			await firstStarted.promise;
			previewSettled = component.whenPreviewSettled().then(() => {
				settled = true;
			});

			// Register after the component's await reaction. The nested microtask
			// lands after the drain loop observes clean state but before its
			// finalizer, which is the replacement-drain window.
			deferreds[0]!.promise.then(() => {
				queueMicrotask(() => {
					if (stopped) return;
					component?.updateArgs({
						path: file,
						old_string: "const a = 1;",
						new_string: "latest",
					});
				});
			});
			deferreds[0]!.resolve(null);

			await secondStarted.promise;
			await Promise.resolve();
			expect(settled).toBe(false);

			deferreds[1]!.resolve(null);
			await previewSettled;
			expect(settled).toBe(true);
		} finally {
			stopped = true;
			for (const deferred of deferreds) deferred.resolve(null);
			component.stopAnimation();
			await previewSettled;
		}
	});
	// A microtask-fed stream must still let an independently queued macrotask
	// run before the preview catches up with every update.
	test("yields to the event loop while streamed args keep queuing preview work", async () => {
		const maxUpdates = 128;
		const maxComputes = maxUpdates + 2;
		let updates = 0;
		let computes = 0;
		let stopped = false;
		let component: ToolExecutionComponent | undefined;
		const updatesDone = Promise.withResolvers<void>();
		const beaconResult = Promise.withResolvers<{ updates: number; computes: number }>();
		// This is a task boundary, not a duration-based wait; fake timers cannot
		// prove that the real event loop was allowed to run.
		const beacon = setImmediate(() => beaconResult.resolve({ updates, computes }));
		const spy = spyOn(EDIT_MODE_STRATEGIES.replace, "computeDiffPreview").mockImplementation(async () => {
			computes++;
			// Bound a failed implementation so this regression never hangs CI.
			if (computes >= maxComputes) {
				updatesDone.resolve();
				beaconResult.resolve({ updates, computes });
				return null;
			}
			if (updates >= maxUpdates) return null;
			queueMicrotask(() => {
				if (stopped || updates >= maxUpdates) return;
				updates++;
				if (updates === maxUpdates) updatesDone.resolve();
				component?.updateArgs({
					path: file,
					old_string: "const a = 1;",
					new_string: String(updates),
				});
			});
			return null;
		});
		restore = () => spy.mockRestore();

		const ui = { requestRender() {} } as unknown as TUI;
		const tool = { mode: "replace" } as unknown as AgentTool;
		component = new ToolExecutionComponent(
			"edit",
			{ path: file, old_string: "const a = 1;", new_string: "0" },
			{},
			tool,
			ui,
			tmpDir,
		);
		try {
			const observed = await beaconResult.promise;
			expect(observed.updates).toBeLessThan(maxUpdates);
			expect(observed.computes).toBeLessThan(maxUpdates + 1);
			await updatesDone.promise;
			await component.whenPreviewSettled();
			expect(updates).toBe(maxUpdates);
		} finally {
			stopped = true;
			clearImmediate(beacon);
			component.stopAnimation();
			await component.whenPreviewSettled();
		}
	});
	// Transcript rebuild constructs a historical edit call and applies its
	// persisted result within the same sync replay chunk. The renderer prefers
	// `details.diff` from that result, so the streaming preview compute must be
	// cancelled before it runs — re-running the edit engine for every historical
	// edit made session restore take multiple seconds (sloppy matcher dominated
	// the restore CPU profile).
	test("a result settled in the same tick as construction cancels the preview compute", async () => {
		const spy = spyOn(EDIT_MODE_STRATEGIES.replace, "computeDiffPreview");
		restore = () => spy.mockRestore();

		const ui = { requestRender() {} } as unknown as TUI;
		const tool = { mode: "replace" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{ path: file, old_string: "const a = 1;", new_string: "const a = 2;" },
			{},
			tool,
			ui,
			tmpDir,
		);
		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "ok" }],
					details: { diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", firstChangedLine: 1 },
				},
				false,
			);
			await component.whenPreviewSettled();
			expect(spy).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});
});
