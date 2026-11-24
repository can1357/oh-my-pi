/**
 * Tern Surface Protocol messages on the input side:
 * `ESC _ tsp ; <verb> [; key=value]* ; <body> ESC \`, or the ConPTY-safe
 * `ESC ] 877 ; tsp ; … BEL|ST` framing. The body stays encoded.
 */
import { TSP_APC_ID } from "@oh-my-pi/pi-wire";

export interface TspMessage {
	readonly verb: string;
	readonly params: Readonly<Record<string, string>>;
	readonly body: string;
}

const APC_PREFIX = `\x1b_${TSP_APC_ID};`;
const OSC_PREFIX = `\x1b]877;${TSP_APC_ID};`;

/** Openers of a TSP message, for the tokenizer's reply-prefix checks. */
export const TSP_OPENERS: readonly string[] = [APC_PREFIX, OSC_PREFIX];

/** Parse a complete TSP message, or null when `seq` is not one. */
export function parseTspMessage(seq: string): TspMessage | null {
	let inner: string;
	if (seq.startsWith(APC_PREFIX) && seq.endsWith("\x1b\\")) {
		inner = seq.slice(APC_PREFIX.length, -2);
	} else if (seq.startsWith(OSC_PREFIX)) {
		if (seq.endsWith("\x1b\\")) inner = seq.slice(OSC_PREFIX.length, -2);
		else if (seq.endsWith("\x07")) inner = seq.slice(OSC_PREFIX.length, -1);
		else return null;
	} else {
		return null;
	}
	const verbEnd = inner.indexOf(";");
	const verb = verbEnd < 0 ? inner : inner.slice(0, verbEnd);
	if (!/^[a-z]+$/.test(verb)) return null;
	const params: Record<string, string> = {};
	let rest = verbEnd < 0 ? "" : inner.slice(verbEnd + 1);
	// `key=value` segments precede the body; the body is whatever follows the last of them.
	for (;;) {
		const semi = rest.indexOf(";");
		if (semi < 0) break;
		const segment = /^([A-Za-z_][\w-]*)=([^;]*)$/.exec(rest.slice(0, semi));
		if (!segment) break;
		params[segment[1]!] = segment[2]!;
		rest = rest.slice(semi + 1);
	}
	return { verb, params, body: rest };
}
