import * as fs from "node:fs/promises";
import * as path from "node:path";

const extensionDir = path.resolve(import.meta.dir, "../dist/extension");
const embeddedDir = path.resolve(import.meta.dir, "../../coding-agent/src/tools/browser/relay/extension-assets");
const html = await Bun.file(path.join(extensionDir, "options.html")).text();
const script = await Bun.file(path.join(extensionDir, "options.js")).text();

for (const marker of ['data-i18n="browserRelay.', 'id="language"']) {
	if (!html.includes(marker)) throw new Error(`extension options HTML is missing ${marker}`);
}
for (const marker of ['"en"', '"zh-CN"', "chrome.storage.local", "locale"]) {
	if (!script.includes(marker)) throw new Error(`extension options JS is missing ${marker}`);
}

const embeddedAssets = [
	["background.js", "background.js.txt"],
	["manifest.json", "manifest.json.txt"],
	["options.html", "options.html.txt"],
	["options.js", "options.js.txt"],
	["LICENSE", "LICENSE.txt"],
	["THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"],
] as const;
for (const [source, destination] of embeddedAssets) {
	const [built, embedded] = await Promise.all([
		fs.readFile(path.join(extensionDir, source)),
		fs.readFile(path.join(embeddedDir, destination)),
	]);
	if (!built.equals(embedded)) throw new Error(`embedded asset is stale: ${destination}`);
}

console.log("browser relay extension assets: ok");
