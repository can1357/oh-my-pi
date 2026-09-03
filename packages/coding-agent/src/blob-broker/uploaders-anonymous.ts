import type { BlobDestinationId } from "./destinations";
import type { BlobUploader, BlobUploadRequest, RemoteDeleteAction } from "./publication";
import {
	credentialString,
	type DestinationRuntimeConfig,
	expectOk,
	fetchFor,
	multipartFile,
	optionString,
	publication,
} from "./uploader-runtime";

const CATBOX_UPLOAD_URL = "https://catbox.moe/user/api.php";
const LITTERBOX_UPLOAD_URL = "https://litterbox.catbox.moe/resources/internals/api.php";
const ZERO_X_ZERO_UPLOAD_URL = "https://0x0.st";
const UGUU_UPLOAD_URL = "https://uguu.se/upload?output=text";
const TMPFILES_UPLOAD_URL = "https://tmpfiles.org/api/v1/upload";
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const LITTERBOX_TTLS = {
	"1h": HOUR_MS,
	"12h": 12 * HOUR_MS,
	"24h": 24 * HOUR_MS,
	"72h": 72 * HOUR_MS,
} as const;

function httpUrl(value: string, destination: BlobDestinationId): string {
	const trimmed = value.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`${destination} returned an invalid upload URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${destination} returned an unsupported upload URL`);
	}
	return url.href;
}

async function uploadTextUrl(
	destination: BlobDestinationId,
	config: DestinationRuntimeConfig,
	endpoint: string,
	form: FormData,
): Promise<{ response: Response; url: string }> {
	const response = await expectOk(await fetchFor(config)(endpoint, { method: "POST", body: form }), destination);
	return { response, url: httpUrl(await response.text(), destination) };
}

function remoteName(url: string): string | undefined {
	const name = new URL(url).pathname.split("/").filter(Boolean).pop();
	return name ? decodeURIComponent(name) : undefined;
}

function formDelete(url: string, fields: Readonly<Record<string, string>>): RemoteDeleteAction {
	return {
		method: "POST",
		url,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	};
}

function createCatboxUploader(config: DestinationRuntimeConfig): BlobUploader {
	return {
		destination: "catbox",
		async upload(request: BlobUploadRequest) {
			const userHash = credentialString(config, "userHash");
			const fields: Record<string, string> = { reqtype: "fileupload" };
			if (userHash) fields.userhash = userHash;
			const { url } = await uploadTextUrl(
				"catbox",
				config,
				CATBOX_UPLOAD_URL,
				multipartFile(request, "fileToUpload", fields),
			);
			const id = remoteName(url);
			const deleteAction =
				userHash && id
					? formDelete(CATBOX_UPLOAD_URL, { reqtype: "deletefiles", userhash: userHash, files: id })
					: undefined;
			return publication("catbox", request, url, { remoteId: id, delete: deleteAction });
		},
	};
}

function litterboxTtl(config: DestinationRuntimeConfig): keyof typeof LITTERBOX_TTLS {
	const ttl = optionString(config, "ttl", "24h");
	if (ttl && Object.hasOwn(LITTERBOX_TTLS, ttl)) return ttl as keyof typeof LITTERBOX_TTLS;
	throw new Error("litterbox option ttl must be one of 1h, 12h, 24h, or 72h");
}

function createLitterboxUploader(config: DestinationRuntimeConfig): BlobUploader {
	return {
		destination: "litterbox",
		async upload(request: BlobUploadRequest) {
			const ttl = litterboxTtl(config);
			const { url } = await uploadTextUrl(
				"litterbox",
				config,
				LITTERBOX_UPLOAD_URL,
				multipartFile(request, "fileToUpload", { reqtype: "fileupload", time: ttl }),
			);
			return publication("litterbox", request, url, {
				expiresAt: Date.now() + LITTERBOX_TTLS[ttl],
				remoteId: remoteName(url),
			});
		},
	};
}

function zeroXZeroExpiry(request: BlobUploadRequest): number {
	const maxSize = 512 * 1024 * 1024;
	const ratio = Math.min(request.bytes.byteLength, maxSize) / maxSize;
	const retentionDays = 30 + (30 - 365) * (ratio - 1) ** 3;
	return Date.now() + Math.round(retentionDays * DAY_MS);
}

function createZeroXZeroUploader(config: DestinationRuntimeConfig): BlobUploader {
	return {
		destination: "0x0",
		async upload(request: BlobUploadRequest) {
			const { response, url } = await uploadTextUrl("0x0", config, ZERO_X_ZERO_UPLOAD_URL, multipartFile(request));
			const token = response.headers.get("X-Token")?.trim();
			return publication("0x0", request, url, {
				expiresAt: zeroXZeroExpiry(request),
				remoteId: remoteName(url),
				delete: token ? formDelete(url, { token, delete: "" }) : undefined,
			});
		},
	};
}

