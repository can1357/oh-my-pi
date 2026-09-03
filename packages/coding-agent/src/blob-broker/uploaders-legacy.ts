import { Buffer } from "node:buffer";
import type { BlobDestinationId } from "./destinations";
import type { BlobUploader, BlobUploadRequest } from "./publication";
import {
	credentialString,
	type DestinationRuntimeConfig,
	DestinationUnavailableError,
	expectOk,
	fetchFor,
	multipartFile,
	optionString,
	publication,
	requireCredential,
} from "./uploader-runtime";

const SUL_UPLOAD_URL = "https://s-ul.eu/api/v1/upload";
const SUL_DELETE_URL = "https://s-ul.eu/delete.php";
const SENDSPACE_DEFAULT_HOST = "api.sendspace.com";

const CUSTOM_ONLY_DESTINATIONS: Readonly<Partial<Record<BlobDestinationId, true>>> = {
	puush: true,
	mediafire: true,
	localhostr: true,
	lambda: true,
	lobfile: true,
	"transfer-sh": true,
};

const BLOCKED_CUSTOM_HOSTS: Readonly<Partial<Record<BlobDestinationId, readonly string[]>>> = {
	puush: ["puush.me"],
	mediafire: ["mediafire.com"],
	localhostr: ["hostr.co"],
	lambda: ["lbda.net", "lambda.sx", "xn--wxa.pw"],
	lobfile: ["lobfile.com", "lithi.io"],
	"transfer-sh": ["transfer.sh"],
};

class LegacyDestinationError extends Error {
	readonly destination: BlobDestinationId;

	constructor(destination: BlobDestinationId, message: string, cause?: unknown) {
		super(`${destination}: ${message}`, cause === undefined ? undefined : { cause });
		this.name = "LegacyDestinationError";
		this.destination = destination;
	}
}

interface SendSpaceNode {
	readonly url: URL;
	readonly maxFileSize: string;
	readonly uploadIdentifier: string;
	readonly extraInfo: string;
}

function failure(destination: BlobDestinationId, error: unknown): Error {
	if (error instanceof DestinationUnavailableError || error instanceof LegacyDestinationError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new LegacyDestinationError(destination, message, error);
}

function configuredEndpoint(destination: BlobDestinationId, config: DestinationRuntimeConfig): URL {
	const raw = optionString(config, "endpoint")?.trim();
	if (!raw) {
		throw new DestinationUnavailableError(destination, "a user-supplied replacement endpoint is required");
	}
	let endpoint: URL;
	try {
		endpoint = new URL(raw);
	} catch (error) {
		throw new LegacyDestinationError(destination, "the configured endpoint is not a valid URL", error);
	}
	if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
		throw new LegacyDestinationError(destination, "the configured endpoint must use HTTP or HTTPS");
	}
	const hostname = endpoint.hostname.toLowerCase();
	const blocked = BLOCKED_CUSTOM_HOSTS[destination];
	if (blocked) {
		for (const domain of blocked) {
			if (hostname === domain || hostname.endsWith(`.${domain}`)) {
				throw new DestinationUnavailableError(destination, "the defunct public endpoint cannot be used");
			}
		}
	}
	return endpoint;
}

function sendSpaceEndpoint(config: DestinationRuntimeConfig): URL {
	const endpoint = configuredEndpoint("sendspace", config);
	if (endpoint.hostname.toLowerCase() === SENDSPACE_DEFAULT_HOST) {
		throw new DestinationUnavailableError("sendspace", "the deprecated public discovery endpoint cannot be used");
	}
	return endpoint;
}

function httpUrl(destination: BlobDestinationId, raw: string, base?: URL): string {
	let url: URL;
	try {
		url = base ? new URL(raw, base) : new URL(raw);
	} catch (error) {
		throw new LegacyDestinationError(destination, "the upload response did not contain a valid direct URL", error);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new LegacyDestinationError(destination, "the upload response URL must use HTTP or HTTPS");
	}
	return url.href;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Readonly<Record<string, unknown>>;
}

function firstString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

async function jsonObject(
	destination: BlobDestinationId,
	response: Response,
): Promise<Readonly<Record<string, unknown>>> {
	let value: unknown;
	try {
		value = await response.json();
	} catch (error) {
		throw new LegacyDestinationError(destination, "the upload endpoint returned invalid JSON", error);
	}
	const record = objectValue(value);
	for (const _ in record) return record;
	throw new LegacyDestinationError(destination, "the upload endpoint returned an invalid JSON object");
}

