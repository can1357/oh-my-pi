import type { BlobDestinationId } from "./destinations";
import type { BlobUploader, BlobUploadRequest, RemoteDeleteAction } from "./publication";
import {
	credentialString,
	type DestinationRuntimeConfig,
	DestinationUnavailableError,
	expectOk,
	fetchFor,
	multipartFile,
	optionBoolean,
	optionString,
	publication,
	requireCredential,
} from "./uploader-runtime";

const IMGUR_UPLOAD_URL = "https://api.imgur.com/3/upload";
const IMAGESHACK_UPLOAD_URL = "https://api.imageshack.com/v2/images";
const FLICKR_UPLOAD_URL = "https://up.flickr.com/services/upload/";
const FLICKR_REST_URL = "https://api.flickr.com/services/rest";
const VGYME_UPLOAD_URL = "https://vgy.me/upload";

interface FlickrOAuthCredentials {
	consumerKey: string;
	consumerSecret: string;
	token: string;
	tokenSecret: string;
}

function responseRecord(value: unknown, destination: BlobDestinationId): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${destination} returned an invalid response`);
	}
	return value as Record<string, unknown>;
}

async function jsonResponse(response: Response, destination: BlobDestinationId): Promise<Record<string, unknown>> {
	await expectOk(response, destination);
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new Error(`${destination} returned invalid JSON`);
	}
	return responseRecord(value, destination);
}

function nestedRecord(
	record: Record<string, unknown>,
	key: string,
	destination: BlobDestinationId,
): Record<string, unknown> {
	return responseRecord(record[key], destination);
}

function requiredString(record: Record<string, unknown>, key: string, destination: BlobDestinationId): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${destination} response did not include ${key}`);
	}
	return value;
}

function directUrl(value: string, destination: BlobDestinationId): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${destination} returned an invalid image URL`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`${destination} returned an invalid image URL`);
	}
	return url.href;
}

function createImgurUploader(config: DestinationRuntimeConfig): BlobUploader {
	const accessToken = credentialString(config, "accessToken");
	const authorization = accessToken ? `Bearer ${accessToken}` : `Client-ID ${requireCredential(config, "clientId")}`;
	const album = optionString(config, "album");

	return {
		destination: "imgur",
		async upload(request) {
			const fields: Record<string, string> = {};
			if (album) fields.album = album;
			const response = await fetchFor(config)(IMGUR_UPLOAD_URL, {
				method: "POST",
				headers: { Authorization: authorization },
				body: multipartFile(request, "image", fields),
			});
			const payload = await jsonResponse(response, "imgur");
			const data = nestedRecord(payload, "data", "imgur");
			const id = requiredString(data, "id", "imgur");
			const url = directUrl(requiredString(data, "link", "imgur").replace(/\.+$/, ""), "imgur");
			const deleteHash = typeof data.deletehash === "string" && data.deletehash ? data.deletehash : undefined;
			const deleteIdentifier = deleteHash ?? (accessToken ? id : undefined);
			const deleteAction: RemoteDeleteAction | undefined = deleteIdentifier
				? {
						method: "DELETE",
						url: `https://api.imgur.com/3/image/${encodeURIComponent(deleteIdentifier)}`,
						headers: { Authorization: authorization },
					}
				: undefined;
			return publication("imgur", request, url, {
				delete: deleteAction,
				remoteId: id,
			});
		},
	};
}

function createImageShackUploader(config: DestinationRuntimeConfig): BlobUploader {
	const apiKey = requireCredential(config, "apiKey");
	const authToken = requireCredential(config, "authToken");
	const isPublic = optionBoolean(config, "public", false) ?? false;

	return {
		destination: "imageshack",
		async upload(request) {
			const response = await fetchFor(config)(IMAGESHACK_UPLOAD_URL, {
				method: "POST",
				body: multipartFile(request, "file", {
					api_key: apiKey,
					auth_token: authToken,
					public: isPublic ? "y" : "n",
				}),
			});
			const payload = await jsonResponse(response, "imageshack");
			if (payload.success !== true) throw new Error("imageshack rejected the upload");
			const result = nestedRecord(payload, "result", "imageshack");
			if (!Array.isArray(result.images) || result.images.length === 0) {
				throw new Error("imageshack response did not include an image");
			}
			const image = responseRecord(result.images[0], "imageshack");
			const server = image.server;
			const bucket = image.bucket;
			const filename = image.filename;
			if (
				(typeof server !== "string" && typeof server !== "number") ||
				(typeof bucket !== "string" && typeof bucket !== "number") ||
				typeof filename !== "string" ||
				!filename
			) {
				throw new Error("imageshack response did not include direct image coordinates");
			}
			const url = directUrl(`https://imagizer.imageshack.com/a/img${server}/${bucket}/${filename}`, "imageshack");
			return publication("imageshack", request, url, {
				remoteId: typeof image.id === "string" ? image.id : undefined,
			});
		},
	};
}

