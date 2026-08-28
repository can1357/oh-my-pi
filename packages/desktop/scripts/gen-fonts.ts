/**
 * Fetches MesloLG Nerd Font from a pinned Nerd Fonts release and writes the
 * WOFF2 files the app ships.
 *
 * The fonts are committed, so this is not part of any build — it exists so the
 * bytes in `src/assets/fonts` can be reproduced instead of taken on trust. The
 * release tag and its digest are pinned for the same reason.
 *
 *   bun scripts/gen-fonts.ts
 */
import { mkdir } from "node:fs/promises";
import { compress } from "wawoff2";

const RELEASE = "v3.5.1";
const ARCHIVE = `https://github.com/ryanoasis/nerd-fonts/releases/download/${RELEASE}/Meslo.tar.xz`;
const SHA256 = "6b6624632dc6873dfb7681c3f818e7c01ab601ab707690b6440933bbe57e2b11";

/*
 * Regular, bold and italic. Bold-italic appears in `***this***` and almost
 * nowhere else, and the engine synthesises it well enough to be worth 1.1 MB.
 */
const FACES = ["Regular", "Bold", "Italic"] as const;

const OUT = new URL("../src/assets/fonts/", import.meta.url);
const WORK = new URL("../.fonts-work/", import.meta.url);

await mkdir(WORK, { recursive: true });
await mkdir(OUT, { recursive: true });

const archive = new URL("Meslo.tar.xz", WORK);
console.log(`fetching ${ARCHIVE}`);
const response = await fetch(ARCHIVE);
if (!response.ok) throw new Error(`${ARCHIVE} → ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());

const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
if (digest !== SHA256) throw new Error(`archive digest ${digest} does not match the pinned ${SHA256}`);
await Bun.write(archive, bytes);

const members = FACES.map(face => `MesloLGMNerdFont-${face}.ttf`);
const extract = Bun.spawnSync(["tar", "-xJf", Bun.fileURLToPath(archive), "LICENSE.txt", ...members], {
	cwd: Bun.fileURLToPath(WORK),
});
if (extract.exitCode !== 0) throw new Error(`tar failed: ${extract.stderr.toString()}`);

/* The licence travels with the files it covers, not just with the notices. */
await Bun.write(new URL("LICENSE.txt", OUT), Bun.file(new URL("LICENSE.txt", WORK)));

for (const face of FACES) {
	const ttf = new Uint8Array(await Bun.file(new URL(`MesloLGMNerdFont-${face}.ttf`, WORK)).arrayBuffer());
	const woff2 = await compress(ttf);
	await Bun.write(new URL(`MesloLGMNerdFont-${face}.woff2`, OUT), woff2);
	console.log(
		`${face}: ${(ttf.byteLength / 1048576).toFixed(2)} MB ttf → ${(woff2.length / 1048576).toFixed(2)} MB woff2`,
	);
}

console.log(`wrote ${FACES.length} faces to ${Bun.fileURLToPath(OUT)}`);
