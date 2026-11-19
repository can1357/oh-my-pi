import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as ar from "@oh-my-pi/pi-utils/ar";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

function textOf(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

describe("archive routing", () => {
	let temp: TempDir;
	let tool: ReadTool;

	beforeEach(() => {
		temp = TempDir.createSync("@read-archive-routing-");
		const session: ToolSession = {
			cwd: temp.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "images.autoResize": false }),
		};
		tool = new ReadTool(session);
	});

	afterEach(() => {
		temp.removeSync();
	});

	it("reads a member of a ZIP-container document", async () => {
		await ar.writeArchive(temp.join("report.docx"), "zip", [["word/document.xml", "<w:document>body</w:document>"]]);
		const member = await tool.execute("docx-member", { path: "report.docx:word/document.xml" });
		expect(textOf(member)).toContain("<w:document>body</w:document>");
	});

	it("returns an image member as an image", async () => {
		await ar.writeArchive(temp.join("images.zip"), "zip", [["pixel.png", ONE_PX_PNG]]);
		const result = await tool.execute("png-member", { path: "images.zip:pixel.png" });
		expect(result.content.some(block => block.type === "image")).toBe(true);
		expect(textOf(result)).toContain("Read image file [image/png]");
	});

	it("reads a text `.lib` as a file, not an ar archive", async () => {
		await Bun.write(temp.join("model.lib"), ".model diode D(Is=1e-14)\n.end\n");
		expect(textOf(await tool.execute("spice-lib", { path: "model.lib" }))).toContain(".model diode");
		expect(textOf(await tool.execute("spice-lib-line", { path: "model.lib:2" }))).toContain(".end");
	});

	it("lists an archive whose other member exceeds the extraction limit", async () => {
		await ar.writeArchive(temp.join("big.zip"), "zip", [
			["README.md", "hello"],
			["huge.bin", new Uint8Array(65 * 1024 * 1024)],
		]);
		const listing = textOf(await tool.execute("zip-listing", { path: "big.zip" }));
		expect(listing).toContain("README.md");
		expect(listing).toContain("huge.bin");
		expect(textOf(await tool.execute("zip-readme", { path: "big.zip:README.md" }))).toContain("hello");
		await expect(tool.execute("zip-huge", { path: "big.zip:huge.bin" })).rejects.toThrow("too large to extract");
	});
});
