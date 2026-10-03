import { describe, expect, it } from "bun:test";
import { detectTextChannelToolCalls, textChannelToolCallNames } from "../src/session/text-channel-tool-call";

// Tag spellings are assembled from fragments (the transport corrupts literal
// tag sequences inside tool-call parameter values — see the module doc).
const OPEN = "<" + "function=";
const CLOSE = "<" + "/" + "function>";
const P_OPEN = "<" + "parameter=";
const P_CLOSE = "<" + "/" + "parameter>";
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

	it("does not fire on a bare grammar mention in inline code", () => {
		const text = "Qwen3-Coder's chat template wraps calls as `<function=NAME>` blocks.";
		expect(detectTextChannelToolCalls(text)).toBeUndefined();
	});

	it("does not fire on a fenced example containing a complete envelope", () => {
		const text = "Example format:\n```xml\n" + envelope("read") + "\n```\nThat is the shape.";
		expect(detectTextChannelToolCalls(text)).toBeUndefined();
	});

	it("requires a parameter pair: open+close without one is not a call", () => {
		const detection = detectTextChannelToolCalls(`odd: ${OPEN}read${TAG_END}${CLOSE}`);
		expect(detection).toBeUndefined();
	});

	it("ignores a truncated envelope with no complete call", () => {
		const detection = detectTextChannelToolCalls(`${OPEN}write${TAG_END}${param("i", "cut off here")}`);
		expect(detection).toBeUndefined();
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
		const detection = detectTextChannelToolCalls(`${OPEN}${longName}${TAG_END}${param("i", "v")}${CLOSE}`);
		expect(detection?.complete[0]?.name).toHaveLength(64);
		const stripped = detectTextChannelToolCalls(
			`${OPEN}wri${String.fromCharCode(7)}te${TAG_END}${param("i", "v")}${CLOSE}`,
		);
		expect(stripped?.complete[0]?.name).toBe("write");
	});

	it("treats an empty name as no call", () => {
		const detection = detectTextChannelToolCalls(`${OPEN}${TAG_END}${param("i", "v")}${CLOSE}`);
		expect(detection).toBeUndefined();
	});
});
