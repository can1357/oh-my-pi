import { describe, expect, it } from "bun:test";
import { convertToPng } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("legacy shim image conversion", () => {
	it("preserves PNG attachments without re-encoding", async () => {
		await expect(convertToPng(RED_1X1_PNG_BASE64, "image/png")).resolves.toEqual({
			data: RED_1X1_PNG_BASE64,
			mimeType: "image/png",
		});
	});

	it("converts decodable image attachments to PNG", async () => {
		const jpeg = await new Bun.Image(Buffer.from(RED_1X1_PNG_BASE64, "base64")).jpeg({ quality: 90 }).toBase64();
		const converted = await convertToPng(jpeg, "image/jpeg");

		expect(converted?.mimeType).toBe("image/png");
		expect(Buffer.from(converted?.data ?? "", "base64").subarray(0, PNG_SIGNATURE.byteLength)).toEqual(PNG_SIGNATURE);
	});

	it("returns null when image decoding fails", async () => {
		await expect(convertToPng("not-base64-image-data", "image/jpeg")).resolves.toBeNull();
	});
});
