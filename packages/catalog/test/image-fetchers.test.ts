import { describe, expect, it } from "bun:test";
import { identifyImageFetcher } from "@oh-my-pi/pi-catalog/wire/image-fetchers";

/** Header sets captured from live provider fetches of a URL-sourced image. */
const captured = {
	openai: {
		"user-agent": "OpenAI File Downloader",
		"openai-internal-smokescreener": "responses-role",
		accept: "*/*",
		"accept-encoding": "gzip, deflate, br, zstd",
	},
	anthropicImage: {
		"user-agent": "Claude-User",
		traceparent: "00-bee62ec7b00767173446521509c98a47-1f40bc3cef582b42-01",
		"x-cloud-trace-context": "bee62ec7b00767173446521509c98a47/2252006783584840514;o=1",
		accept: "*/*",
	},
	anthropicLink: {
		"user-agent":
			"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)",
		accept: "*/*",
		"accept-encoding": "gzip, deflate",
	},
	xai: {
		"user-agent":
			"XaiImageApiFetch/1.0 (Linux; x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
		"x-xaifetchid": "003ed28b-1a14-9398-b4ba-56462fbba471",
		traceparent: "00-af44fc5536c608a7d50895a012cfed4d-9a0367ef00006f61-01",
		accept: "image/jpeg, image/jpg, image/png, image/webp, image/x-icon, image/vnd.microsoft.icon",
	},
	google: {
		"user-agent": "Google",
		accept: "*/*",
		"accept-encoding": "gzip, deflate, br",
	},
} as const;

describe("identifyImageFetcher", () => {
	it("attributes each vendor's captured fetch and reports proprietary-header corroboration", () => {
		// Vendors sending a proprietary marker corroborate; vendors sending only
		// generic trace headers (or nothing) cannot, and must still be attributed.
		expect(identifyImageFetcher(captured.openai)).toMatchObject({
			id: "openai-file-downloader",
			corroborated: true,
		});
		expect(identifyImageFetcher(captured.xai)).toMatchObject({ id: "xai-image-api-fetch", corroborated: true });
		expect(identifyImageFetcher(captured.anthropicImage)).toMatchObject({
			id: "anthropic-claude-user",
			corroborated: false,
		});
		expect(identifyImageFetcher(captured.google)).toMatchObject({ id: "google", corroborated: false });
	});

	it("keeps the match when a proprietary marker is absent, downgrading only corroboration", () => {
		// A forged agent string reaches the same identity: attribution is not proof,
		// so the match must survive while corroboration reports the missing marker.
		const { "openai-internal-smokescreener": _marker, ...spoofed } = captured.openai;

		expect(identifyImageFetcher(spoofed)).toMatchObject({ id: "openai-file-downloader", corroborated: false });
	});

	it("separates Anthropic's link fetcher from its image fetcher", () => {
		// Both agents carry "Claude-User"; only the bare form served an image
		// request, so a blob server must not count the versioned form as one.
		expect(identifyImageFetcher(captured.anthropicLink)?.id).toBe("anthropic-claude-user-preview");
		expect(identifyImageFetcher(captured.anthropicImage)?.id).toBe("anthropic-claude-user");
	});

	it("tracks the xAI fetcher across client version bumps", () => {
		expect(
			identifyImageFetcher({ "user-agent": "XaiImageApiFetch/2.31 (Linux; aarch64) AppleWebKit/537.36" })?.id,
		).toBe("xai-image-api-fetch");
		// Version segment is required: the bare product name is not the contract.
		expect(identifyImageFetcher({ "user-agent": "XaiImageApiFetch" })).toBeNull();
	});

	it("reads headers from a Headers instance and is case-insensitive over raw keys", () => {
		expect(identifyImageFetcher(new Headers(captured.openai))).toMatchObject({
			id: "openai-file-downloader",
			corroborated: true,
		});
		expect(
			identifyImageFetcher({
				"User-Agent": "OpenAI File Downloader",
				"OpenAI-Internal-Smokescreener": "responses-role",
			}),
		).toMatchObject({ id: "openai-file-downloader", corroborated: true });
	});

	it("returns null for unknown and absent agents", () => {
		expect(identifyImageFetcher({ "user-agent": "curl/8.7.1" })).toBeNull();
		expect(identifyImageFetcher({ accept: "*/*" })).toBeNull();
		expect(identifyImageFetcher({ "user-agent": "" })).toBeNull();
	});
});
