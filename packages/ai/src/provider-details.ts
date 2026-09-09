import { getOpenAICodexTransportDetails, type OpenAICodexTransportDetails } from "./providers/openai-codex-responses";
import type { Api, Model, Provider, ProviderSessionState } from "./types";

export interface ProviderDetailField {
	label: string;
	value: string;
}

export interface ProviderDetails {
	provider: Provider;
	api: Api;
	fields: ProviderDetailField[];
}

export interface ProviderDetailsContext {
	model: Model<Api>;
	sessionId?: string;
	authMode?: string;
	/**
	 * Human-readable description of the active credential, e.g.
	 * `"broker http://omp.internal:8765 · oauth #5 (foo@bar.com)"`.
	 * Rendered as a `Source` field; omitted when undefined.
	 */
	credentialSource?: string;
	preferWebsockets?: boolean;
	providerSessionState?: Map<string, ProviderSessionState>;
}

export function getProviderDetails(context: ProviderDetailsContext): ProviderDetails {
	const endpoint = formatEndpoint(context.model.baseUrl);
	const fields: ProviderDetailField[] = [
		{ label: "Model", value: context.model.id },
		{ label: "API", value: context.model.api },
		{ label: "Auth", value: context.authMode ?? "auto" },
		{ label: "Endpoint", value: endpoint },
	];
	if (context.credentialSource) {
		fields.push({ label: "Source", value: context.credentialSource });
	}

	if (context.model.api === "openai-codex-responses") {
		const codexDetails = getOpenAICodexTransportDetails(context.model as Model<"openai-codex-responses">, {
			sessionId: context.sessionId,
			baseUrl: context.model.baseUrl,
			preferWebsockets: context.preferWebsockets,
			providerSessionState: context.providerSessionState,
		});
		fields.push({ label: "Transport", value: formatCodexTransport(codexDetails) });
		fields.push({ label: "WebSocket", value: formatCodexWebSocket(codexDetails) });
		fields.push({ label: "Reuse", value: formatCodexReuse(codexDetails, context.sessionId) });
	}

	return {
		provider: context.model.provider,
		api: context.model.api,
		fields,
	};
}

function formatEndpoint(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		const path = parsed.pathname.replace(/\/$/, "");
		return `${parsed.origin}${path || "/"}`;
	} catch {
		return baseUrl;
	}
}

function formatCodexTransport(details: OpenAICodexTransportDetails): string {
	if (details.lastTransport === "websocket") return "websocket";
	if (details.lastTransport === "sse" && (details.websocketDisabled || details.fallbackCount > 0)) {
		return "sse (fallback)";
	}
	if (details.lastTransport === "sse") return "sse";
	return details.websocketPreferred ? "websocket preferred" : "sse";
}

function formatCodexWebSocket(details: OpenAICodexTransportDetails): string {
	if (!details.websocketPreferred) return "off";
	if (details.websocketDisabled) return "disabled after fallback";
	if (details.websocketConnected) return "connected";
	if (details.prewarmed) return "prewarmed";
	return details.hasSessionState ? "enabled" : "waiting for first request";
}

function formatCodexReuse(details: OpenAICodexTransportDetails, sessionId: string | undefined): string {
	if (!sessionId) return "no session key";
	return details.canAppend ? "append enabled" : "full request";
}
