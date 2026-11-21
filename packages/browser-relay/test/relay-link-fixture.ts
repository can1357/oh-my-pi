/**
 * Stub `chrome` for `relay-link.test.ts`: a service worker runtime whose `connectNative` hands out ports the test
 * drives by hand. Imported before `worker/relay`, which reads `chrome` at call time.
 */
import type { ToNativeHost } from "../extension/messages";

/** One native messaging port as the test drives it. */
export interface FakePort {
	postMessage(message: ToNativeHost): void;
	onMessage: { addListener(listener: (message: unknown) => void): void };
	onDisconnect: { addListener(listener: () => void): void };
	/** Whether the worker dropped this attempt. */
	disconnected: boolean;
	disconnect(): void;
	/** Every frame the worker posted on this port. */
	sent: ToNativeHost[];
	/** Answer the link request, as the native host would. */
	link(): void;
}

/** Hand out ports from `sink`; call before the first `connectRelay`. */
export function installChromeStub(sink: FakePort[]): void {
	sink.length = 0;
	Reflect.set(globalThis, "chrome", {
		runtime: {
			connectNative: () => {
				const listeners: ((message: unknown) => void)[] = [];
				const disconnects: (() => void)[] = [];
				const sent: ToNativeHost[] = [];
				const port: FakePort = {
					disconnected: false,
					sent,
					disconnect: () => { port.disconnected = true; },
					// Frames are recorded; the test answers with `link()`, so a silent host stays silent.
					postMessage: message => {
						sent.push(message);
					},
					onMessage: { addListener: listener => listeners.push(listener) },
					onDisconnect: { addListener: listener => disconnects.push(listener) },
					link: () => {
						for (const listener of listeners) listener({ t: "linked" });
					},
				};
				sink.push(port);
				return port;
			},
			id: "test-extension",
		},
		action: {
			setBadgeText: async () => {},
			setBadgeBackgroundColor: async () => {},
		},
		// `linked` greets the relay with a browser snapshot; the link test needs the frame built, not its contents.
		tabs: { query: async () => [], create: async () => ({ id: 1 }) },
		debugger: { getTargets: async () => [] },
		storage: {
			session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
			local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
		},
	});
}
