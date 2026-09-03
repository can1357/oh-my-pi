/**
 * Regression for issue #5764: re-registering an essential built-in (read /
 * write / bash / edit / glob) without an explicit `loadMode` must NOT demote it
 * to `discoverable`, which — with `tools.xdev` on — unmounts it from the
 * top-level schema and breaks the `xd://` transport (transport IS `read xd://`
 * / `write xd://<tool>`).
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomToolAdapter } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/wrapper";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { RegisteredToolAdapter } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	defaultLoadModeForToolName,
	ESSENTIAL_BUILTIN_TOOL_NAMES,
} from "@oh-my-pi/pi-coding-agent/tools/essential-tools";
import { isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

const emptySchema = type({});
const noopExecute = async () => ({ content: [{ type: "text" as const, text: "" }] });

describe("issue #5764: registerTool loadMode default", () => {
	it("never mounts the read/write transport tools under xdev, even when mislabeled discoverable", () => {
		// A UI-only re-register could carry loadMode "discoverable"; the transport
		// invariant must still keep read/write top-level.
		expect(isMountableUnderXdev({ name: "read", loadMode: "discoverable" })).toBe(false);
		expect(isMountableUnderXdev({ name: "write", loadMode: "discoverable" })).toBe(false);
		// A genuinely discoverable tool still mounts.
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" })).toBe(true);
	});

	it("defaults omitted loadMode to essential for essential built-in names, discoverable otherwise", () => {
		expect(defaultLoadModeForToolName("read")).toBe("essential");
		expect(defaultLoadModeForToolName("bash")).toBe("essential");
		expect(defaultLoadModeForToolName("edit")).toBe("essential");
		expect(defaultLoadModeForToolName("glob")).toBe("essential");
		expect(defaultLoadModeForToolName("some_extension_tool")).toBe("discoverable");
		// An explicit mode always wins.
		expect(defaultLoadModeForToolName("read", "discoverable")).toBe("discoverable");
		expect(defaultLoadModeForToolName("some_extension_tool", "essential")).toBe("essential");
	});

	it("RegisteredToolAdapter keeps a re-registered essential built-in essential (not mountable)", () => {
		const runner = {} as ExtensionRunner;
		const adapter = new RegisteredToolAdapter(
			{
				definition: {
					name: "read",
					label: "Read",
					description: "wrapped read",
					parameters: emptySchema,
					// NO loadMode — the exact footgun from the issue.
					execute: noopExecute,
				},
				extensionPath: "<test>",
			},
			runner,
		);
		expect(adapter.loadMode).toBe("essential");
		expect(isMountableUnderXdev(adapter)).toBe(false);
	});

	it("RegisteredToolAdapter still defaults a novel extension tool to discoverable", () => {
		const runner = {} as ExtensionRunner;
		const adapter = new RegisteredToolAdapter(
			{
				definition: {
					name: "my_ext_tool",
					label: "My Ext Tool",
					description: "novel tool",
					parameters: emptySchema,
					execute: noopExecute,
				},
				extensionPath: "<test>",
			},
			runner,
		);
		expect(adapter.loadMode).toBe("discoverable");
		expect(isMountableUnderXdev(adapter)).toBe(true);
	});

	it("CustomToolAdapter keeps a re-registered essential built-in essential", () => {
		const adapter = new CustomToolAdapter(
			{
				name: "bash",
				label: "Bash",
				description: "wrapped bash",
				parameters: emptySchema,
				execute: noopExecute,
			},
			() => ({}) as never,
		);
		expect(adapter.loadMode).toBe("essential");
		expect(isMountableUnderXdev(adapter)).toBe(false);
	});

	it("keeps ESSENTIAL_BUILTIN_TOOL_NAMES in sync with the tool classes that declare loadMode essential", async () => {
		const session = makeSession();
		for (const name in ESSENTIAL_BUILTIN_TOOL_NAMES) {
			const factory = BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS];
			expect(factory, `${name} must be a built-in factory`).toBeDefined();
			// learn/manage_skill are conditional (need an autolearn backend) and
			// return null in a default session; their essential loadMode is covered
			// by autolearn-tools-gating.test.ts. Assert the rest build as essential.
			const tool = await factory(session);
			if (!tool) continue;
			expect(tool.loadMode, `${name} must declare loadMode "essential"`).toBe("essential");
		}
	});
});
