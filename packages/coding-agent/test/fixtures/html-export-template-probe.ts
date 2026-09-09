import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getTemplate } from "../../src/export/html/index";

const first = getTemplate();
const removeAssets = process.argv.includes("--remove-assets-after-first-use");
let assetsRemoved = 0;
if (removeAssets) {
	for (const name of fs.readdirSync(import.meta.dir)) {
		if (/^(?:template-[^.]+\.(?:css|html|js)|tool-views\.generated-[^.]+\.js)$/.test(name)) {
			fs.rmSync(path.join(import.meta.dir, name));
			assetsRemoved++;
		}
	}
}
const repeated = getTemplate();

process.stdout.write(
	JSON.stringify({
		chars: first.length,
		bytes: Buffer.byteLength(first),
		sha256: createHash("sha256").update(first).digest("hex"),
		stableCache: repeated === first,
		assetsRemoved,
	}),
);
