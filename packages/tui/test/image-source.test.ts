import { describe, expect, it } from "bun:test";
import { closeSync, ftruncateSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	drawablePictureFile,
	hasImageFigure,
	imageTargetPath,
	MAX_PICTURE_BYTES,
	splitImageFigures,
} from "../src/chat/image-source";

/** A 1×1 PNG: enough for the header probe, small enough to inline. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
	"base64",
);

describe("drawablePictureFile", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-drawable-"));

	it("accepts a small picture file", () => {
		const picture = join(dir, "shot.png");
		writeFileSync(picture, PNG);
		expect(drawablePictureFile(picture)).toBe(true);
		expect(drawablePictureFile(join(dir, "shot.JPEG"))).toBe(false);
	});

	it("refuses a device, a directory, a missing file and a name that is not a picture", () => {
		expect(drawablePictureFile("/dev/zero")).toBe(false);
		expect(drawablePictureFile(dir)).toBe(false);
		expect(drawablePictureFile(join(dir, "missing.png"))).toBe(false);
		const text = join(dir, "note.png.txt");
		writeFileSync(text, "not a picture");
		expect(drawablePictureFile(text)).toBe(false);
	});

	it("refuses a picture past the size the transcript will read", () => {
		const huge = join(dir, "huge.png");
		const handle = openSync(huge, "w");
		ftruncateSync(handle, MAX_PICTURE_BYTES + 1);
		closeSync(handle);
		expect(drawablePictureFile(huge)).toBe(false);
	});
});

describe("splitImageFigures", () => {
	it("lifts a line that is nothing but a local image, keeping the prose around it", () => {
		const markdown = "Here it is:\n\n![the flag](/tmp/flag.png)\n\nThat is all.";
		expect(splitImageFigures(markdown)).toEqual([
			{ kind: "markdown", text: "Here it is:\n\n" },
			{ kind: "image", path: "/tmp/flag.png", alt: "the flag" },
			{ kind: "markdown", text: "\nThat is all." },
		]);
		expect(hasImageFigure(markdown)).toBe(true);
	});

	it("accepts a ~ path, a file URL, a title and an empty alt", () => {
		expect(splitImageFigures("![](~/shot.png)")).toEqual([{ kind: "image", path: `${homedir()}/shot.png`, alt: "" }]);
		expect(splitImageFigures("![shot](file:///tmp/a.png)")).toEqual([
			{ kind: "image", path: "/tmp/a.png", alt: "shot" },
		]);
		expect(splitImageFigures('![shot](/tmp/a.png "a title")')).toEqual([
			{ kind: "image", path: "/tmp/a.png", alt: "shot" },
		]);
	});

	it("leaves a relative path, a URL and a data URI as prose", () => {
		for (const line of ["![x](shot.png)", "![x](https://e.test/a.png)", "![x](data:image/png;base64,AA)"]) {
			expect(splitImageFigures(line)).toEqual([{ kind: "markdown", text: line }]);
			expect(hasImageFigure(line)).toBe(false);
		}
		expect(imageTargetPath("local://note.md")).toBeUndefined();
	});

	it("leaves an image line inside a fenced block, in a sentence, or indented as code as prose", () => {
		const fenced = "```\n![x](/tmp/a.png)\n```";
		const sentence = "see ![x](/tmp/a.png) above";
		const indented = "    ![x](/tmp/a.png)";
		for (const markdown of [fenced, sentence, indented]) {
			expect(splitImageFigures(markdown)).toEqual([{ kind: "markdown", text: markdown }]);
			expect(hasImageFigure(markdown)).toBe(false);
		}
	});

	it("lifts CRLF image lines without dropping the line endings around them", () => {
		expect(splitImageFigures("Intro\r\n![x](/tmp/a.png)\r\nOutro")).toEqual([
			{ kind: "markdown", text: "Intro\r\n" },
			{ kind: "image", path: "/tmp/a.png", alt: "x" },
			{ kind: "markdown", text: "Outro" },
		]);
	});

	it("lifts nothing from a line whose closing parenthesis has not streamed in yet", () => {
		expect(splitImageFigures("Look:\n![x](/tmp/a.png")).toEqual([
			{ kind: "markdown", text: "Look:\n![x](/tmp/a.png" },
		]);
	});
});
