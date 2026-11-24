import { describe, expect, it } from "bun:test";
import { InputTokenizer, type TokenizerOptions } from "../../src/driver/input/tokenizer";
import { FakeClock } from "./fake-clock";

function setup(options: TokenizerOptions = {}) {
	const clock = new FakeClock();
	const seqs: string[] = [];
	const pastes: string[] = [];
	const log: string[] = [];
	const tokenizer = new InputTokenizer(
		{
			sequence: seq => {
				seqs.push(seq);
				log.push(seq);
			},
			paste: text => {
				pastes.push(text);
				log.push(`<paste:${text}>`);
			},
		},
		{ clock, ...options },
	);
	const feed = (...reads: string[]) => {
		for (const read of reads) tokenizer.process(read);
	};
	const bytes = (text: string) => {
		for (const ch of text) tokenizer.process(ch);
	};
	return { clock, tokenizer, seqs, pastes, log, feed, bytes };
}

const FAMILIES: [string, string][] = [
	["CSI arrow", "\x1b[A"],
	["CSI modified", "\x1b[1;5C"],
	["CSI tilde", "\x1b[3;2~"],
	["SS3", "\x1bOP"],
	["kitty CSI u with event type", "\x1b[97;5:3u"],
	["kitty CSI u with alternates and text", "\x1b[97:65;2;65u"],
	["modifyOtherKeys", "\x1b[27;2;13~"],
	["SGR mouse", "\x1b[<35;20;5M"],
	["X10 mouse", "\x1b[M ab"],
	["focus in", "\x1b[I"],
	["DA1 reply", "\x1b[?62;4;22;52c"],
	["DECRPM reply", "\x1b[?2026;2$y"],
	["kitty keyboard reply", "\x1b[?5u"],
	["in-band resize", "\x1b[48;40;120;800;1200t"],
	["OSC 11 with BEL", "\x1b]11;rgb:1c1c/1c1c/1c1c\x07"],
	["OSC 11 with ST", "\x1b]11;rgb:ffff/ffff/ffff\x1b\\"],
	["DCS XTVERSION", "\x1bP>|kitty(0.39.1)\x1b\\"],
	["APC kitty graphics", "\x1b_Gi=31;OK\x1b\\"],
	["APC TSP", '\x1b_tsp;e;{"ev":"ack","sf":"s:1","s":3}\x1b\\'],
	["ConPTY TSP", '\x1b]877;tsp;e;{"ev":"theme","dark":true}\x07'],
	["meta CSI", "\x1b\x1b[A"],
	["alt chord", "\x1bp"],
];

describe("InputTokenizer reassembly", () => {
	for (const [name, seq] of FAMILIES) {
		it(`reassembles ${name} split at every byte`, () => {
			const { seqs, bytes, tokenizer } = setup();
			bytes(seq);
			expect(seqs).toEqual([seq]);
			expect(tokenizer.pending).toBe("");
		});

		it(`reassembles ${name} split at every boundary into two reads`, () => {
			for (let cut = 1; cut < seq.length; cut++) {
				const { seqs, feed } = setup();
				feed(seq.slice(0, cut), seq.slice(cut));
				expect(seqs).toEqual([seq]);
			}
		});
	}

	it("delivers text per code point, surrogate pairs whole", () => {
		const { seqs, feed } = setup();
		feed("hé🙂世");
		expect(seqs).toEqual(["h", "é", "🙂", "世"]);
	});

	it("joins a surrogate pair split across reads", () => {
		const { seqs, feed } = setup();
		feed("🙂".slice(0, 1), "🙂".slice(1));
		expect(seqs).toEqual(["🙂"]);
	});

	it("decodes UTF-8 split inside a code point across byte reads", () => {
		const { seqs, tokenizer } = setup();
		const bytes = new TextEncoder().encode("é🙂");
		for (const byte of bytes) tokenizer.process(new Uint8Array([byte]));
		expect(seqs).toEqual(["é", "🙂"]);
	});

	it("splits batched sequences and text", () => {
		const { seqs, feed } = setup();
		feed("ab\x1b[A\x1b[97u\x1b[97;1:3u\x1b[<0;1;1mc");
		expect(seqs).toEqual(["a", "b", "\x1b[A", "\x1b[97u", "\x1b[97;1:3u", "\x1b[<0;1;1m", "c"]);
	});

	it("keeps an X10 mouse report's trailing text separate", () => {
		const { seqs, feed } = setup();
		feed("\x1b[M abc");
		expect(seqs).toEqual(["\x1b[M ab", "c"]);
	});
});

