import * as path from "node:path";
import { writeRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

/**
 * Give the real worker a native link to the test's loopback relay. Only the native port is
 * substituted: Chrome's tab, debugger and download APIs and the relay protocol run as usual.
 */
export async function writeRelayFixtureExtension(dir: string, port: number, workerSetup = ""): Promise<void> {
	await writeRelayExtension(dir, VERSION);
	const workerPath = path.join(dir, "background.js");
	const worker = await Bun.file(workerPath).text();
	await Bun.write(
		workerPath,
		`chrome.runtime.connectNative = () => {
	const ws = new WebSocket("ws://127.0.0.1:${port}/ext");
	const messages = new Set();
	const disconnects = new Set();
	const emit = message => { for (const listener of messages) listener(message); };
	ws.onopen = () => emit({ t: "linked" });
	ws.onmessage = event => emit({ t: "relay", line: event.data });
	ws.onclose = () => { for (const listener of disconnects) listener(); };
	return {
		onMessage: { addListener: listener => messages.add(listener) },
		onDisconnect: { addListener: listener => disconnects.add(listener) },
		postMessage: message => {
			// The link request is implicit in the WebSocket upgrade.
			if (message.t === "relay") ws.send(message.line);
		},
		disconnect: () => ws.close(),
	};
};
${workerSetup}
${worker}`,
	);
}
