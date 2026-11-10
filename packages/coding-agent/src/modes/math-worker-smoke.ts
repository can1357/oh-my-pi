import { inflateSync } from "node:zlib";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { MathImageWorkerClient } from "./math-image-renderer";
const SMOKE_FORMULAS = [
	"x+y=1",
	String.raw`\frac{a}{b}`,
	String.raw`\begin{aligned}a&=b+c\\d&=e\end{aligned}`,
	String.raw`f(x)=\begin{cases}x&x>0\\0&x\le0\end{cases}`,
	String.raw`\begin{numcases}{f(x)=}x&$x>0$\\0&$x\le0$\end{numcases}`,
	String.raw`\begin{empheq}[left=\empheqlbrace]{align}a&=b\\c&=d\end{empheq}`,
	String.raw`\coloneqq\boldsymbol{\alpha}\Braket{x|y}\cancel{x}\color{red}{y}\mathcal{F}\mathbf{A}\Gamma`,
	String.raw`\newcommand{\localmath}[1]{#1^2}\localmath{x}`,
];

/** Exercise production conversion and native rasterization independently of terminal preferences. */
export async function smokeTestMathImageRenderer(): Promise<void> {
	const client = new MathImageWorkerClient();
	client.beginLifecycle();
	try {
		for (const tex of SMOKE_FORMULAS) {
			const result = await client.render({
				tex,
				display: tex !== "x+y=1",
				inkHex: "#ffffff",
				cellWidthPx: 9,
				cellHeightPx: 18,
				pixelsPerEx: 9,
				maxWidthPx: 720,
			});
			if (![result.widthEx, result.heightEx].every(value => Number.isFinite(value) && value > 0))
				throw new Error("Invalid intrinsic math dimensions");
			const svg = result.svg
				.replace(/width="[^"]+"/, `width="${result.widthEx * 9}"`)
				.replace(/height="[^"]+"/, `height="${result.heightEx * 9}"`);
			const png = await rasterizeSvg(new TextEncoder().encode(svg), 720, 4096, 1);
			if (!Buffer.from(png.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
				throw new Error("Math smoke produced invalid PNG");
			const image = new Bun.Image(png);
			const metadata = await image.metadata();
			if (metadata.width <= 0 || metadata.height <= 0 || metadata.width > 720 || metadata.height > 4096)
				throw new Error("Math smoke produced invalid dimensions");
			// Decode and reduce to one pixel. Its alpha proves visible ink, not just a valid PNG header.
			const pixel = Buffer.from(await image.resize(1, 1).png().bytes());
			const chunks: Buffer[] = [];
			for (let offset = 8; offset + 12 <= pixel.length;) {
				const length = pixel.readUInt32BE(offset);
				if (pixel.toString("ascii", offset + 4, offset + 8) === "IDAT")
					chunks.push(pixel.subarray(offset + 8, offset + 8 + length));
				offset += 12 + length;
			}
			const decoded = inflateSync(Buffer.concat(chunks));
			if (pixel[25] !== 6 || decoded.length !== 5 || decoded[4] === 0)
				throw new Error("Math smoke produced transparent output");
		}
	} finally {
		client.dispose();
	}
}