describe("InputTokenizer timeouts", () => {
	it("delivers a lone ESC as Escape after the key timeout", () => {
		const { seqs, feed, clock } = setup({ keyTimeout: 20 });
		feed("\x1b");
		expect(seqs).toEqual([]);
		clock.advance(20);
		expect(seqs).toEqual(["\x1b"]);
	});

	it("holds a lone ESC under the kitty protocol and joins the tail", () => {
		const { seqs, feed, clock, tokenizer } = setup({ keyTimeout: 20, reportTimeout: 1000 });
		tokenizer.kitty = true;
		feed("\x1b");
		clock.advance(500);
		expect(seqs).toEqual([]);
		feed("[<35;8;16M");
		expect(seqs).toEqual(["\x1b[<35;8;16M"]);
	});

	it("splits ESC ESC into two Escape keys on timeout", () => {
		const { seqs, feed, clock } = setup();
		feed("\x1b\x1b");
		clock.advance(100);
		expect(seqs).toEqual(["\x1b", "\x1b"]);
	});

	it("keeps an Escape and a following Alt chord apart", () => {
		const { seqs, feed } = setup();
		feed("\x1b\x1bd");
		expect(seqs).toEqual(["\x1b", "\x1bd"]);
	});

	it("separates an Escape from a following mouse report", () => {
		const { seqs, feed } = setup();
		feed("\x1b", "\x1b[<35;22;17M");
		expect(seqs).toEqual(["\x1b", "\x1b[<35;22;17M"]);
	});

	it("flushes a partial key sequence after the sequence timeout", () => {
		const { seqs, feed, clock } = setup({ sequenceTimeout: 100 });
		feed("\x1b[1;5");
		clock.advance(99);
		expect(seqs).toEqual([]);
		clock.advance(1);
		expect(seqs).toEqual(["\x1b[1;5"]);
	});

	it("holds a split SGR mouse report past the key timeouts", () => {
		const { seqs, feed, clock } = setup();
		feed("\x1b[<35;8;16");
		clock.advance(500);
		expect(seqs).toEqual([]);
		feed("M");
		expect(seqs).toEqual(["\x1b[<35;8;16M"]);
	});

	it("holds a split private report (DA1) past the key timeouts", () => {
		const { seqs, feed, clock } = setup();
		feed("\x1b[?62");
		clock.advance(200);
		for (const ch of ";6;7;14;21;22;23;24;28;32;42;52c") feed(ch);
		expect(seqs).toEqual(["\x1b[?62;6;7;14;21;22;23;24;28;32;42;52c"]);
	});

	it("abandons a partial report when a new escape interrupts it", () => {
		const { seqs, feed } = setup();
		feed("\x1b[?62", "\x1b[A");
		expect(seqs).toEqual(["\x1b[?62", "\x1b[A"]);
	});

	it("flushes ESC [ alone as an Alt chord head", () => {
		const { seqs, feed, clock } = setup();
		feed("\x1b[");
		clock.advance(20);
		expect(seqs).toEqual(["\x1b["]);
	});

	it("resolves an Alt+] chord plus typing when no reply follows", () => {
		const { seqs, feed, clock } = setup();
		feed("\x1b]a");
		clock.advance(100);
		expect(seqs).toEqual(["\x1b]", "a"]);
	});

	it("resolves Alt+_ diverging from a TSP opener as a chord plus typing", () => {
		const { seqs, feed, clock } = setup();
		feed("\x1b_t", "x");
		clock.advance(200);
		expect(seqs).toEqual(["\x1b_", "t", "x"]);
	});
});

describe("InputTokenizer kitty duplicate printable", () => {
	it("swallows the bare duplicate of a kitty printable in the same read", () => {
		const { seqs, feed } = setup();
		feed("\x1b[97ua");
		expect(seqs).toEqual(["\x1b[97u"]);
	});

	it("keeps a real keystroke after the window", () => {
		const { seqs, feed, clock } = setup({ dedupWindow: 10 });
		feed("\x1b[97u");
		clock.advance(50);
		feed("a");
		expect(seqs).toEqual(["\x1b[97u", "a"]);
	});
});

