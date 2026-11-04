import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const PRIVATE_MODE = "\x1b[?1049h\x1b[?1003h";

describe("ast-grep control-byte filenames", () => {
	beforeAll(async () => {
		await initTheme();
	});
	afterEach(() => {
		applyHyperlinkSetting("auto");
	});

	// Windows rejects control characters in filenames.
	it.skipIf(process.platform === "win32")(
		"links the original file without exposing its terminal controls in the label",
		async () => {
			applyHyperlinkSetting("always");
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ast-grep-link-"));
			const filename = `fixture${PRIVATE_MODE}.ts`;
			const absolutePath = path.join(dir, filename);
			try {
				await Bun.write(absolutePath, "needle");
				const component = new ToolExecutionComponent(
					"ast_grep",
					{ pat: "needle" },
					{ useBuiltInRenderer: true },
					undefined,
					{ requestRender: vi.fn(), requestComponentRender: vi.fn(), resetDisplay: vi.fn() },
					dir,
				);
				component.updateResult({
					content: [{ type: "text", text: "needle" }],
					details: {
						matchCount: 1,
						fileCount: 1,
						filesSearched: 1,
						limitReached: false,
						cwd: dir,
						searchPath: dir,
						displayContent: [`# ${filename}`, "*1│needle"].join("\n"),
					},
				});
				for (const expanded of [false, true]) {
					component.setExpanded(expanded);
					const rendered = component.render(120).join("\n");
					const href = pathToFileURL(absolutePath).href;
					expect(rendered).toContain(href);
					expect(rendered).not.toContain(PRIVATE_MODE);
					expect(rendered).not.toMatch(/\x1b\[\?[\d;]*[hl]/);
					expect(await Bun.file(new URL(href)).text()).toBe("needle");
				}
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);
});
