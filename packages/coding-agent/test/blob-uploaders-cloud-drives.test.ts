import { describe, expect, it } from "bun:test";
import type { BlobUploader, BlobUploadRequest } from "../src/blob-broker/publication";
import {
	type DestinationRuntimeConfig,
	DestinationUnavailableError,
	type FetchImpl,
} from "../src/blob-broker/uploader-runtime";
import { createCloudDriveUploader } from "../src/blob-broker/uploaders-cloud-drives";

const uploadRequest: BlobUploadRequest = {
	bytes: new TextEncoder().encode("cloud-drive-payload"),
	mimeType: "image/png",
	extension: "png",
	filename: "cloud image.png",
};

interface CapturedRequest {
	readonly url: string;
	readonly init: RequestInit;
}

function configuredUploader(
	destination: "dropbox" | "onedrive" | "google-drive" | "box" | "pushbullet",
	credentials: Readonly<Record<string, string>>,
	options: DestinationRuntimeConfig["options"],
	fetch: FetchImpl,
): BlobUploader {
	const uploader = createCloudDriveUploader(destination, { credentials, options, fetch });
	if (!uploader) throw new Error(`No cloud-drive uploader for ${destination}`);
	return uploader;
}

function captureFetch(responses: (request: CapturedRequest, index: number) => Response | Promise<Response>): {
	readonly fetch: FetchImpl;
	readonly requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	return {
		requests,
		fetch: async (input, init = {}) => {
			const request = { url: input.toString(), init };
			requests.push(request);
			return responses(request, requests.length - 1);
		},
	};
}

function header(request: CapturedRequest, name: string): string | null {
	return new Headers(request.init.headers).get(name);
}

function jsonBody(request: CapturedRequest): unknown {
	return JSON.parse(String(request.init.body));
}

function formBody(request: CapturedRequest): FormData {
	if (!(request.init.body instanceof FormData)) throw new Error("Expected a FormData request body");
	return request.init.body;
}