describe("InputTokenizer bracketed paste", () => {
	it("delivers a paste whole, with input around it", () => {
		const { log, feed } = setup();
		feed("a", "\x1b[200~line1\nline2\x1b[201~", "b");
		expect(log).toEqual(["a", "<paste:line1\nline2>", "b"]);
	});

	it("assembles a paste whose markers arrive one byte at a time", () => {
		const { log, bytes } = setup();
		bytes("\x1b[200~ab\x1b[201~x");
		expect(log).toEqual(["<paste:ab>", "x"]);
	});

	it("keeps escapes and partial end markers inside paste content", () => {
		const { pastes, seqs, feed } = setup();
		const content = "before\x1b[31mred\x1b[0m\x1b[201after\x1b";
		feed(`\x1b[200~${content}`, "\x1b[201~");
		expect(pastes).toEqual([content]);
		expect(seqs).toEqual([]);
	});

	it("routes TSP messages out of an open paste, even split at every byte", () => {
		const { log, feed, bytes } = setup();
		const reply = '\x1b_tsp;e;{"ev":"ack","sf":"s:1","s":9}\x1b\\';
		const conpty = '\x1b]877;tsp;e;{"ev":"ack","sf":"s:1","s":10}\x07';
		feed("\x1b[200~before");
		bytes(reply);
		bytes(conpty);
		feed("after\x1b[201~");
		expect(log).toEqual([reply, conpty, "<paste:beforeafter>"]);
	});

	it("consumes a doubled start marker", () => {
		const { pastes, feed } = setup();
		feed("\x1b[200~\x1b[200~text\x1b[201~");
		expect(pastes).toEqual(["text"]);
	});

	it("delivers what it has when the end marker is lost", () => {
		const { log, feed, clock } = setup({ pasteTimeout: 500 });
		feed("\x1b[200~lost marker");
		clock.advance(499);
		expect(log).toEqual([]);
		clock.advance(1);
		feed("x");
		expect(log).toEqual(["<paste:lost marker>", "x"]);
	});

	it("does not let terminal messages keep a lost paste alive", () => {
		const { log, feed, clock } = setup({ pasteTimeout: 500 });
		const reply = '\x1b_tsp;e;{"ev":"ack","sf":"s:1","s":1}\x1b\\';
		feed("\x1b[200~pasted");
		for (let i = 0; i < 4; i++) {
			clock.advance(200);
			feed(reply);
		}
		expect(log).toEqual([reply, reply, "<paste:pasted>", reply, reply]);
	});

	it("keeps an unfinished TSP message on the report path when the watchdog fires", () => {
		const { log, feed, clock } = setup({ pasteTimeout: 500 });
		const reply = '\x1b_tsp;e;{"ev":"ack","sf":"s:1","s":2}\x1b\\';
		feed(`\x1b[200~pasted${reply.slice(0, -1)}`);
		clock.advance(1000);
		feed("\\x");
		expect(log).toEqual(["<paste:pasted>", reply, "x"]);
	});

	it("aborts paste mode at the UTF-8 byte cap", () => {
		const { log, feed } = setup({ pasteByteLimit: 8 });
		feed(`\x1b[200~${"é".repeat(5)}`, "x");
		expect(log).toEqual([`<paste:${"é".repeat(5)}>`, "x"]);
	});

	it("reconstructs a large paste from many small reads", () => {
		const { pastes, feed } = setup();
		const content = "0123456789abcdef".repeat(4096);
		feed("\x1b[200~");
		for (let i = 0; i < content.length; i += 64) feed(content.slice(i, i + 64));
		feed("\x1b[201~");
		expect(pastes).toEqual([content]);
	});
});

