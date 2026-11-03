import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Registers a command named after the thread that ran the factory. */
export default function threadProbeExtension(pi: ExtensionAPI): void {
	pi.registerCommand(`thread-${Bun.isMainThread ? "main" : "worker"}`, {
		description: "Reports which thread bound this extension",
		handler: async () => {},
	});
}
