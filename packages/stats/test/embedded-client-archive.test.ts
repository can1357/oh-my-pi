import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildArchiveBase64 } from "../scripts/generate-client-bundle";

const tempDirs: string[] = [];

async function createFixture(order: readonly string[]): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-archive-"));
	tempDirs.push(root);
	for (const relativePath of order) {
		const filePath = path.join(root, relativePath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await Bun.write(filePath, relativePath === "index.html" ? "<main>OMP</main>" : "body { color: blue; }");
	}
	return root;
}

function tarHeaderMtimes(bytes: Uint8Array): number[] {
	const mtimes: number[] = [];
	for (let offset = 0; offset + 512 <= bytes.length;) {
		const header = bytes.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) break;
		const sizeField = Buffer.from(header.subarray(124, 136)).toString("ascii").replace(/\0.*$/, "").trim();
		const mtimeField = Buffer.from(header.subarray(136, 148)).toString("ascii").replace(/\0.*$/, "").trim();
		const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
		mtimes.push(mtimeField ? Number.parseInt(mtimeField, 8) : 0);
		offset += 512 * (1 + Math.ceil(size / 512));
	}
	return mtimes;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("embedded stats client archive", () => {
	test("is byte-stable across filesystem order and carries zero timestamps", async () => {
		const firstDir = await createFixture(["index.html", "assets/app.css"]);
		const secondDir = await createFixture(["assets/app.css", "index.html"]);

		const first = await buildArchiveBase64(firstDir);
		const second = await buildArchiveBase64(secondDir);
		expect(second).toBe(first);

		const gzipBytes = Buffer.from(first, "base64");
		expect(gzipBytes.readUInt32LE(4)).toBe(0);
		const tarBytes = Bun.gunzipSync(gzipBytes);
		expect(tarHeaderMtimes(tarBytes)).toEqual([0, 0]);

		const files = await new Bun.Archive(gzipBytes).files();
		expect(await files.get("index.html")?.text()).toBe("<main>OMP</main>");
		expect(await files.get("assets/app.css")?.text()).toBe("body { color: blue; }");
	});
});
