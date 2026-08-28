import { describe, expect, test } from "bun:test";
import { toolMenuItems } from "../src/components/toolMenu";
import { transcriptMenuItems } from "../src/components/transcriptMenu";
import type { ToolEntry } from "../src/rpc/transcript";
import type { MenuItem } from "../src/shell/contextMenu";

const report = () => {};

function labels(items: readonly MenuItem[]): string[] {
	return items.filter(item => item.kind === "action").map(item => item.label);
}

function tool(over: Partial<ToolEntry>): ToolEntry {
	return { kind: "tool", id: "t1", name: "bash", ...over } as ToolEntry;
}

describe("toolMenuItems", () => {
	test("offers only what this tool actually carries", () => {
		// A `read` has no command; listing one would promise something the entry
		// cannot deliver.
		const items = toolMenuItems(tool({ name: "read", args: { path: "src/app.tsx" } }), report);

		expect(labels(items)).toEqual(["Copy the path", "Copy the arguments"]);
	});

	test("a bash card offers its command and its output", () => {
		const items = toolMenuItems(
			tool({ args: { command: "git status" }, result: { content: [{ type: "text", text: "clean" }] } }),
			report,
		);

		expect(labels(items)).toEqual(["Copy the command", "Copy the output", "Copy the arguments"]);
	});

	test("a running tool has no output to offer yet", () => {
		const items = toolMenuItems(tool({ args: { command: "sleep 10" }, running: true }), report);

		expect(labels(items)).not.toContain("Copy the output");
	});

	test("an entry with nothing to give produces no menu at all", () => {
		// Empty rather than a menu of dead entries: the caller falls through to the
		// message underneath, which does have something.
		expect(toolMenuItems(tool({ args: {} }), report)).toEqual([]);
	});
});

describe("transcriptMenuItems", () => {
	test("copying the selection is offered but disabled when there is none", () => {
		const items = transcriptMenuItems({ text: "hello", selection: "", report });
		const selection = items.find(item => item.kind === "action" && item.id === "copy-selection");

		expect(selection?.kind === "action" && selection.disabled).toBe("Nothing selected");
	});

	test("the code-block entry appears only when the click landed in one", () => {
		expect(labels(transcriptMenuItems({ text: "hi", selection: "", report }))).not.toContain("Copy code block");
		expect(labels(transcriptMenuItems({ text: "hi", selection: "", codeBlock: "const a = 1", report }))).toContain(
			"Copy code block",
		);
	});

	test("a message with no text still offers the selection", () => {
		const items = transcriptMenuItems({ selection: "picked", report });

		expect(labels(items)).toEqual(["Copy selection"]);
	});
});
