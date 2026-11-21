import { type MessagePort, parentPort } from "node:worker_threads";
import { AuthStorage, type SessionRestrictionLease } from "@oh-my-pi/pi-ai";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { ModelRegistry } from "../../src/config/model-registry";
import { anthropicSlowModeLanes } from "../../src/session/anthropic-slow-mode";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { authService } from "../../src/thread/services/auth";
import { RemoteSlowModeLane } from "../../src/thread/services/auth-remote";

/** Worker-side operations the test drives; each crosses to main as an async function. */
export interface AuthProbe {
	key(provider: string, sessionId: string): Promise<string | undefined>;
	keyError(provider: string, sessionId: string): Promise<{ missingApiKey: boolean; message: string }>;
	accountId(provider: string, sessionId: string): Promise<string | undefined>;
	restrict(provider: string, sessionId: string, identityKeys: string[]): Promise<number>;
	unrestrict(provider: string, sessionId: string, handle: number): Promise<void>;
	sameStorage(storage: AuthStorage): Promise<boolean>;
	watchGenerations(): Promise<void>;
	generations(): Promise<number[]>;
	unwatchGenerations(): Promise<void>;
	/** `keys.source(provider)?.kind` of each provider, read through the worker's storage. */
	sourceKinds(providers: string[]): Promise<Array<string | undefined>>;
	registry(registry: ModelRegistry): Promise<{
		local: boolean;
		canonical: boolean;
		sharesAuth: boolean;
		hasModel: boolean;
		apiKey: string | undefined;
	}>;
	observeWrapUp(lane: string): Promise<{ remoteLane: boolean; stage: string | undefined }>;
}

/** Test-only boot globals next to the services' own. */
export interface AuthTestGlobals {
	storage: AuthStorage;
	ready(probe: AuthProbe): void;
}

function isTestGlobals(value: unknown): value is AuthTestGlobals {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "storage") instanceof AuthStorage &&
		typeof Reflect.get(value, "ready") === "function"
	);
}

function buildProbe(storage: AuthStorage): AuthProbe {
	const leases: SessionRestrictionLease[] = [];
	const seen: number[] = [];
	let unwatch: (() => void) | undefined;
	let firstRegistry: ModelRegistry | undefined;
	return {
		key: (provider, sessionId) => storage.keys.get(provider, sessionId),
		keyError: async (provider, sessionId) => {
			try {
				await storage.keys.get(provider, sessionId);
				return { missingApiKey: false, message: "resolved" };
			} catch (error) {
				return {
					missingApiKey: error instanceof MissingApiKeyError,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
		accountId: async (provider, sessionId) => storage.oauth.identity(provider, sessionId)?.accountId,
		restrict: async (provider, sessionId, identityKeys) =>
			leases.push(storage.sessions.restrict(provider, sessionId, identityKeys)) - 1,
		unrestrict: async (provider, sessionId, handle) => {
			const lease = leases[handle];
			if (lease === undefined) throw new Error(`no lease ${handle}`);
			storage.sessions.unrestrict(provider, sessionId, lease);
		},
		sameStorage: async other => other === storage,
		watchGenerations: async () => {
			unwatch = storage.credentials.onGeneration(generation => {
				seen.push(generation);
			});
		},
		generations: async () => [...seen],
		sourceKinds: async providers => providers.map(provider => storage.keys.source(provider)?.kind),
		unwatchGenerations: async () => {
			unwatch?.();
			unwatch = undefined;
		},
		registry: async registry => {
			firstRegistry ??= registry;
			return {
				local: registry instanceof ModelRegistry,
				canonical: firstRegistry === registry,
				sharesAuth: registry.authStorage === storage,
				hasModel: registry.find("unit-mirror", "mirror-model") !== undefined,
				apiKey: await registry.getApiKeyForProvider("unit-mirror"),
			};
		},
		observeWrapUp: async lane => {
			const nowSec = Math.floor(Date.now() / 1000);
			anthropicSlowModeLanes.hooks({}).observe(
				{
					graceUtilization: { fiveHour: 0.3, sevenDay: 0 },
					fiveHourResetAtSec: nowSec + 3_600,
					weeklyResetAtSec: nowSec + 400_000,
					unifiedLimitClaim: false,
					overageInUse: false,
				},
				lane,
			);
			const controller = anthropicSlowModeLanes.lane(lane);
			return { remoteLane: controller instanceof RemoteSlowModeLane, stage: controller.status()?.stage };
		},
	};
}

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
		{ name: "auth-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	authService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await authService.boot?.(globals[authService.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("auth fixture: missing test globals");
		await test.ready(buildProbe(test.storage));
	});
	port.postMessage({ ready: true });
});
