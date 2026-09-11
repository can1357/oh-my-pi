import { deflateSync } from "node:zlib";
import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { TerminalGraphicsDecoder, encodeTerminalImage } from "@oh-my-pi/pi-coding-agent/utils/terminal-graphics";

const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const RED_1X1_PNG = Buffer.from(RED_1X1_PNG_BASE64, "base64");
const ESC = "\x1b";

function kitty(controls: string, payload = "", c1 = false): string {
	return `${c1 ? "\x9f" : `${ESC}_`}G${controls};${payload}${c1 ? "\x9c" : `${ESC}\\`}`;
}

async function metadata(image: { data: string }): Promise<{ width: number; height: number; format?: string }> {
	return new Bun.Image(Buffer.from(image.data, "base64")).metadata();
}

async function decodeByCodeUnit(stream: string): Promise<{ text: string; images: ImageContent[] }> {
	const decoder = new TerminalGraphicsDecoder();
	let text = "";
	for (const codeUnit of stream) text += decoder.push(codeUnit);
	text += decoder.finish();
	return { text, images: await decoder.images() };
}

describe("TerminalGraphicsDecoder Kitty", () => {
	it("recovers a direct PNG across every framing split and preserves interleaved text", async () => {
		const base64 = RED_1X1_PNG_BASE64;
		const stream =
			`before:${kitty("a=T,t=d,f=100,m=1", base64.slice(0, 40))}` + `middle:${kitty("m=0", base64.slice(40))}:after`;
		const result = await decodeByCodeUnit(stream);

		expect(result.text).toBe("before:middle::after");
		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(await metadata(result.images[0]!)).toMatchObject({ width: 1, height: 1, format: "png" });
	});

	it("accepts C1 APC/ST framing", async () => {
		const result = await decodeByCodeUnit(`a${kitty("a=T,t=d,f=100", RED_1X1_PNG_BASE64, true)}b`);
		expect(result.text).toBe("ab");
		expect(result.images).toHaveLength(1);
		expect(await metadata(result.images[0]!)).toMatchObject({ width: 1, height: 1 });
	});

	it("decodes zlib-compressed PNG/RGB and direct RGBA payloads", async () => {
		const rgb = Buffer.from([255, 0, 0, 0, 255, 0]);
		const rgba = Buffer.from([0, 0, 255, 255, 255, 255, 255, 128]);
		const stream =
			kitty("a=T,t=d,f=100,o=z", deflateSync(RED_1X1_PNG).toString("base64")) +
			kitty("a=T,t=d,f=24,s=2,v=1,o=z", deflateSync(rgb).toString("base64")) +
			kitty("a=T,t=d,f=32,s=2,v=1", rgba.toString("base64"));
		const decoder = new TerminalGraphicsDecoder();
		expect(decoder.push(stream)).toBe("");
		expect(decoder.finish()).toBe("");
		const images = await decoder.images();

		expect(images).toHaveLength(3);
		expect(await Promise.all(images.map(metadata))).toEqual([
			{ width: 1, height: 1, format: "png" },
			{ width: 2, height: 1, format: "png" },
			{ width: 2, height: 1, format: "png" },
		]);
	});

	it("strips malformed, unsupported, placement, query, and delete controls without producing images", async () => {
		const pathPayload = Buffer.from("/tmp/output-controlled-path.png").toString("base64");
		const stream =
			`left${kitty("a=T,t=f,f=100", pathPayload)}` +
			kitty("a=p,i=1") +
			kitty("a=q,f=100", RED_1X1_PNG_BASE64) +
			kitty("a=d,i=1") +
			kitty("a=T,t=d,f=100", "%%%not-base64%%") +
			"right";
		const decoder = new TerminalGraphicsDecoder();
		expect(decoder.push(stream)).toBe("leftright");
		expect(decoder.finish()).toBe("");
		expect(await decoder.images()).toEqual([]);
	});

	it("does not leak an unterminated base64 payload into text", async () => {
		const decoder = new TerminalGraphicsDecoder();
		expect(decoder.push(`safe${ESC}_Ga=T,t=d,f=100;${RED_1X1_PNG_BASE64}`)).toBe("safe");
		expect(decoder.finish()).toBe("");
		expect(await decoder.images()).toEqual([]);
	});

	it("rejects dimensions before attempting raw or PNG decode", async () => {
		const impossiblePng = Buffer.alloc(24);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(impossiblePng);
		impossiblePng.writeUInt32BE(13, 8);
		impossiblePng.write("IHDR", 12, "ascii");
		impossiblePng.writeUInt32BE(0x7fffffff, 16);
		impossiblePng.writeUInt32BE(0x7fffffff, 20);
		const stream =
			kitty("a=T,t=d,f=100", impossiblePng.toString("base64")) +
			kitty("a=T,t=d,f=32,s=999999999,v=999999999", Buffer.from([0]).toString("base64"));
		const decoder = new TerminalGraphicsDecoder();
		expect(decoder.push(stream)).toBe("");
		decoder.finish();
		expect(await decoder.images()).toEqual([]);
	});

	it("caps the total number of retained images", async () => {
		const decoder = new TerminalGraphicsDecoder();
		expect(decoder.push(kitty("a=T,t=d,f=100", RED_1X1_PNG_BASE64).repeat(33))).toBe("");
		decoder.finish();
		expect(await decoder.images()).toHaveLength(32);
	});
});

