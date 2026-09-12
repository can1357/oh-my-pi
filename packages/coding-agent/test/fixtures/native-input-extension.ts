import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Native extension loaded explicitly by the real CLI, not an adapter or module mock. */
export default function nativeInputExtension(pi: ExtensionAPI): void {
	const url = process.env.NATIVE_INPUT_PROBE_URL;
	if (!url) throw new Error("NATIVE_INPUT_PROBE_URL is required");
	const record = async (event: Record<string, unknown>): Promise<void> => {
		const response = await fetch(`${url}/events`, { method: "POST", body: JSON.stringify(event) });
		if (!response.ok) throw new Error(`Probe event rejected: ${response.status}`);
	};
	pi.registerProvider("native-input-probe", {
		baseUrl: `${url}/v1`,
		apiKey: "localhost-test-only",
		api: "openai-completions",
		models: [
			{
				id: "probe",
				name: "Native input probe",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 256,
			},
		],
	});
	pi.on("input", async (event, ctx) => {
		await record({ event: "input:A", text: event.text, source: event.source, images: event.images });
		if (event.text === "handled" || event.text === "/native-local blocked") return { handled: true };
		if (event.text === "empty") return { text: "", images: [] };
		if (event.text === "clear-images") return { text: "IMAGES_CLEARED", images: [] };
		if (event.text === "keep-images") return { text: "IMAGES_PRESERVED" };
		if (event.text === "images-only") return { images: [] };
		if (event.text.startsWith("rewrite:")) return { text: event.text.slice("rewrite:".length) };
		if (event.text === "chain") return { text: "CHAIN_STAGE", images: [] };
		if (event.text === "generated-user") {
			pi.sendUserMessage("PROGRAMMATIC_USER");
			return { handled: true };
		}
		if (event.text === "generated-custom") {
			pi.sendMessage(
				{ customType: "native-input-probe", content: "PROGRAMMATIC_CUSTOM", display: true },
				{ triggerTurn: true },
			);
			return { handled: true };
		}
		if (event.text === "caught-ui") {
			await ctx.ui.confirm("Disconnected input", event.text).catch(() => false);
			return { text: "CAUGHT_UI_MUST_NOT_FORWARD" };
		}
		if (event.text.startsWith("wait-ui:")) {
			const confirmed = await ctx.ui.confirm("Native input gate", event.text);
			await record({ event: "ui:resolved", text: event.text, confirmed });
			return { text: "AFTER_UI" };
		}
	});
	pi.on("input", async event => {
		await record({ event: "input:B", text: event.text, source: event.source, images: event.images });
		if (event.text === "CHAIN_STAGE") return { text: "CHAIN_FINAL" };
	});
	let contextGated = false;
	pi.on("context", async event => {
		if (!contextGated && JSON.stringify(event.messages).includes("HOLD_ABORT_CONTEXT")) {
			contextGated = true;
			await fetch(`${url}/gates`, { method: "POST", body: JSON.stringify({ name: "abort-context" }) });
		}
	});
	let transitionDecision: string | undefined;
	pi.registerCommand("native-transition", {
		description: "Gate the next session transition",
		handler: async args => {
			transitionDecision = args;
		},
	});
	const gateTransition = async () => {
		if (!transitionDecision) return;
		const decision = transitionDecision;
		transitionDecision = undefined;
		await fetch(`${url}/gates`, { method: "POST", body: JSON.stringify({ name: "transition" }) });
		return { cancel: decision === "cancel" };
	};
	pi.on("session_before_switch", gateTransition);
	pi.on("session_before_branch", gateTransition);
	pi.on("before_agent_start", async event => {
		await record({ event: "before_agent_start", text: event.prompt, images: event.images });
	});
	pi.registerCommand("native-local", {
		description: "Record a locally consumed native command",
		handler: async args => {
			await record({ event: "command", args });
		},
	});
	pi.registerCommand("native-send", {
		description: "Schedule a programmatic prompt",
		handler: async () => {
			pi.sendUserMessage("PROGRAMMATIC_COMMAND");
		},
	});
}
