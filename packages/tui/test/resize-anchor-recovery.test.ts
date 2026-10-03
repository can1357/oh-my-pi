import { expect, it } from "bun:test";
import { KittyTerminal, loadModuleSync } from "kitty-vt-wasm";

const module = loadModuleSync(Bun.resolveSync("kitty-vt-wasm/kitty-vt.wasm", import.meta.dir));

function makeTerm(columns: number, rows: number) {
	let output = "";
	const term = KittyTerminal.createSync({
		columns,
		rows,
		scrollback: 2000,
		wasm: module,
		onOutput: (bytes: Uint8Array) => {
			output += new TextDecoder().decode(bytes);
		},
	});
	return {
		term,
		takeOutput: () => {
			const out = output;
			output = "";
			return out;
		},
	};
}

function cprRow(reply: string): number {
	const match = reply.match(/\x1b\[(\d+);(\d+)R/);
	if (!match) throw new Error(`no CPR in ${JSON.stringify(reply)}`);
	return Number(match[1]) - 1;
}

function findRow(term: KittyTerminal, prefix: string): number {
	for (let y = 0; y < term.rows; y++) if (term.line(y).startsWith(prefix)) return y;
	return -1;
}

/** The anchor recovery formula under test: top = min(R, height - staleReflowedRows). */
function recoverTop(reported: number, staleReflowedRows: number, height: number): number {
	return Math.max(0, Math.min(reported, height - staleReflowedRows));
}

it("height shrink with blank rows below the viewport", () => {
	// Content occupies rows 0..8 (viewport 6..8), rows 9..11 erased blanks.
	const { term, takeOutput } = makeTerm(40, 12);
	term.write(`${Array.from({ length: 6 }, (_, i) => `hist-${i}`).join("\r\n")}\r\n`);
	term.write("VIEW-TOP\r\nVIEW-MID\r\nVIEW-BOT");
	term.write("\x1b[J"); // erase below (BCE blanks)
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	// Shrink by 3: exactly the blank rows. If kitty clips blanks first, no push.
	term.resize(40, 9);
	term.write("\x1b[6n");
	const r1 = cprRow(takeOutput());
	console.log("shrink-to-content: reported", r1, "actual", findRow(term, "VIEW-TOP"));
	expect(recoverTop(r1, 3, 9)).toBe(findRow(term, "VIEW-TOP"));

	// Shrink 2 more: now content must push into scrollback.
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	term.resize(40, 7);
	term.write("\x1b[6n");
	const r2 = cprRow(takeOutput());
	console.log("shrink-into-content: reported", r2, "actual", findRow(term, "VIEW-TOP"));
	for (let y = 0; y < 7; y++) console.log(y, JSON.stringify(term.line(y)));
	expect(recoverTop(r2, 3, 7)).toBe(findRow(term, "VIEW-TOP"));
});

it("recovery formula on full-screen height shrink", () => {
	const { term, takeOutput } = makeTerm(40, 12);
	term.write(`${Array.from({ length: 9 }, (_, i) => `hist-${i}`).join("\r\n")}\r\n`);
	term.write("VIEW-TOP\r\nVIEW-MID\r\nVIEW-BOT");
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	term.resize(40, 7);
	term.write("\x1b[6n");
	const r = cprRow(takeOutput());
	expect(recoverTop(r, 3, 7)).toBe(findRow(term, "VIEW-TOP"));
});

it("recovery formula on combined width+height resize", () => {
	const { term, takeOutput } = makeTerm(40, 12);
	term.write(`hist-long-${"y".repeat(70)}\r\n`);
	term.write(`${Array.from({ length: 6 }, (_, i) => `hist-${i}`).join("\r\n")}\r\n`);
	// A viewport row that wraps at the new width (34 visible cells).
	const wide = `VIEW-TOP-${"z".repeat(25)}`;
	term.write(`${wide}\r\nVIEW-MID\r\nVIEW-BOT`);
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	term.resize(28, 8);
	term.write("\x1b[6n");
	const r = cprRow(takeOutput());
	// Stale viewport reflowed rows at width 28: wide(34)→2, mid→1, bot→1 = 4.
	const actual = findRow(term, "VIEW-TOP");
	console.log("combined: reported", r, "actual", actual, "recovered", recoverTop(r, 4, 8));
	for (let y = 0; y < 8; y++) console.log(y, JSON.stringify(term.line(y)));
	expect(recoverTop(r, 4, 8)).toBe(actual);
});

it("recovery formula on width grow (unwrap)", () => {
	const { term, takeOutput } = makeTerm(30, 12);
	term.write(`hist-long-${"y".repeat(45)}\r\n`); // wraps to 2 rows at 30
	term.write(`${Array.from({ length: 4 }, (_, i) => `hist-${i}`).join("\r\n")}\r\n`);
	term.write("VIEW-TOP\r\nVIEW-MID\r\nVIEW-BOT");
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	term.resize(60, 12);
	term.write("\x1b[6n");
	const r = cprRow(takeOutput());
	const actual = findRow(term, "VIEW-TOP");
	console.log("width-grow: reported", r, "actual", actual, "recovered", recoverTop(r, 3, 12));
	expect(recoverTop(r, 3, 12)).toBe(actual);
});

it("recovery formula across a multi-step drag with an alt-screen borrow", () => {
	const { term, takeOutput } = makeTerm(40, 12);
	term.write(`hist-long-${"y".repeat(70)}\r\n`);
	term.write(`${Array.from({ length: 6 }, (_, i) => `hist-${i}`).join("\r\n")}\r\n`);
	const wide = `VIEW-TOP-${"z".repeat(25)}`;
	term.write(`${wide}\r\nVIEW-MID\r\nVIEW-BOT`);
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	// Enter alt (saves main cursor), drag through several sizes, exit alt.
	term.write("\x1b[?1049h");
	term.resize(36, 11);
	term.write("\x1b[2J\x1b[HALT");
	term.resize(31, 9);
	term.write("\x1b[2J\x1b[HALT");
	term.resize(28, 8);
	term.write("\x1b[?1049l\x1b[6n");
	const r = cprRow(takeOutput());
	const actual = findRow(term, "VIEW-TOP");
	// Stale viewport at 28 wide: 2+1+1 = 4 rows.
	console.log("drag: reported", r, "actual", actual, "recovered", recoverTop(r, 4, 8));
	for (let y = 0; y < 8; y++) console.log(y, JSON.stringify(term.line(y)));
	expect(recoverTop(r, 4, 8)).toBe(actual);
});