describe("TerminalGraphicsDecoder SIXEL", () => {
	it("decodes color definitions and repeats into a valid PNG across arbitrary chunk splits", async () => {
		const sixel = `${ESC}P1;1q"1;1;3;6#1;2;100;0;0#1!3~${ESC}\\`;
		const result = await decodeByCodeUnit(`before${sixel}after`);

		expect(result.text).toBe("beforeafter");
		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(await metadata(result.images[0]!)).toMatchObject({ width: 3, height: 6, format: "png" });
	});

	it("accepts C1 DCS/ST framing", async () => {
		const sixel = '\x901;1q"1;1;2;6#2;2;0;100;0#2!2~\x9c';
		const result = await decodeByCodeUnit(sixel);
		expect(result.text).toBe("");
		expect(result.images).toHaveLength(1);
		expect(await metadata(result.images[0]!)).toMatchObject({ width: 2, height: 6 });
	});

	it("preflights malicious raster declarations and repeats before native allocation", async () => {
		const stream = `${ESC}Pq"1;1;999999;999999~${ESC}\\` + `${ESC}Pq!999999~${ESC}\\` + "still-safe";
		const decoder = new TerminalGraphicsDecoder();
		expect(decoder.push(stream)).toBe("still-safe");
		decoder.finish();
		expect(await decoder.images()).toEqual([]);
	});
});

describe("encodeTerminalImage", () => {
	it("emits interoperable direct PNG Kitty framing that the decoder round-trips", async () => {
		const encoded = await encodeTerminalImage({ type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" });
		expect(encoded).toStartWith(`${ESC}_Ga=T,t=d,f=100,q=2,m=0;`);
		expect(encoded).toEndWith(`${ESC}\\`);

		const result = await decodeByCodeUnit(`x${encoded}y`);
		expect(result.text).toBe("xy");
		expect(result.images).toHaveLength(1);
		expect(await metadata(result.images[0]!)).toMatchObject({ width: 1, height: 1, format: "png" });
	});

	it("converts non-PNG input before declaring f=100", async () => {
		const jpeg = await new Bun.Image(RED_1X1_PNG).jpeg({ quality: 90 }).toBase64();
		const encoded = await encodeTerminalImage({ type: "image", data: jpeg, mimeType: "image/jpeg" });
		const result = await decodeByCodeUnit(encoded);

		expect(encoded).toContain("f=100");
		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(await metadata(result.images[0]!)).toMatchObject({ width: 1, height: 1, format: "png" });
	});
});
