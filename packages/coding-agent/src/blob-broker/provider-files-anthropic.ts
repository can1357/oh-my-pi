import type { Model } from "@oh-my-pi/pi-ai";
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import type { ProviderFileClient, ProviderFileHandle, ProviderFileUploadRequest } from "./provider-file-types";
import type { FetchImpl } from "./uploader-runtime";

const ANTHROPIC_FILES_URL = "https://api.anthropic.com/v1/files";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_FILES_BETA = "files-api-2025-04-14";

interface AnthropicFileMetadata {
	id: string;
	mime_type: string;
	size_bytes: number;
	expires_at?: string | null;
}

function isOfficialAnthropicBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return (
			url.protocol === "https:" &&
			url.hostname === "api.anthropic.com" &&
			url.port === "" &&
			(url.pathname === "" || url.pathname === "/") &&
			url.search === "" &&
			url.hash === "" &&
			url.username === "" &&
			url.password === ""
		);
	} catch {
		return false;
	}
}

function authHeaders(credential: string): Readonly<Record<string, string>> {
	return isAnthropicOAuthToken(credential) ? { Authorization: `Bearer ${credential}` } : { "x-api-key": credential };
}

function requestHeaders(credential: string): Readonly<Record<string, string>> {
	return {
		...authHeaders(credential),
		"anthropic-version": ANTHROPIC_VERSION,
		"anthropic-beta": ANTHROPIC_FILES_BETA,
	};
}

async function expectAnthropicOk(response: Response, operation: "upload" | "delete"): Promise<Response> {
	if (response.ok) return response;
	const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
	throw new Error(`Anthropic file ${operation} failed with HTTP ${status}`);
}

function parseMetadata(value: unknown): AnthropicFileMetadata {
	if (typeof value !== "object" || value === null) throw new Error("Anthropic file upload returned invalid metadata");
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		record.id.length === 0 ||
		typeof record.mime_type !== "string" ||
		record.mime_type.length === 0 ||
		typeof record.size_bytes !== "number" ||
		!Number.isSafeInteger(record.size_bytes) ||
		record.size_bytes < 0 ||
		!(record.expires_at === undefined || record.expires_at === null || typeof record.expires_at === "string")
	) {
		throw new Error("Anthropic file upload returned invalid metadata");
	}
	return {
		id: record.id,
		mime_type: record.mime_type,
		size_bytes: record.size_bytes,
		expires_at: record.expires_at,
	};
}

function parseExpiresAt(value: string | null | undefined): number | undefined {
	if (value == null) return undefined;
	const expiresAt = Date.parse(value);
	if (!Number.isFinite(expiresAt)) throw new Error("Anthropic file upload returned an invalid expiration time");
	return expiresAt;
}

function uploadedFile(request: ProviderFileUploadRequest): File {
	const preferred = request.filename?.trim().replaceAll("\\", "/").split("/").pop();
	const filename = preferred && preferred !== "." && preferred !== ".." ? preferred : "upload";
	return new File([request.bytes], filename, { type: request.mimeType });
}

/**
 * Create a native Anthropic Files API client for an official Anthropic Messages model.
 * Unsupported providers, APIs, and non-Anthropic endpoints return `null` without making a request.
 */
export function createAnthropicFileClient(
	model: Model,
	credential: string,
	fetchImpl: FetchImpl = globalThis.fetch,
): ProviderFileClient | null {
	if (
		model.provider !== "anthropic" ||
		model.api !== "anthropic-messages" ||
		!isOfficialAnthropicBaseUrl(model.baseUrl)
	) {
		return null;
	}
	if (credential.length === 0) throw new Error("Anthropic Files API credential is required");

	const headers = requestHeaders(credential);
	return {
		provider: "anthropic",
		async upload(request: ProviderFileUploadRequest): Promise<ProviderFileHandle> {
			const form = new FormData();
			form.append("file", uploadedFile(request));
			const response = await expectAnthropicOk(
				await fetchImpl(ANTHROPIC_FILES_URL, {
					method: "POST",
					headers,
					body: form,
					signal: request.signal,
				}),
				"upload",
			);
			const metadata = parseMetadata(await response.json());
			const deleteUrl = `${ANTHROPIC_FILES_URL}/${encodeURIComponent(metadata.id)}`;
			return {
				provider: "anthropic",
				id: metadata.id,
				mimeType: metadata.mime_type,
				bytes: metadata.size_bytes,
				expiresAt: parseExpiresAt(metadata.expires_at),
				delete: { method: "DELETE", url: deleteUrl, headers },
			};
		},
		async delete(handle: ProviderFileHandle): Promise<void> {
			if (handle.provider !== "anthropic" || !handle.id)
				throw new Error("Cannot delete an invalid Anthropic file handle");
			await expectAnthropicOk(
				await fetchImpl(`${ANTHROPIC_FILES_URL}/${encodeURIComponent(handle.id)}`, {
					method: "DELETE",
					headers,
				}),
				"delete",
			);
		},
	};
}