function oauthEncode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function oauthBaseUrl(value: string): string {
	const url = new URL(value);
	return `${url.origin}${url.pathname}`;
}

function base64(data: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(data)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function oauthSignature(
	method: "GET" | "POST",
	url: string,
	parameters: Readonly<Record<string, string>>,
	consumerSecret: string,
	tokenSecret: string,
): Promise<string> {
	const normalized = Object.entries(parameters)
		.map(([key, value]) => [oauthEncode(key), oauthEncode(value)] as const)
		.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
			if (leftKey < rightKey) return -1;
			if (leftKey > rightKey) return 1;
			if (leftValue < rightValue) return -1;
			if (leftValue > rightValue) return 1;
			return 0;
		})
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const signatureBase = `${method}&${oauthEncode(oauthBaseUrl(url))}&${oauthEncode(normalized)}`;
	const keyBytes = new TextEncoder().encode(`${oauthEncode(consumerSecret)}&${oauthEncode(tokenSecret)}`);
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
	return base64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signatureBase)));
}

async function oauthParameters(
	method: "GET" | "POST",
	url: string,
	requestParameters: Readonly<Record<string, string>>,
	credentials: FlickrOAuthCredentials,
): Promise<Record<string, string>> {
	const oauth: Record<string, string> = {
		oauth_consumer_key: credentials.consumerKey,
		oauth_nonce: crypto.randomUUID().replaceAll("-", ""),
		oauth_signature_method: "HMAC-SHA1",
		oauth_timestamp: String(Math.floor(Date.now() / 1_000)),
		oauth_token: credentials.token,
		oauth_version: "1.0",
	};
	oauth.oauth_signature = await oauthSignature(
		method,
		url,
		{ ...requestParameters, ...oauth },
		credentials.consumerSecret,
		credentials.tokenSecret,
	);
	return oauth;
}

function flickrUploadFields(config: DestinationRuntimeConfig): Record<string, string> {
	const fields: Record<string, string> = {};
	const mappings = [
		["title", "title"],
		["description", "description"],
		["tags", "tags"],
		["isPublic", "is_public"],
		["isFriend", "is_friend"],
		["isFamily", "is_family"],
		["safetyLevel", "safety_level"],
		["contentType", "content_type"],
		["hidden", "hidden"],
	] as const;
	for (const [option, parameter] of mappings) {
		const value = optionString(config, option);
		if (value) fields[parameter] = value;
	}
	return fields;
}

function flickrPhotoId(xml: string): string {
	const status = /<rsp\b[^>]*\b(?:stat|status)=["']([^"']+)["']/i.exec(xml)?.[1];
	if (status && status !== "ok") throw new Error("flickr rejected the upload");
	const photoId = /<photoid\b[^>]*>([^<]+)<\/photoid>/i.exec(xml)?.[1]?.trim();
	if (!photoId) throw new Error("flickr response did not include a photo ID");
	return photoId;
}

function largestFlickrSource(payload: Record<string, unknown>): string {
	if (payload.stat !== "ok") throw new Error("flickr getSizes request failed");
	const sizes = nestedRecord(payload, "sizes", "flickr").size;
	if (!Array.isArray(sizes)) throw new Error("flickr getSizes response did not include sizes");
	for (let index = sizes.length - 1; index >= 0; index--) {
		const size = sizes[index];
		if (size && typeof size === "object" && !Array.isArray(size)) {
			const source = (size as Record<string, unknown>).source;
			if (typeof source === "string" && source) return directUrl(source, "flickr");
		}
	}
	throw new Error("flickr getSizes response did not include a direct image URL");
}

