import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

describe("native streaming edit previews", () => {
	beforeAll(async () => {
		await initTheme();
	});

	function createComponent(onRender: () => void): ToolExecutionComponent {
		const ui = { requestRender: onRender } as unknown as TUI;
		const tool = { mode: "replace" } as unknown as AgentTool;
		return new ToolExecutionComponent(
			"edit",
			{ path: "/tmp/mod.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
			{},
			tool,
			ui,
			"/tmp",
		);
	}

	test("new batches replace the preview and empty batches retain it", () => {
		let renders = 0;
		const component = createComponent(() => renders++);
		try {
			component.updateStreamPreview({
				generation: 1,
				streaming: true,
				files: [{ path: "/tmp/mod.ts", diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", firstChangedLine: 1 }],
			});
			const first = Bun.stripANSI(component.render(100).join("\n"));
			expect(first).toContain("const a = 2;");
			expect(renders).toBe(1);

			component.updateStreamPreview({ generation: 2, streaming: true, files: [] });
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("const a = 2;");
			expect(renders).toBe(1);

			component.updateStreamPreview({
				generation: 3,
				streaming: true,
				files: [{ path: "/tmp/mod.ts", diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 3;", firstChangedLine: 1 }],
			});
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("const a = 3;");
			expect(renders).toBe(2);
		} finally {
			component.stopAnimation();
		}
	});

	test("terminal results reject late preview batches", () => {
		const component = createComponent(() => {});
		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "ok" }],
					details: { diff: "@@ -1 +1 @@\n-old\n+final", firstChangedLine: 1 },
				},
				false,
			);
			component.updateStreamPreview({
				generation: 4,
				streaming: false,
				files: [{ path: "/tmp/mod.ts", diff: "@@ -1 +1 @@\n-old\n+late", firstChangedLine: 1 }],
			});
			const rendered = Bun.stripANSI(component.render(100).join("\n"));
			expect(rendered).toContain("final");
			expect(rendered).not.toContain("late");
		} finally {
			component.stopAnimation();
		}
	});
});