function createUguuUploader(config: DestinationRuntimeConfig): BlobUploader {
	return {
		destination: "uguu",
		async upload(request: BlobUploadRequest) {
			const { url } = await uploadTextUrl("uguu", config, UGUU_UPLOAD_URL, multipartFile(request, "files[]"));
			return publication("uguu", request, url, {
				expiresAt: Date.now() + 3 * HOUR_MS,
				remoteId: remoteName(url),
			});
		},
	};
}

function tmpfilesTtlSeconds(config: DestinationRuntimeConfig): number {
	const ttl = optionString(config, "ttl", "1h")?.trim().toLowerCase();
	const match = ttl?.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/);
	if (!match) throw new Error("tmpfiles option ttl must be a duration such as 1h");
	const amount = Number(match[1]);
	const multiplier = match[2] === "d" ? 86_400 : match[2] === "h" ? 3_600 : match[2] === "m" ? 60 : 1;
	const seconds = Math.round(amount * multiplier);
	if (!Number.isFinite(seconds) || seconds < 60 || seconds > 172_800) {
		throw new Error("tmpfiles option ttl must be between 60 seconds and 48 hours");
	}
	return seconds;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function stringAtPath(value: unknown, path: string): string | undefined {
	let current = value;
	for (const segment of path.split(".").filter(Boolean)) {
		if (Array.isArray(current)) {
			if (!/^\d+$/.test(segment)) return undefined;
			current = current[Number(segment)];
			continue;
		}
		const record = recordValue(current);
		if (!record) return undefined;
		current = record[segment];
	}
	return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

function tmpfilesDirectUrl(value: string): { url: string; id?: string } {
	const source = new URL(httpUrl(value, "tmpfiles"));
	const segments = source.pathname.split("/").filter(Boolean);
	if (segments[0] !== "dl") segments.unshift("dl");
	source.pathname = `/${segments.map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/")}`;
	return { url: source.href, id: segments[1] };
}

function createTmpfilesUploader(config: DestinationRuntimeConfig): BlobUploader {
	return {
		destination: "tmpfiles",
		async upload(request: BlobUploadRequest) {
			const ttlSeconds = tmpfilesTtlSeconds(config);
			const response = await expectOk(
				await fetchFor(config)(TMPFILES_UPLOAD_URL, {
					method: "POST",
					body: multipartFile(request, "file", { expire: String(ttlSeconds) }),
				}),
				"tmpfiles",
			);
			const result: unknown = await response.json();
			const uploadUrl = stringAtPath(result, "data.url");
			if (!uploadUrl) throw new Error("tmpfiles upload response did not contain data.url");
			const direct = tmpfilesDirectUrl(uploadUrl);
			return publication("tmpfiles", request, direct.url, {
				expiresAt: Date.now() + ttlSeconds * 1_000,
				remoteId: direct.id,
			});
		},
	};
}

function absolutePomfUrl(value: string, resultBaseUrl: string | undefined): string {
	try {
		return httpUrl(value, "pomf");
	} catch (error) {
		if (!resultBaseUrl) throw error;
		const base = httpUrl(resultBaseUrl, "pomf").replace(/\/+$/, "");
		return httpUrl(new URL(value, `${base}/`).href, "pomf");
	}
}

function createPomfUploader(config: DestinationRuntimeConfig): BlobUploader {
	return {
		destination: "pomf",
		async upload(request: BlobUploadRequest) {
			const uploadUrl = optionString(config, "uploadUrl")?.trim();
			if (!uploadUrl) throw new Error("Missing required destination option: uploadUrl");
			const fileField = optionString(config, "fileField", "files[]")?.trim();
			if (!fileField) throw new Error("pomf option fileField must not be empty");
			const urlPath = optionString(config, "urlPath", "files.0.url")?.trim();
			if (!urlPath) throw new Error("pomf option urlPath must not be empty");
			const response = await expectOk(
				await fetchFor(config)(httpUrl(uploadUrl, "pomf"), {
					method: "POST",
					body: multipartFile(request, fileField),
				}),
				"pomf",
			);
			const result: unknown = await response.json();
			const extracted = stringAtPath(result, urlPath);
			if (!extracted) throw new Error(`pomf upload response did not contain a URL at ${urlPath}`);
			const url = absolutePomfUrl(extracted, optionString(config, "resultBaseUrl"));
			return publication("pomf", request, url, { remoteId: remoteName(url) });
		},
	};
}

/** Create an uploader for an anonymous HTTP host, or null for another family. */
export function createAnonymousUploader(
	destination: BlobDestinationId,
	config: DestinationRuntimeConfig,
): BlobUploader | null {
	switch (destination) {
		case "catbox":
			return createCatboxUploader(config);
		case "litterbox":
			return createLitterboxUploader(config);
		case "0x0":
			return createZeroXZeroUploader(config);
		case "uguu":
			return createUguuUploader(config);
		case "tmpfiles":
			return createTmpfilesUploader(config);
		case "pomf":
			return createPomfUploader(config);
		default:
			return null;
	}
}