describe("cloud-drive blob uploaders", () => {
	it("Dropbox does not publish the viewer URL after a raw upload and public shared-link creation", async () => {
		const transport = captureFetch((_request, index) => {
			if (index === 0) return Response.json({ id: "id:dropbox-file", path_display: "/Broker/cloud image.png" });
			if (index === 1)
				return Response.json({ url: "https://www.dropbox.com/scl/fi/abc/cloud-image.png?rlkey=key&dl=0" });
			return new Response("unexpected request", { status: 500 });
		});
		const uploader = configuredUploader(
			"dropbox",
			{ oauthToken: "dropbox-token" },
			{ uploadPath: "Broker" },
			transport.fetch,
		);

		const publication = await uploader.upload(uploadRequest);

		expect(transport.requests).toHaveLength(2);
		const [upload, share] = transport.requests;
		expect(upload?.url).toBe("https://content.dropboxapi.com/2/files/upload");
		expect(upload?.init.method).toBe("POST");
		expect(header(upload!, "authorization")).toBe("Bearer dropbox-token");
		expect(header(upload!, "content-type")).toBe("application/octet-stream");
		expect(JSON.parse(header(upload!, "dropbox-api-arg") ?? "null")).toEqual({
			path: "/Broker/cloud image.png",
			mode: "overwrite",
			autorename: false,
			mute: true,
		});
		expect(new Uint8Array(upload?.init.body as Uint8Array)).toEqual(new Uint8Array(uploadRequest.bytes));

		expect(share?.url).toBe("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings");
		expect(share?.init.method).toBe("POST");
		expect(header(share!, "authorization")).toBe("Bearer dropbox-token");
		expect(header(share!, "content-type")).toBe("application/json");
		expect(jsonBody(share!)).toEqual({
			path: "/Broker/cloud image.png",
			settings: { requested_visibility: "public" },
		});
		expect(publication).toEqual({
			destination: "dropbox",
			bytes: uploadRequest.bytes.byteLength,
			url: "https://dl.dropboxusercontent.com/scl/fi/abc/cloud-image.png?rlkey=key",
			remoteId: "id:dropbox-file",
			delete: {
				method: "POST",
				url: "https://api.dropboxapi.com/2/files/delete_v2",
				headers: { Authorization: "Bearer dropbox-token", "Content-Type": "application/json" },
				body: JSON.stringify({ path: "/Broker/cloud image.png" }),
			},
		});
		expect(publication.expiresAt).toBeUndefined();
	});

	it("OneDrive does not omit chunk ranges or return its anonymous embed viewer URL", async () => {
		const uploadUrl = "https://uploads.example.invalid/session/one";
		const transport = captureFetch((request, index) => {
			if (index === 0) return Response.json({ uploadUrl });
			if (index === 1) return Response.json({ id: "one/id" }, { status: 201 });
			if (index === 2) {
				return Response.json({ link: { webUrl: "https://onedrive.live.com/redir/embed?resid=abc&authkey=key" } });
			}
			return new Response(`unexpected ${request.url}`, { status: 500 });
		});
		const uploader = configuredUploader(
			"onedrive",
			{ oauthToken: "onedrive-token" },
			{ folderId: "folder/id" },
			transport.fetch,
		);

		const publication = await uploader.upload(uploadRequest);

		expect(transport.requests).toHaveLength(3);
		const [session, chunk, share] = transport.requests;
		expect(session?.url).toBe(
			"https://graph.microsoft.com/v1.0/me/drive/items/folder%2Fid:/cloud%20image.png:/createUploadSession",
		);
		expect(session?.init.method).toBe("POST");
		expect(header(session!, "authorization")).toBe("Bearer onedrive-token");
		expect(jsonBody(session!)).toEqual({ item: { "@microsoft.graph.conflictBehavior": "replace" } });
		expect(chunk?.url).toBe(uploadUrl);
		expect(chunk?.init.method).toBe("PUT");
		expect(header(chunk!, "content-length")).toBe(String(uploadRequest.bytes.byteLength));
		expect(header(chunk!, "content-range")).toBe(
			`bytes 0-${uploadRequest.bytes.byteLength - 1}/${uploadRequest.bytes.byteLength}`,
		);
		expect(new Uint8Array(chunk?.init.body as Uint8Array)).toEqual(new Uint8Array(uploadRequest.bytes));
		expect(share?.url).toBe("https://graph.microsoft.com/v1.0/me/drive/items/one%2Fid/createLink");
		expect(share?.init.method).toBe("POST");
		expect(header(share!, "authorization")).toBe("Bearer onedrive-token");
		expect(jsonBody(share!)).toEqual({ type: "embed", scope: "anonymous" });
		expect(publication).toEqual({
			destination: "onedrive",
			bytes: uploadRequest.bytes.byteLength,
			url: "https://onedrive.live.com/redir/download?resid=abc&authkey=key",
			remoteId: "one/id",
			delete: {
				method: "DELETE",
				url: "https://graph.microsoft.com/v1.0/me/drive/items/one%2Fid",
				headers: { Authorization: "Bearer onedrive-token" },
			},
		});
		expect(publication.expiresAt).toBeUndefined();
	});

	it("Google Drive does not skip multipart metadata or anyone-reader permission creation", async () => {
		const transport = captureFetch((_request, index) => {
			if (index === 0) return Response.json({ id: "google/id" });
			if (index === 1) return new Response(null, { status: 204 });
			return new Response("unexpected request", { status: 500 });
		});
		const uploader = configuredUploader(
			"google-drive",
			{ oauthToken: "google-token" },
			{ folderId: "shared-folder" },
			transport.fetch,
		);

		const publication = await uploader.upload(uploadRequest);

		expect(transport.requests).toHaveLength(2);
		const [upload, permission] = transport.requests;
		if (!upload) throw new Error("Google Drive multipart upload request was not captured");
		if (!(upload.init.body instanceof Blob)) throw new Error("Google Drive multipart body was not a Blob");
		expect(upload.url).toBe(
			"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink&supportsAllDrives=true",
		);
		expect(upload.init.method).toBe("POST");
		expect(header(upload, "authorization")).toBe("Bearer google-token");
		const contentType = header(upload, "content-type");
		expect(contentType).toMatch(/^multipart\/related; boundary=omp-/);
		const boundary = contentType?.slice("multipart/related; boundary=".length);
		const multipart = await upload.init.body.text();
		expect(multipart).toContain(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8`);
		expect(multipart).toContain(JSON.stringify({ name: "cloud image.png", parents: ["shared-folder"] }));
		expect(multipart).toContain("Content-Type: image/png\r\n\r\ncloud-drive-payload");
		expect(multipart.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);

		expect(permission?.url).toBe(
			"https://www.googleapis.com/drive/v3/files/google%2Fid/permissions?supportsAllDrives=true",
		);
		expect(permission?.init.method).toBe("POST");
		expect(header(permission!, "authorization")).toBe("Bearer google-token");
		expect(jsonBody(permission!)).toEqual({ role: "reader", type: "anyone", allowFileDiscovery: false });
		expect(publication).toEqual({
			destination: "google-drive",
			bytes: uploadRequest.bytes.byteLength,
			url: "https://drive.google.com/uc?id=google%2Fid",
			remoteId: "google/id",
			delete: {
				method: "DELETE",
				url: "https://www.googleapis.com/drive/v3/files/google%2Fid?supportsAllDrives=true",
				headers: { Authorization: "Bearer google-token" },
			},
		});
		expect(publication.expiresAt).toBeUndefined();
	});

	it("Box does not publish a viewer page instead of the open shared-link download URL", async () => {
		const transport = captureFetch((_request, index) => {
			if (index === 0) return Response.json({ entries: [{ id: "box/id" }] });
			if (index === 1) {
				return Response.json({ shared_link: { download_url: "https://public.boxcloud.com/direct-download" } });
			}
			return new Response("unexpected request", { status: 500 });
		});
		const uploader = configuredUploader(
			"box",
			{ oauthToken: "box-token" },
			{ folderId: "123", shareAccess: "open" },
			transport.fetch,
		);

		const publication = await uploader.upload(uploadRequest);

		expect(transport.requests).toHaveLength(2);
		const [upload, share] = transport.requests;
		expect(upload?.url).toBe("https://upload.box.com/api/2.0/files/content");
		expect(upload?.init.method).toBe("POST");
		expect(header(upload!, "authorization")).toBe("Bearer box-token");
		expect(header(upload!, "content-type")).toBeNull();
		const uploadForm = formBody(upload!);
		expect(uploadForm.get("parent_id")).toBe("123");
		const uploadedFile = uploadForm.get("filename");
		expect(uploadedFile).toBeInstanceOf(File);
		expect((uploadedFile as File).name).toBe("cloud image.png");
		expect((uploadedFile as File).type).toBe("image/png");
		expect(new Uint8Array(await (uploadedFile as File).arrayBuffer())).toEqual(new Uint8Array(uploadRequest.bytes));

		expect(share?.url).toBe("https://api.box.com/2.0/files/box%2Fid");
		expect(share?.init.method).toBe("PUT");
		expect(header(share!, "authorization")).toBe("Bearer box-token");
		expect(jsonBody(share!)).toEqual({ shared_link: { access: "open" } });
		expect(publication).toEqual({
			destination: "box",
			bytes: uploadRequest.bytes.byteLength,
			url: "https://public.boxcloud.com/direct-download",
			remoteId: "box/id",
			delete: {
				method: "DELETE",
				url: "https://api.box.com/2.0/files/box%2Fid",
				headers: { Authorization: "Bearer box-token" },
			},
		});
		expect(publication.expiresAt).toBeUndefined();
	});

	it("Pushbullet does not push before the presigned upload succeeds or lose the returned file_url", async () => {
		const presignedUrl = "https://uploads.example.invalid/pushbullet";
		const publicFileUrl = "https://cdn.example.invalid/cloud-image.png";
		const transport = captureFetch((_request, index) => {
			if (index === 0) {
				return Response.json({
					file_type: "image/png",
					file_url: publicFileUrl,
					upload_url: presignedUrl,
					data: {
						awsaccesskeyid: "aws-key",
						acl: "public-read",
						key: "pushbullet/object",
						signature: "signature",
						policy: "policy",
						"content-type": "image/png",
					},
				});
			}
			if (index === 1) return new Response(null, { status: 204 });
			if (index === 2) return Response.json({ iden: "push-id" });
			return new Response("unexpected request", { status: 500 });
		});
		const uploader = configuredUploader(
			"pushbullet",
			{ apiKey: "pushbullet-key" },
			{ deviceId: "device-id" },
			transport.fetch,
		);

		const publication = await uploader.upload(uploadRequest);

		expect(transport.requests).toHaveLength(3);
		const [presign, upload, push] = transport.requests;
		const basicAuth = `Basic ${btoa("pushbullet-key:")}`;
		expect(presign?.url).toBe("https://api.pushbullet.com/v2/upload-request");
		expect(presign?.init.method).toBe("POST");
		expect(header(presign!, "authorization")).toBe(basicAuth);
		expect(formBody(presign!).get("file_name")).toBe("cloud image.png");

		expect(upload?.url).toBe(presignedUrl);
		expect(upload?.init.method).toBe("POST");
		const uploadForm = formBody(upload!);
		expect(Object.fromEntries([...uploadForm.entries()].filter(([, value]) => typeof value === "string"))).toEqual({
			awsaccesskeyid: "aws-key",
			acl: "public-read",
			key: "pushbullet/object",
			signature: "signature",
			policy: "policy",
			"content-type": "image/png",
		});
		const uploadedFile = uploadForm.get("file");
		expect(uploadedFile).toBeInstanceOf(File);
		expect((uploadedFile as File).name).toBe("cloud image.png");
		expect(new Uint8Array(await (uploadedFile as File).arrayBuffer())).toEqual(new Uint8Array(uploadRequest.bytes));

		expect(push?.url).toBe("https://api.pushbullet.com/v2/pushes");
		expect(push?.init.method).toBe("POST");
		expect(header(push!, "authorization")).toBe(basicAuth);
		expect(Object.fromEntries(formBody(push!).entries())).toEqual({
			file_name: "cloud image.png",
			device_iden: "device-id",
			type: "file",
			file_url: publicFileUrl,
			body: "Sent via Oh My Pi",
			file_type: "image/png",
		});
		expect(publication).toEqual({
			destination: "pushbullet",
			bytes: uploadRequest.bytes.byteLength,
			url: publicFileUrl,
			remoteId: "push-id",
		});
		expect(publication.expiresAt).toBeUndefined();
		expect(publication.delete).toBeUndefined();
	});

	it.each([
		["Dropbox shared-link creation disabled", "dropbox", { createShareableLink: false }],
		["Dropbox direct-link conversion disabled", "dropbox", { directLink: false }],
		["OneDrive direct-link conversion disabled", "onedrive", { directLink: false }],
		["Google Drive public permission disabled", "google-drive", { public: false }],
		["Box direct-link publication disabled", "box", { directLink: false }],
		["Box collaborator-only sharing selected", "box", { shareAccess: "collaborators" }],
	] as const)("rejects %s before leaking bytes to the network", (_failure, destination, options) => {
		let networkCalls = 0;
		const fetch: FetchImpl = async () => {
			networkCalls++;
			return new Response(null, { status: 204 });
		};
		const credentials = { oauthToken: "unused" };

		expect(() => createCloudDriveUploader(destination, { credentials, options, fetch })).toThrow(
			DestinationUnavailableError,
		);
		expect(networkCalls).toBe(0);
	});
});
