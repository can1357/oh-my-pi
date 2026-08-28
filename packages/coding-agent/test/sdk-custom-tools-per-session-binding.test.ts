/**
 * Regression guard for PR review feedback on #2190.
 *
 * Subagents inherit the parent's custom-tool source *paths* (a cheap FS scan
 * the parent already paid for), but each session MUST rebuild its own
 * `LoadedCustomTool[]` so factories see the subagent's `CustomToolAPI`
 * (cwd, exec, pushPendingAction, UI). Forwarding the parent's loaded tool
 * instances would route execution and pending actions back to the parent —
 * wrong for isolated tasks and for queue routing.
 *
 * This file does not exercise the live SDK end-to-end (that path requires
 * a real worker spawn and is covered by the broader test suite); it pins
 * down the loader contract that the SDK now depends on.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type CustomToolAPI, loadCustomTools } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("loadCustomTools per-session binding (#2190 review fix)", () => {
	let tmp: string;
	let toolPath: string;

	beforeAll(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-tool-binding-"));
		toolPath = path.join(tmp, "echo-cwd.ts");
		// Factory exposes the API it was bound to so the test can inspect it.
		await fs.writeFile(
			toolPath,
			[
				"export default function (api) {",
				"  return {",
				"    name: 'echo_cwd_' + api.cwd.replace(/[^a-z0-9]/gi, '_'),",
				"    description: 'returns the cwd the factory was bound to',",
				"    parameters: api.typebox.Type.Object({}),",
				"    async execute() { return { content: [{ type: 'text', text: api.cwd }] }; },",
				"    __boundApi: api,",
				"  };",
				"}",
			].join("\n"),
		);
	});

	afterAll(async () => {
		await removeWithRetries(tmp);
	});

	it("binds each load to its own cwd and pending-action callback", async () => {
		const parentLog: string[] = [];
		const subagentLog: string[] = [];

		const parentResult = await loadCustomTools([{ path: toolPath }], "/tmp/parent-cwd", [], action =>
			parentLog.push(`parent:${action.label}`),
		);
		const subagentResult = await loadCustomTools([{ path: toolPath }], "/tmp/subagent-cwd", [], action =>
			subagentLog.push(`subagent:${action.label}`),
		);

		expect(parentResult.tools[0]).toBeDefined();
		expect(subagentResult.tools[0]).toBeDefined();
		const parentApi = (parentResult.tools[0]!.tool as unknown as { __boundApi: CustomToolAPI }).__boundApi;
		const subagentApi = (subagentResult.tools[0]!.tool as unknown as { __boundApi: CustomToolAPI }).__boundApi;

		expect(parentResult.errors).toEqual([]);
		expect(subagentResult.errors).toEqual([]);
		expect(parentResult.tools).toHaveLength(1);
		expect(subagentResult.tools).toHaveLength(1);
		expect(parentApi.cwd).toBe("/tmp/parent-cwd");
		expect(subagentApi.cwd).toBe("/tmp/subagent-cwd");
		expect(subagentApi).not.toBe(parentApi);
		expect(subagentResult.tools[0]?.tool).not.toBe(parentResult.tools[0]?.tool);

		// Cast: the test fixture exposes the runtime API verbatim.
		parentApi.pushPendingAction({
			label: "ping",
			sourceToolName: "echo",
			apply: async () => ({ content: [] }),
		});
		subagentApi.pushPendingAction({
			label: "ping",
			sourceToolName: "echo",
			apply: async () => ({ content: [] }),
		});

		expect(parentLog).toEqual(["parent:ping"]);
		expect(subagentLog).toEqual(["subagent:ping"]);
	});
});
