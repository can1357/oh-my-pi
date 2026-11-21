/**
 * `read` names a file Tern's media viewer shows (`details.mediaPath`, display-only) on a whole
 * read of it, whatever the model receives: images, SVG source, 3D models, PDFs. Sidecars and
 * partial line-range reads carry none.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ternShowsMedia } from "@oh-my-pi/pi-coding-agent/tools/tern-media";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);
const TINY_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7"><rect width="12" height="7" fill="red"/></svg>';
const HOUSE_OBJ = "mtllib house.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";

function makeSession(cwd: string): ToolSession {
	const model = createMockModel({ id: "vision" });
	model.input.push("image");
	const sessionFile = path.join(cwd, "session.jsonl");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => sessionFile.slice(0, -6),
		getSessionSpawns: () => null,
		getModelString: () => `${model.provider}/${model.id}`,
		getActiveModelString: () => `${model.provider}/${model.id}`,
		getActiveModel: () => model,
		settings: Settings.isolated({ "images.autoResize": false }),
	} as unknown as ToolSession;
}

describe("ternShowsMedia", () => {
	it("mirrors Tern's viewer extensions", () => {
		for (const name of ["a.png", "a.JPG", "a.svg", "house.obj", "s.glb", "s.usdz", "doc.pdf", "clip.mov", "a.opus"]) {
			expect(ternShowsMedia(`/x/${name}`)).toBe(true);
		}
		for (const name of ["house.mtl", "a.txt", "a.bmp", "a.mkv", ".png", "png", "a.usdz.gz", "a.gz"]) {
			expect(ternShowsMedia(`/x/${name}`)).toBe(false);
		}
		expect(ternShowsMedia("/x/scene.wrl.gz")).toBe(true);
		expect(ternShowsMedia("/x/scene.obj.gz")).toBe(true);
	});
});

describe("read mediaPath", () => {
	let dir: string;
	let tool: ReadTool;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-media-path-"));
		await Bun.write(path.join(dir, "house.obj"), HOUSE_OBJ);
		await Bun.write(path.join(dir, "house.mtl"), "newmtl brick\nmap_Kd brick.png\n");
		await Bun.write(path.join(dir, "brick.png"), TINY_PNG);
		await Bun.write(path.join(dir, "logo.svg"), TINY_SVG);
		tool = new ReadTool(makeSession(dir));
	});

	afterEach(async () => {
		await removeWithRetries(dir);
	});

	const mediaPathOf = async (target: string) => (await tool.execute("call", { path: target })).details?.mediaPath;

	it("names whole reads of viewable files, text for the model or not", async () => {
		const obj = await tool.execute("call", { path: "house.obj" });
		expect(obj.content.some(block => block.type === "image")).toBe(false);
		expect(obj.details?.mediaPath).toBe(path.join(dir, "house.obj"));
		expect(await mediaPathOf("brick.png")).toBe(path.join(dir, "brick.png"));
		expect(await mediaPathOf("logo.svg")).toBe(path.join(dir, "logo.svg"));
		expect(await mediaPathOf("logo.svg:img")).toBe(path.join(dir, "logo.svg"));
		expect(await mediaPathOf("house.obj:raw")).toBe(path.join(dir, "house.obj"));
	});

	it("leaves sidecars and partial reads unnamed", async () => {
		expect(await mediaPathOf("house.mtl")).toBeUndefined();
		expect(await mediaPathOf("house.obj:2-3")).toBeUndefined();
	});
});
