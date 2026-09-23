import { afterEach, beforeEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { isEnoent } from "@oh-my-pi/pi-utils";

export async function withEnv(
	overrides: Record<string, string | undefined>,
	fn: () => void | Promise<void>,
): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(overrides)) {
		previous.set(key, Bun.env[key]);
	}
	try {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
		await fn();
	} finally {
		for (const [key, value] of previous.entries()) {
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

export async function waitForDelayOrAbort(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) {
		const reason = signal.reason;
		throw reason instanceof Error ? reason : new Error(String(reason ?? "request aborted"));
	}

	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => resolve(), delayMs);
	const onAbort = () => {
		const reason = signal?.reason;
		reject(reason instanceof Error ? reason : new Error(String(reason ?? "request aborted")));
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await promise;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function createCodexModel(
	id: string,
	spec?: Partial<ModelSpec<"openai-codex-responses">>,
): Model<"openai-codex-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
		...spec,
	});
}

export interface AuthGatewayE2EStatus {
	ok: boolean;
	token?: string;
	reason?: string;
}

export const AUTH_GATEWAY_E2E_URL = Bun.env.OMP_E2E_GATEWAY_URL ?? "http://127.0.0.1:4000";

const AUTH_GATEWAY_TOKEN_PATH = path.join(os.homedir(), ".omp", "auth-gateway.token");
const AUTH_GATEWAY_HEALTH_TIMEOUT_MS = 500;

let authGatewayE2EStatus: Promise<AuthGatewayE2EStatus> | undefined;

export function checkAuthGatewayE2EAvailable(): Promise<AuthGatewayE2EStatus> {
	authGatewayE2EStatus ??= readAuthGatewayE2EStatus();
	return authGatewayE2EStatus;
}

async function readAuthGatewayE2EStatus(): Promise<AuthGatewayE2EStatus> {
	if (!Bun.env.E2E) return { ok: false, reason: "E2E env not set" };
	let token: string;
	try {
		token = (await Bun.file(AUTH_GATEWAY_TOKEN_PATH).text()).trim();
	} catch (err) {
		if (isEnoent(err)) return { ok: false, reason: `no token at ${AUTH_GATEWAY_TOKEN_PATH}` };
		throw err;
	}
	if (!token) return { ok: false, reason: `empty token at ${AUTH_GATEWAY_TOKEN_PATH}` };

	try {
		const res = await fetch(`${AUTH_GATEWAY_E2E_URL}/healthz`, {
			signal: AbortSignal.timeout(AUTH_GATEWAY_HEALTH_TIMEOUT_MS),
		});
		if (!res.ok) return { ok: false, reason: `healthz returned ${res.status}` };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: `healthz unreachable: ${msg}` };
	}
	return { ok: true, token };
}

/**
 * Neutralize `ANTHROPIC_BASE_URL` for the calling test file.
 *
 * The variable reroutes the effective Anthropic endpoint, and every
 * "official endpoint" behavior — eager tool-input streaming, long cache
 * retention, the Cowork TLS profile, the Claude Code session header — switches
 * off once it points elsewhere. A contributor running a gateway, or running the
 * suite from inside another agent, otherwise sees these tests fail on a clean
 * checkout. Tests that exercise gateway routing set the variable explicitly
 * with `withEnv` inside the test body, which still wins over this reset.
 */
export function withOfficialAnthropicEndpoint(): void {
	let previous: string | undefined;
	beforeEach(() => {
		previous = Bun.env.ANTHROPIC_BASE_URL;
		delete Bun.env.ANTHROPIC_BASE_URL;
	});
	afterEach(() => {
		if (previous === undefined) {
			delete Bun.env.ANTHROPIC_BASE_URL;
		} else {
			Bun.env.ANTHROPIC_BASE_URL = previous;
		}
	});
}
