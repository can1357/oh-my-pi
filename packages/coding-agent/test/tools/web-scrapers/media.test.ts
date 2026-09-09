import { describe, expect, it } from "bun:test";
import { handleHuggingFace } from "@oh-my-pi/pi-coding-agent/web/scrapers/huggingface";
import { handleSpotify } from "@oh-my-pi/pi-coding-agent/web/scrapers/spotify";
import { handleVimeo } from "@oh-my-pi/pi-coding-agent/web/scrapers/vimeo";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleVimeo", () => {
	it("returns null for non-Vimeo URLs", async () => {
		const result = await handleVimeo("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid Vimeo URLs", async () => {
		const result = await handleVimeo("https://vimeo.com/invalid", 10);
		expect(result).toBeNull();
	});

	it("fetches video metadata via oEmbed", async () => {
		const result = await handleVimeo("https://vimeo.com/1084537", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("vimeo");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Video ID");
		expect(result?.notes).toContain("Fetched via Vimeo oEmbed API");
	});

	it("handles player.vimeo.com URLs", async () => {
		const result = await handleVimeo("https://player.vimeo.com/video/1084537", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("vimeo");
		expect(result?.content).toContain("Video ID");
	});

	it("handles vimeo.com/user/video format", async () => {
		const result = await handleVimeo("https://vimeo.com/staffpicks/1084537", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("vimeo");
	});
});

describe.skipIf(SKIP)("handleSpotify", () => {
	it("returns null for non-Spotify URLs", async () => {
		const result = await handleSpotify("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid Spotify URLs", async () => {
		const result = await handleSpotify("https://open.spotify.com/invalid/xyz", 10);
		expect(result).toBeNull();
	});

	it("identifies track URLs", async () => {
		const result = await handleSpotify("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("spotify");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Type");
		expect(result?.content).toContain("track");
	});

	it("identifies album URLs", async () => {
		const result = await handleSpotify("https://open.spotify.com/album/2ODvWsOgouMbaA5xf0RkJe", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("spotify");
		expect(result?.content).toContain("album");
	});

	it("identifies playlist URLs", async () => {
		const result = await handleSpotify("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("spotify");
		expect(result?.content).toContain("playlist");
	});

	it("identifies podcast episode URLs", async () => {
		const result = await handleSpotify("https://open.spotify.com/episode/0Q86acNRm6V9GYx55SXKwf", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("spotify");
		expect(result?.content).toContain("podcast-episode");
	});

	it("identifies podcast show URLs", async () => {
		const result = await handleSpotify("https://open.spotify.com/show/2MAi0BvDc6GTFvKFPXnkCL", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("spotify");
		expect(result?.content).toContain("podcast-show");
	});
});

describe.skipIf(SKIP)("handleHuggingFace", () => {
	it("returns null for non-HF URLs", async () => {
		const result = await handleHuggingFace("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid HF URLs", async () => {
		const result = await handleHuggingFace("https://huggingface.co", 10);
		expect(result).toBeNull();
	});

	it("fetches model info", async () => {
		const result = await handleHuggingFace("https://huggingface.co/bert-base-uncased", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("huggingface");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("bert-base-uncased");
	});

	it("fetches dataset info", async () => {
		const result = await handleHuggingFace("https://huggingface.co/datasets/squad", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("huggingface");
		expect(result?.content).toContain("squad");
	});

	it("fetches space info", async () => {
		const result = await handleHuggingFace("https://huggingface.co/spaces/gradio/hello_world", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("huggingface");
		expect(result?.content).toContain("gradio/hello_world");
	});

	it("fetches model without org prefix", async () => {
		// Some models like bert-base-uncased don't have an org prefix
		const result = await handleHuggingFace("https://huggingface.co/bert-base-uncased", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("huggingface");
		expect(result?.content).toContain("bert-base-uncased");
	});

	it("handles org/model format", async () => {
		const result = await handleHuggingFace("https://huggingface.co/google/bert_uncased_L-2_H-128_A-2", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("huggingface");
		expect(result?.content).toContain("google/bert_uncased_L-2_H-128_A-2");
	});
});
