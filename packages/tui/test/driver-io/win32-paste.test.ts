import { describe, expect, it } from "bun:test";
import type { InputEvent } from "../../src/driver/contract";
import { InputDecoder } from "../../src/driver/input/decoder";

const START = "\x1b[200~";
const END = "\x1b[201~";
const ENTER = "\x1b[13;28;13;1;0;1_";
const ENTER_UP = "\x1b[13;28;13;0;0;1_";
const CR = ENTER + ENTER_UP;
const LF = "\x1b[17;29;0;1;8;1_\x1b[13;28;10;1;8;1_\x1b[13;28;10;0;8;1_\x1b[17;29;0;0;0;1_";

function decode(chunks: string[], win32 = true): InputEvent[] {
	const events: InputEvent[] = [];
	const decoder = new InputDecoder({ input: event => events.push(event), reply: () => {} });
	decoder.win32 = win32;
	for (const chunk of chunks) decoder.process(chunk);
	decoder.flush();
	decoder.clear();
	return events;
}

describe("win32-input-mode bracketed paste", () => {
	const ctrlJDown = "\x1b[74;36;10;1;8;1_";
	const ctrlJUp = "\x1b[74;36;10;0;8;1_";
	const ctrlJ = "\x1b[17;29;0;1;8;1_" + ctrlJDown + ctrlJUp + "\x1b[17;29;0;0;0;1_";
	const relay = (text: string) => Array.from(text, char => `\x1b[0;0;${char.charCodeAt(0)};1;0;1_`).join("");

	it("uses the newline character for alternate keyboard mappings", () => {
		expect(decode([START + ctrlJ + ctrlJDown + ctrlJUp + END])).toEqual([{ type: "paste", paste: { text: "\n\n" } }]);
		const mismatched = ctrlJDown + "\x1b[74;37;10;0;8;1_";
		expect(decode([START + mismatched + END])).toEqual([{ type: "paste", paste: { text: mismatched } }]);
	});

	it("preserves LF in record-encoded framing across reads and keeps Ctrl+J outside the paste", () => {
		const begin = relay(START + "a");
		const end = relay("b" + END);
		for (const chunks of [[begin + LF + ctrlJ + end], [begin, LF, ctrlJ, end]]) {
			expect(decode([...chunks, ctrlJ])).toEqual([{ type: "paste", paste: { text: "a\n\nb" } }, ...decode([ctrlJ])]);
		}
	});

	it("preserves pasted CR across split reads and emits a later physical Enter", () => {
		const events = decode([
			START + "первая" + ENTER.slice(0, 6),
			ENTER.slice(6) + ENTER_UP + "вторая" + END,
			ENTER,
			ENTER_UP,
		]);
		expect(events).toEqual([
			{ type: "paste", paste: { text: "первая\rвторая" } },
			{ type: "key", key: { id: "enter", kind: "press", raw: "\r" } },
		]);
	});

	it("preserves a pasted LF, including an empty line", () => {
		expect(decode([START + "строка" + LF + LF + "ещё" + END])).toEqual([
			{ type: "paste", paste: { text: "строка\n\nещё" } },
		]);
	});

	it("preserves pasted CRLF", () => {
		expect(decode([START + "первая" + CR + LF.slice(0, 23), LF.slice(23) + "вторая" + END])).toEqual([
			{ type: "paste", paste: { text: "первая\r\nвторая" } },
		]);
	});

	it("keeps literal CSI, incomplete and unrelated key records, and ordinary Unicode", () => {
		const text =
			"важно 😀 [13;28;13;1;0;1_ \x1b[31m \x1b[65;30;97;1;0;1_ " +
			"\x1b[231;0;55357;1;0;1_текст\x1b[231;0;56832;1;0;1_" +
			ENTER +
			"\x1b[13;28;13;0;0;2_";
		expect(decode([START + text + END])).toEqual([{ type: "paste", paste: { text } }]);
		expect(decode([START + CR + LF + END], false)).toEqual([{ type: "paste", paste: { text: CR + LF } }]);
	});
});