function createFlickrUploader(config: DestinationRuntimeConfig): BlobUploader {
	const credentials: FlickrOAuthCredentials = {
		consumerKey: requireCredential(config, "apiKey"),
		consumerSecret: requireCredential(config, "apiSecret"),
		token: requireCredential(config, "oauthToken"),
		tokenSecret: requireCredential(config, "oauthTokenSecret"),
	};
	const uploadFields = flickrUploadFields(config);

	return {
		destination: "flickr",
		async upload(request: BlobUploadRequest) {
			const uploadOAuth = await oauthParameters("POST", FLICKR_UPLOAD_URL, uploadFields, credentials);
			const uploadResponse = await fetchFor(config)(FLICKR_UPLOAD_URL, {
				method: "POST",
				body: multipartFile(request, "photo", { ...uploadFields, ...uploadOAuth }),
			});
			await expectOk(uploadResponse, "flickr");
			const photoId = flickrPhotoId(await uploadResponse.text());

			const getSizesFields: Record<string, string> = {
				format: "json",
				method: "flickr.photos.getSizes",
				nojsoncallback: "1",
				photo_id: photoId,
			};
			const getSizesOAuth = await oauthParameters("GET", FLICKR_REST_URL, getSizesFields, credentials);
			const getSizesUrl = new URL(FLICKR_REST_URL);
			const getSizesParameters: Record<string, string> = { ...getSizesFields, ...getSizesOAuth };
			for (const key in getSizesParameters) {
				getSizesUrl.searchParams.append(key, getSizesParameters[key]);
			}
			const sizesResponse = await fetchFor(config)(getSizesUrl, { method: "GET" });
			const sizes = await jsonResponse(sizesResponse, "flickr");
			return publication("flickr", request, largestFlickrSource(sizes), { remoteId: photoId });
		},
	};
}

function requiredEndpoint(config: DestinationRuntimeConfig): string {
	const endpoint = optionString(config, "endpoint");
	if (!endpoint) throw new Error("Missing required destination option: endpoint");
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error("Destination option endpoint must be an absolute URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Destination option endpoint must use HTTP or HTTPS");
	}
	return url.href;
}

function createCheveretoUploader(config: DestinationRuntimeConfig): BlobUploader {
	const endpoint = requiredEndpoint(config);
	const apiKey = requireCredential(config, "apiKey");

	return {
		destination: "chevereto",
		async upload(request) {
			const response = await fetchFor(config)(endpoint, {
				method: "POST",
				body: multipartFile(request, "source", { key: apiKey, format: "json" }),
			});
			const payload = await jsonResponse(response, "chevereto");
			const image = nestedRecord(payload, "image", "chevereto");
			const url = directUrl(requiredString(image, "url", "chevereto"), "chevereto");
			const remoteId = typeof image.id === "string" ? image.id : undefined;
			return publication("chevereto", request, url, { remoteId });
		},
	};
}

function createVgymeUploader(config: DestinationRuntimeConfig): BlobUploader {
	const userKey = credentialString(config, "userKey");

	return {
		destination: "vgyme",
		async upload(request) {
			const response = await fetchFor(config)(VGYME_UPLOAD_URL, {
				method: "POST",
				body: multipartFile(request, "file", userKey ? { userkey: userKey } : {}),
			});
			const payload = await jsonResponse(response, "vgyme");
			if (payload.error !== false && payload.error !== undefined && payload.error !== null) {
				throw new Error("vgyme rejected the upload");
			}
			const url = directUrl(requiredString(payload, "image", "vgyme"), "vgyme");
			const deletionUrl =
				typeof payload.delete === "string" && payload.delete ? directUrl(payload.delete, "vgyme") : undefined;
			return publication("vgyme", request, url, {
				delete: deletionUrl ? { method: "DELETE", url: deletionUrl } : undefined,
				remoteId: typeof payload.filename === "string" ? payload.filename : undefined,
			});
		},
	};
}

/** Create a built-in image-host uploader, or `null` for another destination family. */
export function createImageHostUploader(
	destination: BlobDestinationId,
	config: DestinationRuntimeConfig,
): BlobUploader | null {
	switch (destination) {
		case "imgur":
			return createImgurUploader(config);
		case "imageshack":
			return createImageShackUploader(config);
		case "flickr":
			return createFlickrUploader(config);
		case "photobucket":
			throw new DestinationUnavailableError(
				destination,
				"the legacy upload API is decommissioned and third-party embedding is unavailable",
			);
		case "chevereto":
			return createCheveretoUploader(config);
		case "vgyme":
			return createVgymeUploader(config);
		default:
			return null;
	}
}
