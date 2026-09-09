import { describe, expect, it } from "bun:test";
import { executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { KernelDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { FakeKernel } from "./helpers";

describe("executePythonWithKernel display outputs", () => {
	it("aggregates display outputs in order", async () => {
		const outputs: KernelDisplayOutput[] = [
			{ type: "json", data: { foo: "bar" } },
			{ type: "image", data: "abc", mimeType: "image/png" },
		];

		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			async options => {
				if (!options?.onDisplay) return;
				for (const output of outputs) {
					await options.onDisplay(output);
				}
			},
		);

		const result = await executePythonWithKernel(kernel, "print('hi')");

		expect(result.exitCode).toBe(0);
		expect(result.displayOutputs).toEqual(outputs);
	});
});
