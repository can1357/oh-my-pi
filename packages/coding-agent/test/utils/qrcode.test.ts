import { describe, expect, it } from "bun:test";
import { QrCode, type QrEcLevel, renderQrHalfBlocks } from "@oh-my-pi/pi-coding-agent/utils/qrcode";

function matrixFingerprint(qr: QrCode): string {
	let bits = "";
	for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) bits += qr.module(x, y) ? "1" : "0";
	return new Bun.CryptoHasher("sha256").update(bits).digest("hex").slice(0, 16);
}

describe("QR encoder", () => {
	// Golden vectors captured from the encoder after byte-for-byte cross-validation
	// against the `qrcode` reference library (all versions/EC levels/masks) and a
	// real jsQR decode. A changed hash means the symbol bytes drifted.
	const vectors: ReadonlyArray<{
		text: string;
		ecl: QrEcLevel;
		mask: number;
		version: number;
		size: number;
		hash: string;
	}> = [
		{ text: "HELLO WORLD", ecl: "M", mask: 0, version: 1, size: 21, hash: "a28227450c6dd5ab" },
		{
			text: "https://my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU",
			ecl: "M",
			mask: 4,
			version: 4,
			size: 33,
			hash: "4af2f66e1b06a5b1",
		},
		{
			text: "https://web.example/collab/#relay.example.com:8443/r/AbCdEfGhIjKlMnOp.0123456789abcdef",
			ecl: "Q",
			mask: 6,
			version: 7,
			size: 45,
			hash: "2ca4a51e3cba1adf",
		},
		{ text: "x", ecl: "L", mask: 1, version: 1, size: 21, hash: "d1330f755ac63f88" },
	];

	for (const v of vectors) {
		it(`produces a stable symbol for ${JSON.stringify(v.text).slice(0, 32)} (${v.ecl})`, () => {
			const qr = QrCode.encodeText(v.text, v.ecl, { mask: v.mask });
			expect(qr.version).toBe(v.version);
			expect(qr.size).toBe(v.size);
			expect(qr.mask).toBe(v.mask);
			expect(matrixFingerprint(qr)).toBe(v.hash);
		});
	}

	it("auto-selects the smallest version that fits the byte payload", () => {
		// Byte-mode, EC level M capacities: v1=14, v2=26, v3=42 data bytes.
		expect(QrCode.encodeText("a".repeat(14), "M").version).toBe(1);
		expect(QrCode.encodeText("a".repeat(15), "M").version).toBe(2);
		expect(QrCode.encodeText("a".repeat(26), "M").version).toBe(2);
		expect(QrCode.encodeText("a".repeat(27), "M").version).toBe(3);
	});

	it("sizes by UTF-8 byte length, not string length", () => {
		// "日" is 3 UTF-8 bytes; five of them = 15 bytes, just over v1-M's 14.
		expect(QrCode.encodeText("日".repeat(5), "M").version).toBe(2);
	});

	it("deterministically selects a penalty-minimizing mask when none is forced", () => {
		// Auto mask is the lowest-penalty choice; locking it guards the penalty rules.
		const qr = QrCode.encodeText("https://my.omp.sh/#demo", "M");
		expect(qr.mask).toBe(1);
		expect(matrixFingerprint(qr)).toBe("ee820c588fe36d99");
	});

	it("throws when the payload exceeds version 40 at the chosen EC level", () => {
		// v40-H holds 1273 data bytes.
		expect(() => QrCode.encodeText("a".repeat(1274), "H")).toThrow(/too long/);
	});

	it("places the three finder patterns at the symbol corners", () => {
		const qr = QrCode.encodeText("finder", "M");
		// A finder is a 7x7 dark ring: the outer corner is dark and the module one
		// step diagonally inward (the separating gap) is light.
		const finderCorner = (ox: number, oy: number): boolean =>
			qr.module(ox, oy) && !qr.module(ox + (ox === 0 ? 1 : -1), oy + (oy === 0 ? 1 : -1));
		expect(finderCorner(0, 0)).toBe(true);
		expect(finderCorner(qr.size - 1, 0)).toBe(true);
		expect(finderCorner(0, qr.size - 1)).toBe(true);
	});
});

describe("renderQrHalfBlocks", () => {
	it("frames the symbol in a light quiet zone wide enough for the margin", () => {
		const qr = QrCode.encodeText("https://omp.sh/#demo", "M");
		const margin = 3;
		const lines = renderQrHalfBlocks(qr, { margin });
		// Visible cell width = symbol + both margins.
		const stripped = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(stripped[0]!.length).toBe(qr.size + margin * 2);
		// Top quiet rows (margin/2 paired rows) carry no dark half-blocks.
		const quietRows = Math.floor(margin / 2);
		for (let i = 0; i < quietRows; i++) {
			expect(stripped[i]).toBe(" ".repeat(qr.size + margin * 2));
		}
		// Body rows use half-block glyphs and a white-background/black-foreground prefix.
		const body = lines[quietRows + 2]!;
		expect(body).toContain("\x1b[47m");
		expect(body).toMatch(/[▀▄█]/);
	});

	it("emits ceil((size + 2*margin)/2) rows", () => {
		const qr = QrCode.encodeText("rows", "M");
		const margin = 4;
		const lines = renderQrHalfBlocks(qr, { margin });
		expect(lines.length).toBe(Math.ceil((qr.size + margin * 2) / 2));
	});
});
