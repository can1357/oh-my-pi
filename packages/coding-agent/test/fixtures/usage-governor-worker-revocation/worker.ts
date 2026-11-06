import { createHash } from "node:crypto";
import { type MessagePort, parentPort } from "node:worker_threads";
import { registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { streamSimple, __providerInFlightForTesting } from "@oh-my-pi/pi-ai/stream";
import { configureUsageAdmission } from "@oh-my-pi/pi-ai/usage-governor/admission";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { SessionUsageRouting } from "../../../src/session/usage-routing";
import type { WorkerThreadLink } from "../../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../../src/thread/rpc";
import { authService } from "../../../src/thread/services/auth";

export interface Probe {
	start(
		registry: ModelRegistry,
		provider: string,
		modelId: string,
		credentialId: number,
		root: string,
	): Promise<{ revision: number }>;
	held(): Promise<void>;
	applied(): Promise<{ revision: number; targetPresent: boolean; baseUrl?: string }>;
	release(): Promise<{ sent: number; error?: string }>;
}

const api = "revocation-fake-api" as Api;
let dispatches = 0;
registerCustomApi(
	api,
	(model: Model<Api>) => {
		dispatches++;
		const stream = new AssistantMessageEventStream();
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: model.provider,
			model: model.id,
			timestamp: 1,
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AssistantMessage;
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
		return stream;
	},
	"revocation-fixture",
);
// Any accidental use of a real provider or discovery transport fails closed.
const denyFetch = () => {
	throw new Error("network forbidden in worker fixture");
};
globalThis.fetch = Object.assign(denyFetch, { preconnect: () => {} }) as typeof fetch;

const held = Promise.withResolvers<void>();
const gate = Promise.withResolvers<void>();
const applied = Promise.withResolvers<{ revision: number; targetPresent: boolean; baseUrl?: string }>();
let result: Promise<{ sent: number; error?: string }>;
let routing: SessionUsageRouting;
const probe: Probe = {
	async start(registry, provider, modelId, credentialId, root) {
		const settings = Settings.isolated({ "usageGovernor.enabled": true });
		settings.setModelRole("task", `${provider}/${modelId}`);
		// An earlier failing subscriber must not prevent routing invalidation.
		registry.subscribeMirror(() => {
			throw new Error("fixture listener failure");
		});
		routing = new SessionUsageRouting(settings, registry);
		const scope = routing.refresh();
		const target = scope?.roles.find(role => role.role === "task")?.targets[0];
		const model = registry.find(provider, modelId);
		if (!scope || !target || !model) throw new Error("missing worker routing target");
		const resolved = await registry.authStorage.keys.getWithCredential(provider, "worker-session", {
			requestCredential: { credentialId },
			recordAffinity: false,
		});
		if (!resolved?.apiKey || resolved.credentialId !== credentialId) throw new Error("missing bound credential");
		const binding = {
			scopeId: scope.id,
			revision: scope.revision,
			owner: { kind: "role" as const, role: "task" },
			target,
			credentialId,
			intent: "proactive" as const,
			bearerFingerprint: createHash("sha256").update(resolved.apiKey).digest("base64url"),
		};
		registry.subscribeMirror(() => {
			const current = routing.refresh();
			applied.resolve({
				revision: current?.revision ?? 0,
				targetPresent: Boolean(registry.find(provider, modelId)),
				baseUrl: registry.find(provider, modelId)?.baseUrl,
			});
		});
		configureUsageAdmission(registry.authStorage.governor);
		__providerInFlightForTesting.setRoot(root);
		__providerInFlightForTesting.setLockCreatedObserver(async () => {
			held.resolve();
			await gate.promise;
		});
		const stream = streamSimple(
			{ ...model, api },
			{ systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: () => ({ ...resolved, usageRouteBinding: binding }),
				usageContext: { source: "subagent", sessionId: "worker-session" },
				maxInFlightRequests: { [provider]: 1 },
			},
		);
		result = stream.result().then(
			() => ({ sent: dispatches }),
			error => {
				held.reject(error);
				return { sent: dispatches, error: String(error) };
			},
		);
		return { revision: scope.revision };
	},
	held: () => held.promise,
	applied: () => applied.promise,
	async release() {
		gate.resolve();
		try {
			return await result;
		} finally {
			__providerInFlightForTesting.setLockCreatedObserver(undefined);
			__providerInFlightForTesting.setRoot(undefined);
			configureUsageAdmission(undefined);
			routing.dispose();
		}
	},
};
const port = parentPort;
if (!port) throw new Error("worker fixture requires parent port");
port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame) => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "worker-revocation", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	authService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await authService.boot?.(globals[authService.name], link);
		const testGlobals = globals.test as { ready(probe: Probe): Promise<void> };
		await testGlobals.ready(probe);
	});
	port.postMessage({ ready: true });
});
