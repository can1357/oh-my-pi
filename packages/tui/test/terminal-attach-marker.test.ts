import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { OMP_ATTACH_APC_PREFIX, ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function setupProcessTerminal(subscribe = true) {
	const received: string[] = [];
	const markers: string[] = [];
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	vi.spyOn(process, "kill").mockReturnValue(true);
	vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const terminal = new ProcessTerminal({ conpty: false });
	if (subscribe) terminal.onAttachMarker(payload => markers.push(payload));
	terminal.start(
		data => received.push(data),
		() => {},
	);
	return { terminal, received, markers };
}

describe("ProcessTerminal agent-view attach marker", () => {
	let previousHeadless = false;

	beforeEach(() => {
		previousHeadless = setTerminalHeadless(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	it("hands a split attach APC to the marker handler and never to the composer", () => {
		const { terminal, received, markers } = setupProcessTerminal();
		try {
			const payload = Buffer.from(JSON.stringify({ cols: 100, rows: 30 })).toString("base64");
			const marker = `${OMP_ATTACH_APC_PREFIX}${payload}\x1b\\`;
			process.stdin.emit("data", marker.slice(0, 9));
			process.stdin.emit("data", marker.slice(9));
			expect(markers).toEqual([payload]);
			expect(received.some(data => data.includes("omp-attach") || data.includes(payload))).toBe(false);
		} finally {
			terminal.stop();
		}
	});

	it("drops an unknown complete APC instead of typing it", () => {
		const { terminal, received, markers } = setupProcessTerminal();
		try {
			process.stdin.emit("data", "\x1b_someapp;payload\x1b\\");
			expect(markers).toEqual([]);
			expect(received.some(data => data.includes("someapp") || data.includes("payload"))).toBe(false);
		} finally {
			terminal.stop();
		}
	});

	it("hands a marker that arrived before anyone subscribed to the first subscriber, once", () => {
		const { terminal, received } = setupProcessTerminal(false);
		try {
			process.stdin.emit("data", `${OMP_ATTACH_APC_PREFIX}first\x1b\\`);
			process.stdin.emit("data", `${OMP_ATTACH_APC_PREFIX}latest\x1b\\`);
			const first: string[] = [];
			terminal.onAttachMarker(payload => first.push(payload));
			expect(first).toEqual(["latest"]);
			const second: string[] = [];
			terminal.onAttachMarker(payload => second.push(payload));
			expect(second).toEqual([]);
			expect(received.some(data => data.includes("omp-attach"))).toBe(false);
		} finally {
			terminal.stop();
		}
	});
});
