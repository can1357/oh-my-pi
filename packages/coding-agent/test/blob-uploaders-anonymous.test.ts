import { describe, expect, it } from "bun:test";
import type { BlobUploader, BlobUploadRequest } from "../src/blob-broker/publication";
import type { DestinationRuntimeConfig, FetchImpl } from "../src/blob-broker/uploader-runtime";
import { createAnonymousUploader } from "../src/blob-broker/uploaders-anonymous";
import { createDiscordUploader } from "../src/blob-broker/uploaders-discord";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const request: BlobUploadRequest = {
	bytes: new Uint8Array([0x62, 0x6c, 0x6f, 0x62]),
	mimeType: "image/png",
	extension: "png",
	filename: "captures/pixel.png",
};

function config(
	fetch: FetchImpl,
	options: DestinationRuntimeConfig["options"] = {},
	credentials: DestinationRuntimeConfig["credentials"] = {},
): DestinationRuntimeConfig {
	return { options, credentials, fetch };
}

function anonymousUploader(
	destination: "catbox" | "litterbox" | "0x0" | "uguu" | "tmpfiles" | "pomf",
	runtime: DestinationRuntimeConfig,
): BlobUploader {
	const uploader = createAnonymousUploader(destination, runtime);
	if (!uploader) throw new Error(`Expected an anonymous uploader for ${destination}`);
	return uploader;
}

async function expectMultipart(
	init: RequestInit | undefined,
	keys: readonly string[],
	fileField: string,
): Promise<FormData> {
	expect(init?.method).toBe("POST");
	expect(init?.body).toBeInstanceOf(FormData);
	const form = init?.body as FormData;
	expect(Array.from(form.keys())).toEqual([...keys]);
	const upload = form.get(fileField);
	expect(upload).toBeInstanceOf(File);
	const file = upload as File;
	expect(file.name).toBe("pixel.png");
	expect(file.type).toBe("image/png");
	expect(await file.text()).toBe("blob");
	return form;
}

