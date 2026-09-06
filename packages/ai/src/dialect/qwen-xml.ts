import type { InbandScanEvent, InbandScanner } from "./types";

const SECTION_OPEN = "<tool_calls>";
const SECTION_CLOSE = "</tool_calls>";
const TOOL_ELEMENT = /^<([A-Za-z_][\w.-]*)(\s[^<>]*?)?\s*\/>$/s;
const ATTRIBUTE = /([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

export class QwenXmlInbandScanner implements InbandScanner {
	#buffer = "";
	#insideSection = false;

	feed(chunk: string): InbandScanEvent[] {
		this.#buffer += chunk;
		return this.#drain(false);
	}

	flush(): InbandScanEvent[] {
		return this.#drain(true);
	}

	#drain(flush: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		while (this.#buffer.length > 0) {
			if (!this.#insideSection) {
				const open = this.#buffer.indexOf(SECTION_OPEN);
				if (open >= 0) {
					if (open > 0) events.push({ type: "text", text: this.#buffer.slice(0, open) });
					this.#buffer = this.#buffer.slice(open + SECTION_OPEN.length);
					this.#insideSection = true;
					continue;
				}
				if (flush) {
					events.push({ type: "text", text: this.#buffer });
					this.#buffer = "";
					break;
				}
				const held = longestSuffixPrefix(this.#buffer, SECTION_OPEN);
				const visibleLength = this.#buffer.length - held;
				if (visibleLength > 0) {
					events.push({ type: "text", text: this.#buffer.slice(0, visibleLength) });
					this.#buffer = this.#buffer.slice(visibleLength);
				}
				break;
			}

			const close = this.#buffer.indexOf(SECTION_CLOSE);
			if (close < 0) {
				if (flush) this.#buffer = "";
				break;
			}
			const section = this.#buffer.slice(0, close);
			for (const element of section.match(/<[^<>]+\/>/gs) ?? []) {
				const call = parseToolElement(element);
				if (!call) continue;
				const id = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
				events.push({ type: "toolStart", id, name: call.name });
				events.push({ type: "toolEnd", id, name: call.name, arguments: call.arguments, rawBlock: element });
			}
			this.#buffer = this.#buffer.slice(close + SECTION_CLOSE.length);
			this.#insideSection = false;
		}
		return events;
	}
}

function parseToolElement(element: string): { name: string; arguments: Record<string, unknown> } | undefined {
	const match = TOOL_ELEMENT.exec(element);
	if (!match) return undefined;
	const args: Record<string, unknown> = {};
	for (const attribute of match[2]?.matchAll(ATTRIBUTE) ?? []) {
		args[attribute[1]!] = attribute[3] ?? attribute[4] ?? "";
	}
	return { name: match[1]!, arguments: args };
}

function longestSuffixPrefix(text: string, target: string): number {
	const max = Math.min(text.length, target.length - 1);
	for (let length = max; length > 0; length--) {
		if (text.endsWith(target.slice(0, length))) return length;
	}
	return 0;
}