function directJsonUrl(destination: BlobDestinationId, record: Readonly<Record<string, unknown>>, base: URL): string {
	const nested = objectValue(record.response);
	const raw =
		firstString(record, ["direct_url", "directUrl", "url", "URL"]) ??
		firstString(nested, ["direct_url", "directUrl", "url", "URL"]);
	if (!raw) throw new LegacyDestinationError(destination, "the upload response did not include a direct image URL");
	return httpUrl(destination, raw, base);
}

function basicAuthorization(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function optionalBasicHeaders(
	destination: BlobDestinationId,
	config: DestinationRuntimeConfig,
	usernameKey: string,
	passwordKey: string,
): Headers | undefined {
	const username = credentialString(config, usernameKey);
	const password = credentialString(config, passwordKey);
	if (!username && !password) return undefined;
	if (!username || !password) {
		throw new LegacyDestinationError(
			destination,
			`credentials ${usernameKey} and ${passwordKey} must be configured together`,
		);
	}
	return new Headers({ Authorization: basicAuthorization(username, password) });
}

function xmlEntityDecode(value: string): string {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

function xmlAttribute(source: string, element: string, attribute: string): string | undefined {
	const elementMatch = source.match(new RegExp(`<${element}\\b[^>]*>`, "i"));
	if (!elementMatch) return undefined;
	const attributeMatch = elementMatch[0].match(new RegExp(`\\b${attribute}=(?:"([^"]*)"|'([^']*)')`, "i"));
	const value = attributeMatch?.[1] ?? attributeMatch?.[2];
	return value === undefined ? undefined : xmlEntityDecode(value);
}

function xmlElement(source: string, name: string): string | undefined {
	const match = source.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
	return match?.[1] === undefined ? undefined : xmlEntityDecode(match[1].trim());
}

function createSulUploader(config: DestinationRuntimeConfig): BlobUploader {
	const destination = "s-ul" as const;
	let apiKey: string;
	try {
		apiKey = requireCredential(config, "apiKey");
	} catch (error) {
		throw failure(destination, error);
	}
	return {
		destination,
		async upload(request) {
			try {
				const body = multipartFile(request, "file", { wizard: "true", key: apiKey, client: "sharex-native" });
				const response = await fetchFor(config)(SUL_UPLOAD_URL, { method: "POST", body });
				await expectOk(response, destination);
				const data = await jsonObject(destination, response);
				const upstreamError = firstString(data, ["error"]);
				if (upstreamError) throw new LegacyDestinationError(destination, `upload rejected: ${upstreamError}`);
				const protocol = firstString(data, ["protocol"]);
				const domain = firstString(data, ["domain"]);
				const filename = firstString(data, ["filename"]);
				const extension = firstString(data, ["extension"]) ?? "";
				if (!protocol || !domain || !filename) {
					throw new LegacyDestinationError(destination, "the upload response omitted URL components");
				}
				const url = httpUrl(destination, `${protocol}${domain}/${filename}${extension}`);
				const deleteUrl = new URL(SUL_DELETE_URL);
				deleteUrl.searchParams.set("key", apiKey);
				deleteUrl.searchParams.set("file", filename);
				return publication(destination, request, url, {
					delete: { method: "GET", url: deleteUrl.href },
					remoteId: filename,
				});
			} catch (error) {
				throw failure(destination, error);
			}
		},
	};
}

function createPuushUploader(config: DestinationRuntimeConfig, endpoint: URL): BlobUploader {
	const destination = "puush" as const;
	const apiKey = requireCredential(config, "apiKey");
	return {
		destination,
		async upload(request) {
			try {
				const body = multipartFile(request, "f", { k: apiKey, z: "oh-my-pi" });
				const response = await fetchFor(config)(endpoint, { method: "POST", body });
				await expectOk(response, destination);
				const values = (await response.text()).trim().split(",");
				const status = Number.parseInt(values[0] ?? "", 10);
				if (!Number.isInteger(status) || status < 0 || !values[1]) {
					throw new LegacyDestinationError(destination, "the replacement endpoint rejected the upload");
				}
				const url = httpUrl(destination, values[1]);
				return publication(destination, request, url, values[2] ? { remoteId: values[2] } : undefined);
			} catch (error) {
				throw failure(destination, error);
			}
		},
	};
}

function createMediaFireUploader(config: DestinationRuntimeConfig, endpoint: URL): BlobUploader {
	const destination = "mediafire" as const;
	const headers = optionalBasicHeaders(destination, config, "username", "password");
	return {
		destination,
		async upload(request) {
			try {
				const fields: Record<string, string> = {};
				const path = optionString(config, "path");
				const apiKey = credentialString(config, "apiKey");
				if (path) fields.path = path;
				if (apiKey) fields.api_key = apiKey;
				const response = await fetchFor(config)(endpoint, {
					method: "POST",
					headers,
					body: multipartFile(request, "Filedata", fields),
				});
				await expectOk(response, destination);
				const data = await jsonObject(destination, response);
				const url = directJsonUrl(destination, data, endpoint);
				const remoteId = firstString(data, ["id", "quickkey"]);
				return publication(destination, request, url, remoteId ? { remoteId } : undefined);
			} catch (error) {
				throw failure(destination, error);
			}
		},
	};
}

function createLocalhostrUploader(config: DestinationRuntimeConfig, endpoint: URL): BlobUploader {
	const destination = "localhostr" as const;
	const headers = optionalBasicHeaders(destination, config, "email", "password");
	return {
		destination,
		async upload(request) {
			try {
				const response = await fetchFor(config)(endpoint, {
					method: "POST",
					headers,
					body: multipartFile(request),
				});
				await expectOk(response, destination);
				const data = await jsonObject(destination, response);
				let raw = firstString(data, ["direct_url", "directUrl", "url"]);
				if (!raw) {
					const id = firstString(data, ["id"]);
					const name = firstString(data, ["name"]);
					const publicBase = optionString(config, "publicBaseUrl");
					if (id && name && publicBase) {
						raw = `${publicBase.replace(/\/$/, "")}/file/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
					}
				}
				if (!raw)
					throw new LegacyDestinationError(
						destination,
						"the replacement endpoint did not return a direct image URL",
					);
				const remoteId = firstString(data, ["id"]);
				return publication(
					destination,
					request,
					httpUrl(destination, raw, endpoint),
					remoteId ? { remoteId } : undefined,
				);
			} catch (error) {
				throw failure(destination, error);
			}
		},
	};
}

function createLambdaUploader(config: DestinationRuntimeConfig, endpoint: URL): BlobUploader {
	const destination = "lambda" as const;
	const apiKey = requireCredential(config, "apiKey");
	const resultBase = optionString(config, "resultBaseUrl");
	let resultBaseUrl: URL = endpoint;
	if (resultBase) {
		try {
			resultBaseUrl = new URL(resultBase);
		} catch (error) {
			throw new LegacyDestinationError(destination, "resultBaseUrl is not a valid URL", error);
		}
	}
	return {
		destination,
		async upload(request) {
			try {
				const response = await fetchFor(config)(endpoint, {
					method: "PUT",
					body: multipartFile(request, "file", { api_key: apiKey }),
				});
				await expectOk(response, destination);
				const data = await jsonObject(destination, response);
				const errors = data.errors;
				if (Array.isArray(errors) && errors.length > 0) {
					throw new LegacyDestinationError(destination, "the replacement endpoint rejected the upload");
				}
				const raw = firstString(data, ["direct_url", "directUrl", "url"]);
				if (!raw)
					throw new LegacyDestinationError(destination, "the replacement endpoint omitted the uploaded URL");
				return publication(destination, request, httpUrl(destination, raw, resultBaseUrl));
			} catch (error) {
				throw failure(destination, error);
			}
		},
	};
}

function createLobFileUploader(config: DestinationRuntimeConfig, endpoint: URL): BlobUploader {
	const destination = "lobfile" as const;
	const apiKey = requireCredential(config, "apiKey");
	return {
		destination,
		async upload(request) {
			try {
				const response = await fetchFor(config)(endpoint, {
					method: "POST",
					body: multipartFile(request, "file", { api_key: apiKey }),
				});
				await expectOk(response, destination);
				const data = await jsonObject(destination, response);
				if (data.success === false || data.Success === false) {
					throw new LegacyDestinationError(destination, "the replacement endpoint rejected the upload");
				}
				return publication(destination, request, directJsonUrl(destination, data, endpoint));
			} catch (error) {
				throw failure(destination, error);
			}
		},
	};
}

function createTransferUploader(config: DestinationRuntimeConfig, endpoint: URL): BlobUploader {
	const destination = "transfer-sh" as const;
	return {
		destination,
		async upload(request) {
			try {
				const response = await fetchFor(config)(endpoint, {
					method: "POST",
					body: multipartFile(request),
				});
				await expectOk(response, destination);
				const raw = (await response.text()).trim();
				if (!raw) throw new LegacyDestinationError(destination, "the replacement endpoint returned no direct URL");
				const deleteUrl = response.headers.get("x-url-delete")?.trim();
				return publication(
					destination,
					request,
					httpUrl(destination, raw, endpoint),
					deleteUrl ? { delete: { method: "DELETE", url: httpUrl(destination, deleteUrl, endpoint) } } : undefined,
				);
			} catch (error) {
				throw failure(destination, error);
			}
		},
	};
}

async function discoverSendSpaceNode(config: DestinationRuntimeConfig, endpoint: URL): Promise<SendSpaceNode> {
	const destination = "sendspace" as const;
	const discovery = new URL(endpoint);
	discovery.searchParams.set("method", "anonymous.uploadGetInfo");
	discovery.searchParams.set("speed_limit", "0");
	discovery.searchParams.set("api_version", "1.0");
	discovery.searchParams.set("app_version", "1.0");
	const apiKey = credentialString(config, "apiKey");
	if (apiKey) discovery.searchParams.set("api_key", apiKey);
	const response = await fetchFor(config)(discovery, { method: "GET" });
	await expectOk(response, destination);
	const xml = await response.text();
	if (/\bstatus=(?:"fail"|'fail')/i.test(xml)) {
		throw new LegacyDestinationError(destination, "the discovery endpoint rejected the upload request");
	}
	const rawUrl = xmlAttribute(xml, "upload", "url");
	const maxFileSize = xmlAttribute(xml, "upload", "max_file_size");
	const uploadIdentifier = xmlAttribute(xml, "upload", "upload_identifier");
	const extraInfo = xmlAttribute(xml, "upload", "extra_info");
	if (!rawUrl || !maxFileSize || !uploadIdentifier || !extraInfo) {
		throw new LegacyDestinationError(destination, "the discovery endpoint returned incomplete upload-node metadata");
	}
	return {
		url: new URL(httpUrl(destination, rawUrl)),
		maxFileSize,
		uploadIdentifier,
		extraInfo,
	};
}

function createSendSpaceUploader(config: DestinationRuntimeConfig, endpoint: URL): BlobUploader {
	const destination = "sendspace" as const;
	return {
		destination,
		async upload(request: BlobUploadRequest) {
			try {
				const node = await discoverSendSpaceNode(config, endpoint);
				const body = multipartFile(request, "userfile", {
					MAX_FILE_SIZE: node.maxFileSize,
					UPLOAD_IDENTIFIER: node.uploadIdentifier,
					extra_info: node.extraInfo,
				});
				const response = await fetchFor(config)(node.url, { method: "POST", body });
				await expectOk(response, destination);
				const text = await response.text();
				const status = xmlElement(text, "status");
				const raw = xmlElement(text, "direct_url") ?? xmlElement(text, "download_url");
				if (status !== "ok" || !raw) {
					throw new LegacyDestinationError(destination, "the upload node did not return a direct image URL");
				}
				const deleteUrl = xmlElement(text, "delete_url");
				return publication(
					destination,
					request,
					httpUrl(destination, raw),
					deleteUrl ? { delete: { method: "GET", url: httpUrl(destination, deleteUrl) } } : undefined,
				);
			} catch (error) {
				throw failure(destination, error);
			}
		},
	};
}

function incompatible(destination: BlobDestinationId, reason: string): never {
	throw new DestinationUnavailableError(destination, reason);
}

/** Create a viable ShareX legacy HTTP uploader, or `null` for another destination family. */
export function createLegacyUploader(
	destination: BlobDestinationId,
	config: DestinationRuntimeConfig,
): BlobUploader | null {
	try {
		switch (destination) {
			case "s-ul":
				return createSulUploader(config);
			case "sendspace":
				return createSendSpaceUploader(config, sendSpaceEndpoint(config));
			case "streamable":
				return incompatible(destination, "Streamable accepts video and cannot publish a direct image URL");
			case "youtube":
				return incompatible(destination, "YouTube accepts video and cannot publish a direct image URL");
			case "vault":
				return incompatible(destination, "Vault publishes encrypted viewer URLs that cannot be fetched as images");
			case "email":
				return incompatible(destination, "email attachments do not produce a public URL");
		}
		if (!CUSTOM_ONLY_DESTINATIONS[destination]) return null;
		const endpoint = configuredEndpoint(destination, config);
		switch (destination) {
			case "puush":
				return createPuushUploader(config, endpoint);
			case "mediafire":
				return createMediaFireUploader(config, endpoint);
			case "localhostr":
				return createLocalhostrUploader(config, endpoint);
			case "lambda":
				return createLambdaUploader(config, endpoint);
			case "lobfile":
				return createLobFileUploader(config, endpoint);
			case "transfer-sh":
				return createTransferUploader(config, endpoint);
			default:
				return null;
		}
	} catch (error) {
		throw failure(destination, error);
	}
}
