import { type MessagePort, parentPort } from "node:worker_threads";
import type { ResolvedApiKey } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { type ApiKeyResolution, resolveApiKeyOnce, seedApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import type { Context } from "@oh-my-pi/pi-ai/types";
import type { ModelRegistry } from "../../src/config/model-registry";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { authService } from "../../src/thread/services/auth";

/** One turn run on the worker, against the registry main mirrored into it. */
export interface RemintProbe {
	turn(
		registry: ModelRegistry,
		provider: string,
		modelId: string,
	): Promise<{ ok: boolean; status: number | undefined }>;
	lastChance(
		registry: ModelRegistry,
		provider: string,
		rejectedGeneration: number,
	): Promise<ResolvedApiKey | undefined>;
}

const CONTEXT: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const probe: RemintProbe = {
	lastChance: (registry, provider, rejectedGeneration) =>
		registry.getApiKeyWithCredentialForProvider(provider, "s", {
			rejectedCredentialGeneration: rejectedGeneration,
		}),
	turn: async (registry, provider, modelId) => {
		const model = registry.find(provider, modelId);
		if (!model) throw new Error(`remint fixture: no model ${provider}/${modelId}`);
		// Resolved and seeded the way `agent-loop` does, over the worker's own
		// `fetch`: the point of this fixture is that the request, the refusal
		// and the retry all happen on the worker while the credential the retry
		// reads lives on main.
		const resolver = registry.resolver(model);
		let seeded: ApiKeyResolution;
		const first = await resolveApiKeyOnce(resolver, undefined, resolved => {
			seeded = resolved;
		});
		const handle = streamSimple(model, CONTEXT, {
			apiKey: seedApiKeyResolver(seeded ?? first, resolver),
			maxTokens: 16,
			maxRetryDelayMs: 1,
		});
		for await (const _event of handle) {
			// drain
		}
		const result = await handle.result();
		return { ok: result.stopReason !== "error", status: result.errorStatus };
	},
};

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "remint-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	authService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await authService.boot?.(globals[authService.name], link);
		const test = globals.test;
		if (typeof test !== "object" || test === null || typeof Reflect.get(test, "ready") !== "function") {
			throw new Error("remint fixture: missing test globals");
		}
		await (Reflect.get(test, "ready") as (probe: RemintProbe) => void | Promise<void>)(probe);
	});
	port.postMessage({ ready: true });
});