describe("InputTokenizer raw multi-line bursts", () => {
	it("coalesces a three-line burst into one paste", () => {
		const { log, feed } = setup();
		feed("line 1\rline 2\rline 3");
		expect(log).toEqual(["<paste:line 1\rline 2\rline 3>"]);
	});

	it("coalesces a burst split over adjacent reads", () => {
		const { log, feed } = setup();
		feed("line 1\r", "line 2\rline 3");
		expect(log).toEqual(["<paste:line 1\rline 2\rline 3>"]);
	});

	it("submits a CR that follows LF-delimited text", () => {
		const { log, feed } = setup();
		feed("a\nb\nc\r");
		expect(log).toEqual(["<paste:a\nb\nc>", "\r"]);
	});

	it("keeps a single Enter with a following key as typing", () => {
		const { log, feed, clock } = setup();
		feed("a\rb");
		expect(log).toEqual([]);
		clock.advance(10);
		expect(log).toEqual(["a", "\r", "b"]);
	});

	it("does not coalesce a run of bare Enters", () => {
		const { log, feed, clock } = setup();
		feed("\r\r");
		clock.advance(10);
		expect(log).toEqual(["\r", "\r"]);
	});

	it("delivers a typed Enter when the window from its read ends, however many keys follow it", () => {
		const { log, feed, clock } = setup();
		feed("\r");
		clock.advance(6);
		feed("a");
		clock.advance(4);
		// The window is not restarted by the later read: what Enter opened is there for the next key.
		expect(log).toEqual(["\r", "a"]);
		feed("b");
		expect(log).toEqual(["\r", "a", "b"]);
	});

	it("keeps a command, its Enter and an answer typed ahead with its own Enter as keys", () => {
		const { log, pastes, feed, clock } = setup();
		feed("/pick\r", "on 2", "\r");
		clock.advance(10);
		expect(pastes).toEqual([]);
		expect(log.join("")).toBe("/pick\ron 2\r");
	});

	it("releases a held Enter ahead of an arrow key that arrives inside the window", () => {
		const { log, feed, clock } = setup();
		feed("\r", "\x1b[A");
		expect(log).toEqual(["\r"]);
		clock.advance(0);
		expect(log).toEqual(["\r", "\x1b[A"]);
	});

	it("takes text after two breaks as a paste, a CR closing CR-delimited lines included", () => {
		const { log, feed } = setup();
		feed("a\rb\rc\r");
		expect(log).toEqual(["<paste:a\rb\rc\r>"]);
	});

	it("types a burst drained after an event-loop stall", () => {
		const { log, feed, tokenizer, clock } = setup();
		tokenizer.isStalled = () => true;
		feed("aa\rbb\rcc");
		clock.advance(0);
		expect(log).toEqual(["a", "a", "\r", "b", "b", "\r", "c", "c"]);
	});

	it("never treats an escape-bearing read as a burst", () => {
		const { log, feed, clock } = setup();
		feed("\x1b[A\rx");
		clock.advance(0);
		expect(log).toEqual(["\x1b[A", "\r", "x"]);
	});
});

describe("InputTokenizer keys behind an Enter", () => {
	it("delivers the rest of a read on the next turn, so what Enter opens takes it", () => {
		const { log, feed, clock } = setup();
		feed("\x1b[B\r\x1b[A\x1b[A");
		// Enter's handler continues before the keys typed after it arrive.
		expect(log).toEqual(["\x1b[B", "\r"]);
		clock.advance(0);
		expect(log).toEqual(["\x1b[B", "\r", "\x1b[A", "\x1b[A"]);
	});

	it("keeps reads that arrive meanwhile behind the waiting keys, in order", () => {
		const { log, feed, clock } = setup();
		feed("\x1b[B\r\x1b[A", "x", "\x1b[C");
		expect(log).toEqual(["\x1b[B", "\r"]);
		clock.advance(0);
		expect(log).toEqual(["\x1b[B", "\r", "\x1b[A", "x", "\x1b[C"]);
	});

	it("waits again at every further Enter", () => {
		const { log, feed, clock } = setup();
		const turns: number[] = [];
		const schedule = clock.schedule.bind(clock);
		clock.schedule = (ms, fn) =>
			schedule(ms, () => {
				turns.push(log.length);
				fn();
			});
		feed("\x1b[A\ra\x1b[13ub", "c");
		expect(log.join("|")).toBe("\x1b[A|\r");
		clock.advance(0);
		expect(log.join("|")).toBe("\x1b[A|\r|a|\x1b[13u|b|c");
		// Two turns: one after the first Enter, one after the kitty-encoded second.
		expect(turns).toEqual([2, 4]);
	});

	it("gives an answer typed inside the hold window to what the Enter opened", () => {
		const { log, feed, clock } = setup();
		feed("\r", " more");
		clock.advance(10);
		expect(log).toEqual(["\r", " ", "m", "o", "r", "e"]);
		// One turn apart: the Enter when its window ended, the text after it.
		const { log: turns, feed: again, clock: second } = setup();
		again("\r", " more");
		second.advance(9);
		expect(turns).toEqual([]);
		second.advance(1);
		expect(turns).toEqual(["\r", " ", "m", "o", "r", "e"]);
	});

	it("delivers an Enter that ends its read at once, and the next read with it", () => {
		const { log, feed } = setup();
		feed("\x1b[A\r", "\x1b[B");
		expect(log).toEqual(["\x1b[A", "\r", "\x1b[B"]);
	});

	it("lets the terminal's own messages through and starts the wait at the next key", () => {
		const { log, feed, clock } = setup();
		const ack = '\x1b_tsp;e;{"ev":"ack","sf":"s:1","s":3}\x1b\\';
		feed(`\x1b[B\r${ack}${ack}\x1b[A${ack}`);
		expect(log).toEqual(["\x1b[B", "\r", ack, ack]);
		clock.advance(0);
		expect(log).toEqual(["\x1b[B", "\r", ack, ack, "\x1b[A", ack]);
	});

	it("flush delivers everything that waited", () => {
		const { log, feed, tokenizer } = setup();
		feed("\x1b[A\rab", "c");
		tokenizer.flush();
		expect(log).toEqual(["\x1b[A", "\r", "a", "b", "c"]);
	});

	it("clear drops what waited", () => {
		const { log, feed, tokenizer, clock } = setup();
		feed("\x1b[A\rab");
		tokenizer.clear();
		clock.advance(0);
		expect(log).toEqual(["\x1b[A", "\r"]);
	});
});

