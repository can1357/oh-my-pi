// Worker body for clipboard-osc52.test.ts: runs copyToClipboard off the main
// thread, as the computer tool's `clipboard.write` does, and reports what
// reached this worker's stdout and the native backend. The worker has its own
// `process`, so the fakes below do not touch the test runner.
import { spyOn } from "bun:test";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as natives from "@oh-my-pi/pi-natives/clipboard";

declare const self: Worker;

Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
// Linux keeps macOS runs off the real pbcopy; the native write is stubbed.
Object.defineProperty(process, "platform", { value: "linux", configurable: true });
const stdout: string[] = [];
spyOn(process.stdout, "write").mockImplementation(chunk => {
	stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
	return true;
});
const nativeCopies: string[] = [];
spyOn(natives, "copyToClipboard").mockImplementation(text => {
	nativeCopies.push(text);
});

await copyToClipboard("worker probe");
self.postMessage({ stdout, nativeCopies });
