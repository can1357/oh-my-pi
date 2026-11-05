import { describe, expect, it } from "bun:test";
import { ArchiveError, encodeArchive, ZipPackage } from "@oh-my-pi/pi-utils/ar";

describe("ZipPackage", () => {
	it("caps the bytes inflated across all member reads, not just per member", async () => {
		const zip = await ZipPackage.open(
			await encodeArchive("zip", [
				["a.xml", "a".repeat(600)],
				["b.xml", "b".repeat(600)],
			]),
			1000,
		);

		expect(await zip.readText("a.xml")).toBe("a".repeat(600));
		await expect(zip.readBytes("b.xml")).rejects.toThrow(ArchiveError);
	});

	it("counts a member re-read many times (a slide image reused across slides) only once", async () => {
		const zip = await ZipPackage.open(await encodeArchive("zip", [["ppt/media/logo.png", "x".repeat(600)]]), 1000);
		for (let read = 0; read < 5; read++) {
			expect((await zip.readBytes("ppt/media/logo.png"))?.length).toBe(600);
		}
	});
});
