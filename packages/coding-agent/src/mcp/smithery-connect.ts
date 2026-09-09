import { withTimeoutSignal } from "../utils/fetch-timeout";

const SMITHERY_API_BASE_URL = (process.env.SMITHERY_API_URL || "https://api.smithery.ai").replace(/\/+$/, "");
const SMITHERY_CONNECT_TIMEOUT_MS = 10_000;

export class SmitheryConnectError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SmitheryConnectError";
		this.status = status;
	}
}

type SmitheryNamespace = {
	name: string;
};

type SmitheryNamespacesResponse = {
	namespaces?: SmitheryNamespace[];
};

type SmitheryConnectionStatus =
	| { state: "connected" }
	| { state: "auth_required"; authorizationUrl?: string }
	| { state: "error"; message: string }
	| { state: string; [key: string]: unknown };

export type SmitheryConnection = {
	connectionId: string;
	mcpUrl: string;
	name: string;
	status?: SmitheryConnectionStatus;
	createdAt?: string;
};

type SmitheryConnectionsResponse = {
	connections?: SmitheryConnection[];
	nextCursor?: string | null;
};

function buildAuthHeaders(apiKey: string): Headers {
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${apiKey}`);
	headers.set("Content-Type", "application/json");
	return headers;
}

function toApiUrl(path: string): string {
	return `${SMITHERY_API_BASE_URL}${path}`;
}

async function expectOk(response: Response, context: string): Promise<void> {
	if (response.ok) return;
	const responseText = await response.text().catch(() => "");
	const suffix = responseText ? `: ${responseText}` : "";
	throw new SmitheryConnectError(`${context}: ${response.status} ${response.statusText}${suffix}`, response.status);
}

export function getSmitheryApiBaseUrl(): string {
	return SMITHERY_API_BASE_URL;
}

export async function listSmitheryNamespaces(apiKey: string): Promise<SmitheryNamespace[]> {
	const response = await fetch(toApiUrl("/namespaces"), {
		headers: buildAuthHeaders(apiKey),
		signal: withTimeoutSignal(SMITHERY_CONNECT_TIMEOUT_MS),
	});
	await expectOk(response, "Failed to list Smithery namespaces");
	const payload = (await response.json()) as SmitheryNamespacesResponse;
	return payload.namespaces ?? [];
}

export async function createSmitheryNamespace(apiKey: string): Promise<SmitheryNamespace> {
	const response = await fetch(toApiUrl("/namespaces"), {
		method: "POST",
		headers: buildAuthHeaders(apiKey),
		signal: withTimeoutSignal(SMITHERY_CONNECT_TIMEOUT_MS),
	});
	await expectOk(response, "Failed to create Smithery namespace");
	return (await response.json()) as SmitheryNamespace;
}

export async function resolveSmitheryNamespace(apiKey: string): Promise<string> {
	const namespaces = await listSmitheryNamespaces(apiKey);
	if (namespaces.length > 0) {
		return namespaces[0]?.name ?? "";
	}
	const created = await createSmitheryNamespace(apiKey);
	return created.name;
}

export async function listSmitheryConnectionsByUrl(
	apiKey: string,
	namespace: string,
	mcpUrl: string,
): Promise<SmitheryConnection[]> {
	const endpoint = new URL(toApiUrl(`/connect/${encodeURIComponent(namespace)}`));
	endpoint.searchParams.set("mcpUrl", mcpUrl);
	const response = await fetch(endpoint.toString(), {
		headers: buildAuthHeaders(apiKey),
		signal: withTimeoutSignal(SMITHERY_CONNECT_TIMEOUT_MS),
	});
	await expectOk(response, "Failed to list Smithery connections");
	const payload = (await response.json()) as SmitheryConnectionsResponse;
	return payload.connections ?? [];
}

export async function createSmitheryConnection(
	apiKey: string,
	namespace: string,
	params: { mcpUrl: string; name?: string },
): Promise<SmitheryConnection> {
	const response = await fetch(toApiUrl(`/connect/${encodeURIComponent(namespace)}`), {
		method: "POST",
		headers: buildAuthHeaders(apiKey),
		signal: withTimeoutSignal(SMITHERY_CONNECT_TIMEOUT_MS),
		body: JSON.stringify({
			mcpUrl: params.mcpUrl,
			name: params.name,
		}),
	});
	await expectOk(response, "Failed to create Smithery connection");
	return (await response.json()) as SmitheryConnection;
}

export async function getSmitheryConnection(
	apiKey: string,
	namespace: string,
	connectionId: string,
): Promise<SmitheryConnection> {
	const response = await fetch(
		toApiUrl(`/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}`),
		{
			headers: buildAuthHeaders(apiKey),
			signal: withTimeoutSignal(SMITHERY_CONNECT_TIMEOUT_MS),
		},
	);
	await expectOk(response, "Failed to get Smithery connection");
	return (await response.json()) as SmitheryConnection;
}

export async function deleteSmitheryConnection(apiKey: string, namespace: string, connectionId: string): Promise<void> {
	const response = await fetch(
		toApiUrl(`/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}`),
		{
			method: "DELETE",
			headers: buildAuthHeaders(apiKey),
			signal: withTimeoutSignal(SMITHERY_CONNECT_TIMEOUT_MS),
		},
	);
	await expectOk(response, "Failed to delete Smithery connection");
}
