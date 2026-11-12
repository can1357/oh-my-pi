import { describe, expect, it } from "bun:test";
import { cfgToolsXdevDocs } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { planXdevPromptDocs, renderXdevPromptDocs, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";

function stateWith(names: string[]): XdevState {
	const tools = new Map<string, unknown>();
	for (const name of names) {
		tools.set(name, { name, label: name, description: `${name} tool`, parameters: { type: "object" } });
	}
	return {
		tools: tools as XdevState["tools"],
		mountedNames: new Set(names),
		builtInNames: new Set(names),
		isActive: () => false,
	};
}

describe("tools.xdevDocs none", () => {
	it("is a registered setting value", () => {
		const opts = (cfgToolsXdevDocs as unknown as { ui: { options: { value: string }[] } }).ui.options;
		expect(opts.map(o => o.value)).toContain("none");
	});

	it("plans no inline docs and no catalog for mounted devices", () => {
		const plan = planXdevPromptDocs(stateWith(["lsp", "browser"]), "none");
		expect(plan.sections).toEqual([]);
		expect(plan.catalog.size).toBe(0);
		expect(renderXdevPromptDocs(plan)).toBe("");
	});

	it("still plans catalog docs in catalog mode", () => {
		const plan = planXdevPromptDocs(stateWith(["lsp"]), "catalog");
		expect(plan.catalog.has("lsp")).toBe(true);
	});
});
