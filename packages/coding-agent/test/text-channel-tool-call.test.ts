import { describe, expect, it } from "bun:test";
import { detectTextChannelToolCalls, textChannelToolCallNames } from "../src/session/text-channel-tool-call";

// Envelope tag spellings are assembled at runtime from a char code so test
// payloads never contain literal tag sequences (they corrupt the tool-call
// parameter transport). Grammar: an open tag function=NAME terminated by the
// angle bracket, parameter=KEY pairs wrapped in parameter close tags, and a
// function close tag.
const T = String.fromCharCode(60);
const OPEN = `${T}function=`;
const CLOSE = `${T}/function>`;
const P_OPEN = `${T}parameter=`;
const P_CLOSE = `${T}/parameter>`;
const TAG_END = ">";

function param(key: string, value: string): string {
	return `${P_OPEN}${key}${TAG_END}${value}${P_CLOSE}`;
}

function envelope(name: string, value = "v"): string {
	return `${OPEN}${name}${TAG_END}${param("i", value)}${param("path", "p.txt")}${CLOSE}`;
}

describe("detectTextChannelToolCalls", () => {
	it("returns undefined when the text carries no envelope markup", () => {
		expect(detectTextChannelToolCalls("Just prose about function=NAME envelopes.")).toBeUndefined();
	});

	it("detects a complete envelope and its tool name", () => {
		const detection = detectTextChannelToolCalls(`Doing it now: ${envelope("write")}`);
		expect(detection?.complete.map(call => call.name)).toEqual(["write"]);
		expect(detection?.incomplete).toBe(false);
	});

	it("detects multiple envelopes in order and reports distinct names once", () => {
		const detection = detectTextChannelToolCalls(`${envelope("write")} ${envelope("bash")} ${envelope("write")}`);
		expect(detection?.complete.map(call => call.name)).toEqual(["write", "bash", "write"]);
		expect(textChannelToolCallNames(detection!)).toEqual(["write", "bash"]);
	});

	it("reports an open tag without a close as incomplete and executes nothing", () => {
		const detection = detectTextChannelToolCalls(`${OPEN}write${TAG_END}${param("i", "cut off here")}`);
		expect(detection?.complete).toEqual([]);
		expect(detection?.incomplete).toBe(true);
	});

	it("does not let a quoted unclosed fragment swallow the real envelope after it", () => {
		const text = `Example: ${OPEN}read${TAG_END} without close tag. Real call: ${envelope("bash")}`;
		const detection = detectTextChannelToolCalls(text);
		expect(detection?.complete.map(call => call.name)).toEqual(["bash"]);
		expect(detection?.incomplete).toBe(true);
	});

	it("does not let a cut call borrow the close of the call after it", () => {
		const text = `${OPEN}write${TAG_END}${param("content", "v")} cut here. ${envelope("read")}`;
		const detection = detectTextChannelToolCalls(text);
		expect(detection?.complete.map(call => call.name)).toEqual(["read"]);
		expect(detection?.incomplete).toBe(true);
	});

	it("ignores parameter values entirely, including multiline payloads", () => {
		const payload = `${OPEN}write${TAG_END}${param("content", `line one\nline two\n${"x".repeat(2000)}`)}${param("path", "a.txt")}${CLOSE}`;
		const detection = detectTextChannelToolCalls(payload);
		expect(detection?.complete.map(call => call.name)).toEqual(["write"]);
	});

	it("strips control characters from names and caps their length", () => {
		const longName = "a".repeat(100);
		const detection = detectTextChannelToolCalls(`${OPEN}${longName}${TAG_END}${CLOSE}`);
		expect(detection?.complete[0]?.name).toHaveLength(64);
		const stripped = detectTextChannelToolCalls(`${OPEN}wri${String.fromCharCode(0)}te${TAG_END}${CLOSE}`);
		expect(stripped?.complete[0]?.name).toBe("write");
	});

	it("treats an empty name as incomplete rather than a call", () => {
		const detection = detectTextChannelToolCalls(`${OPEN}${TAG_END}${CLOSE}`);
		expect(detection?.complete).toEqual([]);
		expect(detection?.incomplete).toBe(true);
	});
});
