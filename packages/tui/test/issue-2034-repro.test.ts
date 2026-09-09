import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { chunkForConPTY, ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// Regression test for https://github.com/can1357/oh-my-pi/issues/2034
//
// Windows ConPTY ties viewport tracking to per-`WriteFile` boundaries: when
// a single `process.stdout.write` exceeds ~32-64 KB, the pseudo-console
// stops following the cursor and the host UI's scroll position stays parked
// at wherever the write began. The data lands in scrollback — Alt+Tab forces
// the host to re-query the cursor and the viewport jumps to the bottom —
// but until then the user sees only the first screenful of a long session
// or resume payload.
//
// Fix: `ProcessTerminal#safeWrite` chunks writes whose encoded UTF-8 byte
// length exceeds 16 KiB into newline-aligned pieces on `process.platform ===
// "win32"` and on WSL (`linux` plus `WSL_DISTRO_NAME`/`WSL_INTEROP`). Other
// platforms keep the single-write fast path.
//
// The cap is on encoded UTF-8 bytes, not JS code units: `process.stdout.write`
// UTF-8-encodes before `WriteFile`, so a code-unit cap would let CJK rows
// expand past the threshold (3 bytes per BMP char) and reintroduce the bug.

const ESC = "\x1b";

function buildFullPaint(lines: number, lineLength: number): string {
	// Mirrors the shape of `TUI#emitFullPaint`'s buffer: a clear-screen prefix,
	// rows terminated with `\r\n` and a per-line SGR reset, and a cursor/end
	// sequence trailer. The exact bytes do not matter for the chunker — only
	// that escapes are present and the buffer crosses the ConPTY threshold.
	let buf = `${ESC}[2J${ESC}[H${ESC}[3J`;
	for (let i = 0; i < lines; i++) {
		if (i > 0) buf += "\r\n";
		const content = `${ESC}[38;5;${i % 256}mrow-${i.toString().padStart(4, "0")}: ${"x".repeat(lineLength)}${ESC}[0m`;
		buf += content;
	}
	buf += `${ESC}[H${ESC}[?25h`;
	return buf;
}

describe("issue #2034: chunk large terminal writes on Windows ConPTY", () => {
	describe("chunkForConPTY()", () => {
		it("returns the original buffer untouched when its UTF-8 byte length is under the chunk size", () => {
			const data = "small payload";
			expect(chunkForConPTY(data, 1024)).toEqual([data]);
		});

		it("splits a large multi-line buffer into pieces no larger than the byte cap", () => {
			const data = buildFullPaint(2000, 60);
			const max = 16 * 1024;
			expect(Buffer.byteLength(data, "utf8")).toBeGreaterThan(max);

			const chunks = chunkForConPTY(data, max);

			expect(chunks.length).toBeGreaterThan(1);
			for (const chunk of chunks) {
				expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(max);
			}
		});

		it("preserves the full payload across chunks (no data loss or reordering)", () => {
			const data = buildFullPaint(500, 120);
			const chunks = chunkForConPTY(data, 4 * 1024);
			expect(chunks.join("")).toBe(data);
		});

		it("splits at newline boundaries so escape sequences are never sliced apart", () => {
			// Every row is bracketed by SGR escapes. If the chunker cut inside a
			// chunk's escape sequence, the trailing chunk would not start with
			// either an escape or the post-newline state — instead it would
			// start with a stray CSI byte (`[`, digits, `m`).
			const data = buildFullPaint(400, 80);
			const chunks = chunkForConPTY(data, 4 * 1024);
			// Exclude the head chunk (starts with the clear-screen prefix).
			for (const chunk of chunks.slice(1)) {
				// Every subsequent chunk begins on a fresh line: either the new
				// line's first byte is the SGR escape, the row's plaintext
				// prefix, or — for the trailing tail — the cursor sequence.
				const firstByte = chunk.charCodeAt(0);
				const startsWithEsc = chunk.startsWith(ESC);
				const startsWithRowText = chunk.startsWith("row-");
				expect(startsWithEsc || startsWithRowText).toBe(true);
				if (!startsWithEsc) {
					// Plain-text starts cannot be control characters that would
					// indicate a sliced escape (CSI `[`, digits, or `m`).
					expect(firstByte).toBeGreaterThanOrEqual(0x20);
				}
			}
		});

		it("makes forward progress on a single line longer than the chunk size", () => {
			// Pathological case: one very long line with no embedded `\n`. The
			// chunker must not loop, and the joined chunks must equal the input.
			const giantLine = "a".repeat(20_000);
			const data = `${giantLine}\nshort\n`;
			const chunks = chunkForConPTY(data, 4 * 1024);
			expect(chunks.length).toBeGreaterThanOrEqual(2);
			expect(chunks.join("")).toBe(data);
		});

		it("falls back to a raw split when the buffer contains no newlines", () => {
			const data = "x".repeat(20_000);
			const chunks = chunkForConPTY(data, 4 * 1024);
			expect(chunks.join("")).toBe(data);
			expect(chunks.length).toBeGreaterThan(1);
			// Every chunk except possibly the tail saturates the byte cap. For an
			// ASCII source the chunker fits exactly 4 KiB code units per chunk
			// (1 byte each), so we can assert the exact length here.
			for (const chunk of chunks.slice(0, -1)) {
				expect(Buffer.byteLength(chunk, "utf8")).toBe(4 * 1024);
			}
		});

		it("caps by encoded UTF-8 bytes, not JS code units, so CJK transcripts stay under the threshold (#2095)", () => {
			// Each CJK ideograph is one BMP code unit but encodes to 3 UTF-8
			// bytes. A code-unit-based cap would silently let a write reach
			// ~3× the configured size and reintroduce the #2034 viewport bug
			// for non-ASCII content (codex review on #2101).
			const cjkLine = "字".repeat(200); // 200 code units, 600 UTF-8 bytes
			const rows: string[] = [];
			for (let i = 0; i < 200; i++) rows.push(cjkLine);
			const data = `${rows.join("\n")}\n`;
			const max = 4 * 1024;
			expect(Buffer.byteLength(data, "utf8")).toBeGreaterThan(max * 4);

			const chunks = chunkForConPTY(data, max);

			expect(chunks.length).toBeGreaterThan(1);
			expect(chunks.join("")).toBe(data);
			for (const chunk of chunks) {
				// The contract is on encoded bytes — not chunk.length.
				expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(max);
			}
		});

		it("keeps surrogate pairs intact when cutting at the byte cap", () => {
			// 😀 (U+1F600) is a non-BMP code point: two UTF-16 surrogate code
			// units encoding to 4 UTF-8 bytes. The chunker must never split
			// the pair — a lone surrogate would round-trip as U+FFFD and
			// silently mangle emoji-heavy transcripts.
			const emoji = "😀"; // 2 code units, 4 bytes
			// 1024 emoji = 2048 code units = 4096 bytes, no newlines so we hit
			// the hard-cut path; cap at 1024 bytes forces ~4 cuts.
			const data = emoji.repeat(1024);
			const chunks = chunkForConPTY(data, 1024);
			expect(chunks.join("")).toBe(data);
			for (const chunk of chunks) {
				// No chunk ends with an unpaired high surrogate, none starts
				// with an unpaired low surrogate.
				const last = chunk.charCodeAt(chunk.length - 1);
				expect(last >= 0xd800 && last < 0xdc00).toBe(false);
				const first = chunk.charCodeAt(0);
				expect(first >= 0xdc00 && first < 0xe000).toBe(false);
				expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(1024);
			}
		});
	});

	describe("ProcessTerminal#write platform gate", () => {
		const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const originalWslDistro = Bun.env.WSL_DISTRO_NAME;
		const originalWslInterop = Bun.env.WSL_INTEROP;
		// This block drives the real ProcessTerminal#write path, so it opts out of
		// the test-default headless suppression for the duration of each case.
		let previousHeadless = false;

		function setEnv(key: string, value: string | undefined): void {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}

		beforeEach(() => {
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			// Clear WSL markers by default; tests opt in.
			setEnv("WSL_DISTRO_NAME", undefined);
			setEnv("WSL_INTEROP", undefined);
			previousHeadless = setTerminalHeadless(false);
		});

		afterEach(() => {
			vi.restoreAllMocks();
			setTerminalHeadless(previousHeadless);
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
			if (stdinIsTtyDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
			else Reflect.deleteProperty(process.stdin, "isTTY");
			if (stdoutIsTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			setEnv("WSL_DISTRO_NAME", originalWslDistro);
			setEnv("WSL_INTEROP", originalWslInterop);
		});

		function captureStdoutWrites(): string[] {
			const writes: string[] = [];
			vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
				writes.push(typeof chunk === "string" ? chunk : chunk.toString());
				return true;
			});
			return writes;
		}

		it("splits >16 KiB writes into chunks on win32 so ConPTY can track the viewport", () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			const writes = captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const payload = buildFullPaint(2000, 60);

			terminal.write(payload);

			const conptyChunks = writes.filter(w => w.length > 0);
			expect(conptyChunks.length).toBeGreaterThan(1);
			for (const chunk of conptyChunks) {
				expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(16 * 1024);
			}
			expect(conptyChunks.join("")).toBe(payload);
		});

		it("splits >16 KiB writes inside WSL because stdout still crosses ConPTY at wslhost", () => {
			Object.defineProperty(process, "platform", { value: "linux", configurable: true });
			setEnv("WSL_DISTRO_NAME", "Ubuntu");
			setEnv("WSL_INTEROP", "/run/WSL/123_interop");
			const writes = captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const payload = buildFullPaint(2000, 60);

			terminal.write(payload);

			const conptyChunks = writes.filter(w => w.length > 0);
			expect(conptyChunks.length).toBeGreaterThan(1);
			for (const chunk of conptyChunks) {
				expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(16 * 1024);
			}
			expect(conptyChunks.join("")).toBe(payload);
		});

		it("keeps the single-write fast path on non-ConPTY platforms (clean linux, darwin)", () => {
			Object.defineProperty(process, "platform", { value: "linux", configurable: true });
			const writes = captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const payload = buildFullPaint(2000, 60);

			terminal.write(payload);

			expect(writes).toEqual([payload]);
		});

		it("does not chunk small writes on win32", () => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			const writes = captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const payload = `${ESC}[H${ESC}[K`;

			terminal.write(payload);

			expect(writes).toEqual([payload]);
		});

		it("chunks a CJK payload on win32 whose code-unit length fits but encoded bytes don't (#2095)", () => {
			// 200 BMP code units / row × 3 bytes each = 600 bytes / row. 30 rows
			// = 6000 code units but 18 KiB UTF-8 bytes — code-unit check alone
			// would let the whole burst through as a single oversized WriteFile.
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			const writes = captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const row = "字".repeat(200);
			let payload = "";
			for (let i = 0; i < 30; i++) payload += (i > 0 ? "\n" : "") + row;
			expect(payload.length).toBeLessThan(16 * 1024);
			expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(16 * 1024);

			terminal.write(payload);

			const conptyChunks = writes.filter(w => w.length > 0);
			expect(conptyChunks.length).toBeGreaterThan(1);
			for (const chunk of conptyChunks) {
				expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(16 * 1024);
			}
			expect(conptyChunks.join("")).toBe(payload);
		});

		it("marks the terminal dead when stdout emits EIO after a write (#2284)", () => {
			const writes = captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const err = Object.assign(new Error("EIO: i/o error, write"), {
				code: "EIO",
				fd: 5,
				syscall: "write",
				errno: -5,
			});

			try {
				terminal.write("first frame");
				process.stdout.emit("error", err);
				terminal.write("second frame");

				expect(writes).toEqual(["first frame"]);
			} finally {
				terminal.stop();
			}
		});

		it("keeps stdout error events handled after stop for delayed write failures (#2284)", () => {
			captureStdoutWrites();
			const terminal = new ProcessTerminal();
			const err = Object.assign(new Error("EIO: i/o error, write"), {
				code: "EIO",
				fd: 5,
				syscall: "write",
				errno: -5,
			});

			terminal.write("restore frame");
			terminal.stop();

			expect(() => process.stdout.emit("error", err)).not.toThrow();
		});
	});
});
