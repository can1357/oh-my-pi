import { describe, expect, test } from "bun:test";
import { thinkingLevels } from "../src/rpc/thinking";

/*
 * The effort sets below are real: read from `omp models --json` against the
 * installed catalog, and the nested `thinking` shape verified against a live
 * `get_state` frame. The CLI's own `--json` flattens `thinking` to a bare
 * string array while the RPC does not, so a test written from the CLI's output
 * would have pinned the wrong shape.
 */
describe("thinking levels come from the model, not a fixed list", () => {
	test("offers exactly what the active model supports", () => {
		// opencode-go/gpt-5.6-luna, the model this desktop session runs on.
		const levels = thinkingLevels({
			id: "gpt-5.6-luna",
			reasoning: true,
			thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
		});
		expect(levels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
	});

	test("keeps a model's minimal when it has one", () => {
		// The single most common set in the catalog: 12 of 37 models.
		const levels = thinkingLevels({
			id: "claude-opus-5",
			reasoning: true,
			thinking: { efforts: ["minimal", "low", "medium", "high", "xhigh"] },
		});
		expect(levels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	test("a sparse set stays sparse", () => {
		// `["low","high","max"]` is real — 5 models have exactly this and no medium.
		expect(thinkingLevels({ reasoning: true, thinking: { efforts: ["low", "high", "max"] } })).toEqual([
			"off",
			"low",
			"high",
			"max",
		]);
	});

	test("a model that cannot reason offers nothing", () => {
		expect(thinkingLevels({ id: "some-completion-model", reasoning: false })).toEqual([]);
	});

	test("reasoning with an empty effort list still offers nothing", () => {
		// Rather than an `off` button on its own, which would toggle nothing.
		expect(thinkingLevels({ reasoning: true, thinking: { efforts: [] } })).toEqual([]);
	});

	test("no model yet, no levels", () => {
		expect(thinkingLevels(undefined)).toEqual([]);
	});

	test("survives a model frame with no thinking block at all", () => {
		expect(thinkingLevels({ reasoning: true })).toEqual([]);
	});

	test("never offers the four the picker used to hardcode when the model lacks them", () => {
		const levels = thinkingLevels({ reasoning: true, thinking: { efforts: ["low", "medium", "high"] } });
		expect(levels).not.toContain("xhigh");
		expect(levels).toEqual(["off", "low", "medium", "high"]);
	});
});
