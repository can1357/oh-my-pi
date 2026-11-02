import { afterEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { jsBackend, pythonBackend } from "@oh-my-pi/pi-coding-agent/eval";
import type { ExecutorBackendResult } from "@oh-my-pi/pi-coding-agent/eval/backend";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { cfgToolsMaxTimeout } from "@oh-my-pi/pi-coding-agent/tools/settings";

function makeSession(settings: Settings, asyncJobManager?: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp/eval-timeout-contract",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		asyncJobManager,
	};
}

function result(): ExecutorBackendResult {
	return {
		output: "done",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 1,
		totalBytes: 4,
		outputLines: 1,
		outputBytes: 4,
		displayOutputs: [],
	};
}

describe("eval timeout admission contract", () => {
	afterEach(() => vi.restoreAllMocks());

	for (const { label, timeout, cap, effective } of [
		{ label: "per-tool ceiling", timeout: 5400, effective: 3600 },
		{ label: "configured ceiling", timeout: 30, cap: 5, effective: 5 },
		{ label: "minimum", timeout: 0.25, effective: 1 },
		{ label: "negative minimum", timeout: -2, effective: 1 },
		{ label: "fractional deadline", timeout: 1.25, effective: 1.25 },
		{ label: "omitted deadline", effective: 30 },
		{ label: "capped default", cap: 4, effective: 4 },
		{ label: "disabled deadline", timeout: 0, cap: 5, effective: 0 },
	]) {
		it(`discloses a changed supplied deadline before execution (${label})`, async () => {
			const settings = Settings.isolated(cap === undefined ? {} : { "tools.maxTimeout": cap });
			const updates: string[] = [];
			const clamped = timeout !== undefined && timeout !== effective;
			const execute = vi.spyOn(jsBackend, "execute").mockImplementation(async (_code, options) => {
				expect(options.idleTimeoutMs).toBe(effective === 0 ? undefined : effective * 1000);
				if (clamped) {
					expect(updates[0]).toContain(`${timeout}s`);
					expect(updates[0]).toContain(`${effective}s`);
				} else {
					expect(updates).toEqual([]);
				}
				return result();
			});
			const output = await new EvalTool(makeSession(settings)).execute(
				"timeout-admission",
				{ language: "js", code: "print('done')", ...(timeout === undefined ? {} : { timeout }) },
				undefined,
				update => updates.push(update.content?.find(block => block.type === "text")?.text ?? ""),
			);
			expect(execute).toHaveBeenCalledTimes(1);
			if (clamped) {
				expect(output.details?.notice).toContain(`${timeout}s`);
				expect(output.details?.notice).toContain(`${effective}s`);
				expect(output.content[0]).toMatchObject({ text: expect.stringContaining(output.details!.notice!) });
			} else {
				expect(output.details?.notice).toBeUndefined();
			}
		});
	}

	it("advertises the nonzero range and a live configured ceiling without rejecting clamped inputs", () => {
		const settings = Settings.isolated({ "tools.maxTimeout": 12 });
		const tool = new EvalTool(makeSession(settings));
		const description = () => {
			const schema = toolWireSchema(tool) as { properties: { timeout: { description: string } } };
			return schema.properties.timeout.description;
		};
		expect(description()).toContain("1–3600");
		expect(description()).toContain("12");
		expect(tool.description).toContain("12");
		cfgToolsMaxTimeout.override(settings, 7);
		expect(description()).toContain("7");
		expect(tool.description).toContain("7");
	});

	it("keeps a background cell's deadline and notices fixed at its admitted value", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const settings = Settings.isolated({
			"tools.maxTimeout": 2,
			"eval.autoBackground.enabled": true,
			"eval.autoBackground.thresholdMs": 0,
		});
		const entered = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		vi.spyOn(pythonBackend, "checkAvailability").mockImplementation(async () => {
			// A live settings update during discovery must not change an admitted deadline.
			cfgToolsMaxTimeout.override(settings, 1);
			return { ok: true };
		});
		vi.spyOn(pythonBackend, "execute").mockImplementation(async (_code, options) => {
			signal = options.signal;
			entered.resolve();
			expect(options.idleTimeoutMs).toBe(2000);
			const aborted = Promise.withResolvers<void>();
			options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			return { ...result(), cancelled: true };
		});
		try {
			const output = await new EvalTool(makeSession(settings, manager)).execute("background-timeout", {
				language: "py",
				code: "await work()",
				timeout: 5400,
			});
			await entered.promise;
			const text = output.content.find(block => block.type === "text")?.text;
			expect(text).toContain("5400s");
			expect(text).toContain("2s");
			expect(output.details?.notice).toContain("2s");
			vi.advanceTimersByTime(1999);
			expect(signal?.aborted).toBe(false);
			vi.advanceTimersByTime(1);
			expect(signal?.aborted).toBe(true);
			await manager.waitForAll();
		} finally {
			vi.useRealTimers();
			await manager.dispose();
		}
	});
});