describe("anonymous blob uploader factories", () => {
	it("Catbox includes the userhash and preserves the account-backed delete request", async () => {
		let calls = 0;
		const uploader = anonymousUploader(
			"catbox",
			config(
				async (input, init) => {
					calls++;
					expect(String(input)).toBe("https://catbox.moe/user/api.php");
					const form = await expectMultipart(init, ["reqtype", "userhash", "fileToUpload"], "fileToUpload");
					expect(form.get("reqtype")).toBe("fileupload");
					expect(form.get("userhash")).toBe("cat-user-hash");
					return new Response("https://files.catbox.moe/cat-file.png\n");
				},
				{},
				{ userHash: "cat-user-hash" },
			),
		);

		const publication = await uploader.upload(request);

		expect(calls).toBe(1);
		expect(publication).toEqual({
			url: "https://files.catbox.moe/cat-file.png",
			destination: "catbox",
			bytes: 4,
			remoteId: "cat-file.png",
			delete: {
				method: "POST",
				url: "https://catbox.moe/user/api.php",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "reqtype=deletefiles&userhash=cat-user-hash&files=cat-file.png",
			},
		});
	});

	it("Litterbox sends the selected time field and does not report the default expiry", async () => {
		let calls = 0;
		const uploader = anonymousUploader(
			"litterbox",
			config(
				async (input, init) => {
					calls++;
					expect(String(input)).toBe("https://litterbox.catbox.moe/resources/internals/api.php");
					const form = await expectMultipart(init, ["reqtype", "time", "fileToUpload"], "fileToUpload");
					expect(form.get("reqtype")).toBe("fileupload");
					expect(form.get("time")).toBe("72h");
					return new Response("https://litter.catbox.moe/litter-file.png");
				},
				{ ttl: "72h" },
			),
		);
		const before = Date.now();

		const publication = await uploader.upload(request);
		const after = Date.now();

		expect(calls).toBe(1);
		expect(publication.url).toBe("https://litter.catbox.moe/litter-file.png");
		expect(publication.destination).toBe("litterbox");
		expect(publication.remoteId).toBe("litter-file.png");
		expect(publication.expiresAt).toBeGreaterThanOrEqual(before + 72 * HOUR_MS);
		expect(publication.expiresAt).toBeLessThanOrEqual(after + 72 * HOUR_MS);
		expect(publication.delete).toBeUndefined();
	});

	it("0x0 turns X-Token into the provider's form-encoded deletion contract", async () => {
		let calls = 0;
		const uploader = anonymousUploader(
			"0x0",
			config(async (input, init) => {
				calls++;
				expect(String(input)).toBe("https://0x0.st");
				await expectMultipart(init, ["file"], "file");
				return new Response("https://0x0.st/zero-file.png\n", { headers: { "X-Token": "delete-token" } });
			}),
		);
		const before = Date.now();

		const publication = await uploader.upload(request);
		const after = Date.now();

		expect(calls).toBe(1);
		expect(publication).toMatchObject({
			url: "https://0x0.st/zero-file.png",
			destination: "0x0",
			bytes: 4,
			remoteId: "zero-file.png",
			delete: {
				method: "POST",
				url: "https://0x0.st/zero-file.png",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "token=delete-token&delete=",
			},
		});
		expect(publication.expiresAt).toBeGreaterThan(before + 364 * DAY_MS);
		expect(publication.expiresAt).toBeLessThan(after + 366 * DAY_MS);
	});

	it("Uguu uses files[] and exposes its fixed three-hour lifetime", async () => {
		let calls = 0;
		const uploader = anonymousUploader(
			"uguu",
			config(async (input, init) => {
				calls++;
				expect(String(input)).toBe("https://uguu.se/upload?output=text");
				await expectMultipart(init, ["files[]"], "files[]");
				return new Response("https://uguu.se/files/uguu-file.png\n");
			}),
		);
		const before = Date.now();

		const publication = await uploader.upload(request);
		const after = Date.now();

		expect(calls).toBe(1);
		expect(publication.url).toBe("https://uguu.se/files/uguu-file.png");
		expect(publication.destination).toBe("uguu");
		expect(publication.remoteId).toBe("uguu-file.png");
		expect(publication.expiresAt).toBeGreaterThanOrEqual(before + 3 * HOUR_MS);
		expect(publication.expiresAt).toBeLessThanOrEqual(after + 3 * HOUR_MS);
	});

	it("tmpfiles sends expire seconds and converts the landing URL to /dl", async () => {
		let calls = 0;
		const uploader = anonymousUploader(
			"tmpfiles",
			config(
				async (input, init) => {
					calls++;
					expect(String(input)).toBe("https://tmpfiles.org/api/v1/upload");
					const form = await expectMultipart(init, ["expire", "file"], "file");
					expect(form.get("expire")).toBe("5400");
					return Response.json({ data: { url: "https://tmpfiles.org/receipt-id/tmp-file.png" } });
				},
				{ ttl: "90m" },
			),
		);
		const before = Date.now();

		const publication = await uploader.upload(request);
		const after = Date.now();

		expect(calls).toBe(1);
		expect(publication.url).toBe("https://tmpfiles.org/dl/receipt-id/tmp-file.png");
		expect(publication.destination).toBe("tmpfiles");
		expect(publication.remoteId).toBe("receipt-id");
		expect(publication.expiresAt).toBeGreaterThanOrEqual(before + 90 * 60 * 1_000);
		expect(publication.expiresAt).toBeLessThanOrEqual(after + 90 * 60 * 1_000);
	});

	it("Pomf follows the configured JSON path instead of assuming files.0.url", async () => {
		let calls = 0;
		const uploader = anonymousUploader(
			"pomf",
			config(
				async (input, init) => {
					calls++;
					expect(String(input)).toBe("https://pomf.example.test/api/upload");
					await expectMultipart(init, ["upload"], "upload");
					return Response.json({ result: { uploads: [{ direct: "assets/pomf-file.png" }] } });
				},
				{
					uploadUrl: "https://pomf.example.test/api/upload",
					fileField: "upload",
					urlPath: "result.uploads.0.direct",
					resultBaseUrl: "https://cdn.example.test/public",
				},
			),
		);

		const publication = await uploader.upload(request);

		expect(calls).toBe(1);
		expect(publication).toEqual({
			url: "https://cdn.example.test/public/assets/pomf-file.png",
			destination: "pomf",
			bytes: 4,
			remoteId: "pomf-file.png",
		});
	});
});

describe("Discord blob uploader factory", () => {
	it("waits for the threaded upload response and returns the matching message delete request", async () => {
		let calls = 0;
		const attachmentUrl = "https://cdn.discordapp.com/attachments/channel/message/pixel.png?ex=65f00000&is=65dd8e80";
		const uploader = createDiscordUploader(
			"discord",
			config(
				async (input, init) => {
					calls++;
					expect(String(input)).toBe(
						"https://discord.com/api/v10/webhooks/123456789012345678/webhook-token?wait=true&thread_id=987654321098765432",
					);
					const form = await expectMultipart(init, ["payload_json", "files[0]"], "files[0]");
					expect(JSON.parse(String(form.get("payload_json")))).toEqual({
						attachments: [{ id: 0, filename: "pixel.png" }],
						content: "uploaded from test",
					});
					return Response.json({
						id: "112233445566778899",
						attachments: [{ url: attachmentUrl }],
					});
				},
				{ content: "uploaded from test", threadId: "987654321098765432" },
				{ webhookUrl: "https://discord.com/api/webhooks/123456789012345678/webhook-token" },
			),
		);
		if (!uploader) throw new Error("Expected a Discord uploader");

		const publication = await uploader.upload(request);

		expect(calls).toBe(1);
		expect(publication).toEqual({
			url: attachmentUrl,
			destination: "discord",
			bytes: 4,
			expiresAt: 0x65f00000 * 1_000,
			remoteId: "112233445566778899",
			delete: {
				method: "DELETE",
				url: "https://discord.com/api/v10/webhooks/123456789012345678/webhook-token/messages/112233445566778899?thread_id=987654321098765432",
			},
		});
	});
});