describe("InputTokenizer stalled reply strings", () => {
	const head = "\x1b]5522;type=read:status=DATA;SGVsbG8s";

	it("completes a string whose payload stalls for seconds", () => {
		const { seqs, feed, clock } = setup();
		feed(head);
		clock.advance(4000);
		feed("IHdvcmxk\x1b", "\\");
		expect(seqs).toEqual([`${head}IHdvcmxk\x1b\\`]);
	});

	it("drops the head when a key interrupts it and delivers the key", () => {
		const { seqs, feed } = setup();
		feed(head, "\x1b[Aa");
		expect(seqs).toEqual(["\x1b[A", "a"]);
	});

	it("replays single keys typed into a stalled head", () => {
		const { seqs, feed, clock } = setup();
		feed(head);
		clock.advance(200);
		feed("h");
		clock.advance(200);
		feed("i", "\r");
		expect(seqs).toEqual(["h", "i", "\r"]);
	});

	it("abandons a silent head, replays typed keys, and still completes a late tail", () => {
		const { seqs, feed, clock } = setup({ stringAbandonMs: 5000 });
		feed(head);
		clock.advance(200);
		feed("h");
		clock.advance(4999);
		expect(seqs).toEqual([]);
		clock.advance(1);
		expect(seqs).toEqual(["h"]);
		feed("IHdvcmxk\x1b\\");
		expect(seqs).toEqual(["h", `${head}IHdvcmxk\x1b\\`]);
	});

	it("abandons on a space typed after a stall, but keeps spaces of a streaming reply", () => {
		const stalled = setup();
		stalled.feed(head);
		stalled.clock.advance(200);
		stalled.feed(" ");
		expect(stalled.seqs).toEqual([" "]);

		const streaming = setup();
		streaming.bytes("\x1bP>|WezTerm 2024\x1b\\");
		expect(streaming.seqs).toEqual(["\x1bP>|WezTerm 2024\x1b\\"]);
	});

	it("keeps CR/LF format effectors of a DCS reply split across reads", () => {
		const { seqs, bytes } = setup();
		bytes("\x1bP1+r544e\r\n=787465726d\x1b\\");
		expect(seqs).toEqual(["\x1bP1+r544e\r\n=787465726d\x1b\\"]);
	});

	it("never types multi-byte payload of a dead transfer", () => {
		const { seqs, feed, clock } = setup();
		feed(head);
		clock.advance(200);
		feed("QUJDREVG");
		clock.advance(6000);
		expect(seqs).toEqual([]);
	});

	it("lets an abandoned head expire so later typing is delivered", () => {
		const { seqs, feed, clock } = setup();
		feed(head);
		clock.advance(15_001);
		feed("hello");
		expect(seqs).toEqual(["h", "e", "l", "l", "o"]);
	});

	it("discards an oversized unterminated string up to its own terminator", () => {
		const { seqs, feed } = setup({ maxStringBytes: 64 });
		feed(`\x1b]5522;${"a".repeat(100)}`, "zzzz", "tail\x1b\\\x1b]z\x07abc");
		expect(seqs).toEqual(["\x1b]z\x07", "a", "b", "c"]);
	});
});

describe("InputTokenizer bounds", () => {
	it("cuts a malformed CSI run so one read stays bounded", () => {
		const { seqs, feed, tokenizer } = setup({ maxCsiBytes: 4096 });
		feed(`\x1b[${";".repeat(20_000)}`);
		expect(seqs[0]!.length).toBeLessThanOrEqual(4097);
		expect(tokenizer.pending).toBe("");
	});

	it("resumes the terminator search across chunks of a long string", () => {
		const { seqs, feed } = setup();
		feed("\x1b]5522;type=read;");
		for (let i = 0; i < 64; i++) feed("a".repeat(4096));
		feed("\x07");
		expect(seqs).toHaveLength(1);
		expect(seqs[0]!.endsWith("\x07")).toBe(true);
	});
});
