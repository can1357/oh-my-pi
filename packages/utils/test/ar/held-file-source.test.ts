import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { UTF8_DECODER } from "../../src/ar/bytes";
import { heldFileSource, readAllBytes } from "../../src/ar/source";
import { TempDir } from "../../src/temp";

const OPENED = "the archive the handle opened";

describe("ar source over a held file handle", () => {
	test("reads at the requested offsets without moving the handle's position", async () => {
		using dir = TempDir.createSync("@omp-held-file-source-");
		const archive = dir.join("archive.bin");
		await Bun.write(archive, OPENED);
		const handle = await fs.open(archive, "r");
		try {
			const sequential = new Uint8Array(1);
			await handle.read(sequential, 0, 1, null);
			expect(UTF8_DECODER.decode(sequential)).toBe("t");

			const source = await heldFileSource(handle);
			expect(UTF8_DECODER.decode(await source.read(16, 22))).toBe("handle");
			expect(UTF8_DECODER.decode(await source.read(4, 11))).toBe("archive");

			await handle.read(sequential, 0, 1, null);
			expect(UTF8_DECODER.decode(sequential)).toBe("h");
		} finally {
			await handle.close();
		}
	});

	// Windows can refuse to rename over a file that is still open.
	test.skipIf(process.platform === "win32")(
		"reads the file its handle opened, not a file renamed over its path since",
		async () => {
			using dir = TempDir.createSync("@omp-held-file-source-");
			const archive = dir.join("archive.bin");
			const replacement = dir.join("replacement.bin");
			await Bun.write(archive, OPENED);
			const handle = await fs.open(archive, "r");
			try {
				const source = await heldFileSource(handle);
				await Bun.write(replacement, "another file, renamed over the archive's path");
				await fs.rename(replacement, archive);

				expect(UTF8_DECODER.decode(await readAllBytes(source))).toBe(OPENED);
			} finally {
				await handle.close();
			}
		},
	);
});
