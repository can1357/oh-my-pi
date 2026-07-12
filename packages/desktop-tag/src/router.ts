import * as logger from "@pk-nerdsaver-ai/pi-utils/logger";
import type { ActionLevel, ContextPacket, Executor, RoutingDecision } from "./types";
import { isCaptureMode } from "./types";

interface RouteSpec {
	executorId: string;
	suggestedTools: string[];
	level: ActionLevel;
}

/** Registry of available executors and their declared capabilities. */
export class CapabilityRegistry {
	readonly #executors = new Map<string, Executor>();

	register(executor: Executor): void {
		this.#executors.set(executor.id, executor);
	}

	getExecutor(id: string): Executor | undefined {
		return this.#executors.get(id);
	}

	listExecutors(): Executor[] {
		return [...this.#executors.values()];
	}

	findMatching(capabilityName: string, application?: string): Executor | undefined {
		for (const executor of this.#executors.values()) {
			if (!executor.available) continue;
			if (executor.capabilities.some(c => c.name === capabilityName)) {
				if (application && executor.applications && !executor.applications.includes(application)) continue;
				return executor;
			}
		}
		return undefined;
	}
}

/** Default executor definitions shipped with the desktop-tag extension. */
export function createDefaultRegistry(): CapabilityRegistry {
	const registry = new CapabilityRegistry();

	registry.register({
		id: "answer-only",
		name: "Vision answer",
		location: "local",
		riskLevel: "low",
		available: true,
		capabilities: [
			{
				name: "answer",
				description: "Answer from a screenshot or selected context",
				sideEffect: false,
				reversible: true,
				approval: "none",
			},
		],
	});

	registry.register({
		id: "local-pi",
		name: "Local pi session",
		location: "local",
		riskLevel: "medium",
		available: true,
		capabilities: [
			{ name: "filesystem.read", sideEffect: false, reversible: true, approval: "none" },
			{ name: "filesystem.write", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "terminal.execute", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "codebase.edit", sideEffect: true, reversible: true, approval: "per-action" },
		],
	});

	registry.register({
		id: "ix-bridge",
		name: "IX Bridge browser executor",
		location: "local",
		riskLevel: "medium",
		available: true,
		applications: ["salesforce", "powerclerk", "xcel-portal"],
		capabilities: [
			{ name: "browser.navigate", sideEffect: false, reversible: true, approval: "none" },
			{ name: "browser.inspect_dom", sideEffect: false, reversible: true, approval: "none" },
			{ name: "browser.click", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "browser.type", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "browser.capture_trace", sideEffect: false, reversible: true, approval: "none" },
		],
	});

	registry.register({
		id: "gmail-mcp",
		name: "Gmail connector",
		location: "remote",
		riskLevel: "high",
		available: false,
		applications: ["gmail"],
		capabilities: [
			{ name: "email.search", sideEffect: false, reversible: true, approval: "none" },
			{ name: "email.read", sideEffect: false, reversible: true, approval: "none" },
			{ name: "email.draft", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "email.send", sideEffect: true, reversible: false, approval: "per-action" },
		],
	});

	registry.register({
		id: "remote-hub",
		name: "Remote hub worker",
		location: "remote",
		riskLevel: "high",
		available: false,
		capabilities: [
			{ name: "remote.execute", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "server.run", sideEffect: true, reversible: true, approval: "per-action" },
		],
	});

	registry.register({
		id: "computer-use",
		name: "Computer-use vision executor",
		location: "local",
		riskLevel: "high",
		available: false,
		capabilities: [
			{ name: "screen.click", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "screen.type", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "screen.keypress", sideEffect: true, reversible: true, approval: "per-action" },
		],
	});

	return registry;
}

/** Route captured context to an executor with advisory tool suggestions. */
export function routeContext(registry: CapabilityRegistry, packet: ContextPacket): RoutingDecision {
	assertContextPacket(packet);
	const availableExecutors = registry.listExecutors().filter(executor => executor.available);
	if (availableExecutors.length === 0) {
		throw new Error("No available executors are registered");
	}

	const request = packet.userRequest.toLowerCase();
	const url = packet.browser.url?.toLowerCase() ?? "";
	const title = packet.browser.title?.toLowerCase() ?? "";
	let preferred: RouteSpec;

	if (request.match(/\bemail\b|\bmail\b|\bgmail\b/)) {
		preferred = {
			executorId: "gmail-mcp",
			suggestedTools: ["email.search", "email.read", "email.draft"],
			level: 2,
		};
	} else if (request.match(/\bserver\b|\bremote\b|\bssh\b|\brun on the server\b/)) {
		preferred = { executorId: "remote-hub", suggestedTools: ["remote.execute", "ssh"], level: 2 };
	} else if (request.match(/\bclick\b|\bpress\b|\btype in\b|\bscreen\b/)) {
		preferred = {
			executorId: "computer-use",
			suggestedTools: ["screen.click", "screen.type", "screen.keypress"],
			level: 3,
		};
	} else if (request.match(/\bsalesforce\b/) || url.includes("salesforce.com") || title.includes("salesforce")) {
		preferred = { executorId: "ix-bridge", suggestedTools: ["ix_bridge", "browser", "web_search"], level: 2 };
	} else if (request.match(/\bportal\b|\bpowerclerk\b|\bxcel\b/)) {
		preferred = { executorId: "ix-bridge", suggestedTools: ["ix_bridge", "browser"], level: 2 };
	} else if (request.match(/\bfix\b|\bcode\b|\bedit\b|\brefactor\b|\btest\b|\bbuild\b/)) {
		preferred = {
			executorId: "local-pi",
			suggestedTools: ["bash", "read", "edit", "write", "search", "find", "lsp"],
			level: 2,
		};
	} else if (request.match(/\bupdate\b|\bchange\b|\bsave\b|\bcreate\b|\bdelete\b/)) {
		preferred = { executorId: "local-pi", suggestedTools: ["bash", "read", "write", "edit"], level: 2 };
	} else {
		preferred = { executorId: "answer-only", suggestedTools: ["inspect_image", "web_search", "ask"], level: 0 };
	}

	const selected = availableExecutors.find(executor => executor.id === preferred.executorId);
	if (selected) return decision(preferred.executorId, preferred.suggestedTools, preferred.level);

	const fallback = availableExecutors.find(executor => executor.id === "answer-only") ?? availableExecutors[0];
	if (!fallback) throw new Error("No available executors are registered");
	const level: ActionLevel = fallback.riskLevel === "high" ? 3 : fallback.riskLevel === "medium" ? 2 : 0;
	return decision(
		fallback.id,
		fallback.capabilities.map(capability => capability.name),
		level,
	);
}

/** Reject a malformed context packet before routing decisions inspect it. */
export function assertContextPacket(packet: unknown): void {
	if (!isRecord(packet)) throw new TypeError("Context packet must be an object");
	assertNonblankString(packet.captureId, "Context packet captureId");
	assertNonblankString(packet.timestamp, "Context packet timestamp");
	if (Number.isNaN(Date.parse(packet.timestamp))) throw new TypeError("Context packet timestamp must be a valid date");
	assertNonblankString(packet.userRequest, "Context packet userRequest");
	if (!isCaptureMode(packet.captureMode)) {
		throw new TypeError(`Unsupported context capture mode: ${String(packet.captureMode)}`);
	}
	if (!isRecord(packet.visual)) throw new TypeError("Context packet visual must be an object");
	if (
		typeof packet.visual.displayScale !== "number" ||
		!Number.isFinite(packet.visual.displayScale) ||
		packet.visual.displayScale <= 0
	) {
		throw new TypeError("Context packet visual.displayScale must be a finite positive number");
	}
	if (!Array.isArray(packet.visual.annotations))
		throw new TypeError("Context packet visual.annotations must be an array");
	assertOptionalString(packet.visual.screenshotPath, "Context packet visual.screenshotPath");
	const foregroundApp = packet.foregroundApp;
	const browser = packet.browser;
	if (!isRecord(foregroundApp)) throw new TypeError("Context packet foregroundApp must be an object");
	if (!isRecord(browser)) throw new TypeError("Context packet browser must be an object");
	if (!isRecord(packet.selection)) throw new TypeError("Context packet selection must be an object");
	assertOptionalString(foregroundApp.processName, "Context packet foregroundApp.processName");
	assertOptionalNonblankString(foregroundApp.windowTitle, "Context packet foregroundApp.windowTitle");
	assertOptionalString(browser.url, "Context packet browser.url");
	assertOptionalString(browser.title, "Context packet browser.title");
	if (
		!Array.isArray(packet.availableCapabilities) ||
		!packet.availableCapabilities.every(value => typeof value === "string")
	) {
		throw new TypeError("Context packet availableCapabilities must be an array of strings");
	}
}

function assertOptionalString(value: unknown, name: string): void {
	if (value !== undefined && typeof value !== "string") throw new TypeError(`${name} must be a string`);
}

function assertOptionalNonblankString(value: unknown, name: string): void {
	if (value === undefined) return;
	assertNonblankString(value, name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonblankString(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonblank string`);
}

function decision(executorId: string, suggestedTools: string[], level: ActionLevel): RoutingDecision {
	return {
		executorId,
		suggestedTools,
		message: `Routing to ${executorId}; suggested tools [${suggestedTools.join(", ")}]`,
		level,
	};
}

/** Set executor availability based on runtime probes (e.g. IX Bridge reachable). */
export async function updateAvailability(registry: CapabilityRegistry): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 1_500);
	try {
		const response = await fetch("http://127.0.0.1:18086/ix-bridge/status", { signal: controller.signal });
		const status = response.ok
			? ((await response.json().catch(() => ({}))) as { extension_connected?: unknown })
			: undefined;
		const ix = registry.getExecutor("ix-bridge");
		if (ix) ix.available = status?.extension_connected === true;
	} catch (error) {
		logger.debug("IX Bridge availability probe failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		const ix = registry.getExecutor("ix-bridge");
		if (ix) ix.available = false;
	} finally {
		clearTimeout(timer);
	}
}
