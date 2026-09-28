/** Cached author photos supplied by the command host. */
export interface AvatarSource {
	get(email: string, cwd: string): string | null | undefined;
}

/**
 * Deterministic 5x5 mirrored identicon rendered as half-block rows (3 lines,
 * 10 columns). Used while an avatar loads and when none exists.
 */
export function identiconLines(email: string, colorize: (hex: string, text: string) => string): string[] {
	const bytes = new Bun.CryptoHasher("md5").update(email.trim().toLowerCase()).digest();
	const hue = ((bytes[0] << 8) | bytes[1]) % 360;
	const hex = hslToHex(hue, 0.55, 0.58);
	const on = (x: number, y: number): boolean => {
		const column = x < 3 ? x : 4 - x;
		return bytes[3 + column * 5 + y] % 2 === 0;
	};
	const lines: string[] = [];
	for (let row = 0; row < 3; row++) {
		let line = "";
		for (let x = 0; x < 5; x++) {
			const top = on(x, row * 2);
			const bottom = row * 2 + 1 < 5 && on(x, row * 2 + 1);
			const cell = top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
			line += cell.repeat(2);
		}
		lines.push(colorize(hex, line));
	}
	return lines;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
	const base = lightness - chroma / 2;
	const sector = Math.floor(hue / 60) % 6;
	const rgb = [
		[chroma, second, 0],
		[second, chroma, 0],
		[0, chroma, second],
		[0, second, chroma],
		[second, 0, chroma],
		[chroma, 0, second],
	][sector];
	return `#${rgb
		.map(channel =>
			Math.round((channel + base) * 255)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}
