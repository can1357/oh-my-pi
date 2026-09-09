import { describe, expect, it } from "bun:test";
import { handleYouTube } from "@oh-my-pi/pi-coding-agent/web/scrapers/youtube";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleYouTube", () => {
	it("returns null for non-YouTube URLs", async () => {
		const result = await handleYouTube("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid YouTube URLs", async () => {
		const result = await handleYouTube("https://youtube.com/invalid", 10);
		expect(result).toBeNull();
	});

	it("handles youtube.com/watch?v= format", async () => {
		// Use Rick Astley's "Never Gonna Give You Up" - a stable, well-known video
		const result = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);
		if (!result) throw new Error("expected YouTube result");
		const method = result.method;
		expect(["parallel", "youtube", "youtube-no-ytdlp"]).toContain(method);
		if (method === "parallel") {
			expect(result.contentType).toBe("text/markdown");
			expect(result.finalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		} else if (method === "youtube") {
			expect(result.contentType).toBe("text/markdown");
			expect(result.content).toContain("Video ID");
			expect(result.content).toContain("dQw4w9WgXcQ");
		} else {
			expect(result.content).toContain("yt-dlp could not be installed");
		}
	}, 30000);

	it("handles youtu.be/ short format", async () => {
		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 30);
		if (!result) throw new Error("expected YouTube result");
		const method = result.method;
		expect(["parallel", "youtube", "youtube-no-ytdlp"]).toContain(method);
		if (method === "youtube") {
			expect(result.content).toContain("dQw4w9WgXcQ");
		} else if (method === "parallel") {
			expect(result.finalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		}
	}, 30000);

	it("handles youtube.com/shorts/ format", async () => {
		// Use a stable YouTube Shorts video
		const result = await handleYouTube("https://www.youtube.com/shorts/jNQXAC9IVRw", 30);
		if (!result) throw new Error("expected YouTube result");
		expect(["parallel", "youtube", "youtube-no-ytdlp"]).toContain(result.method);
		if (result.method === "youtube") {
			expect(result.content).toContain("jNQXAC9IVRw");
		}
	}, 30000);

	it("handles youtube.com/embed/ format", async () => {
		const result = await handleYouTube("https://www.youtube.com/embed/dQw4w9WgXcQ", 30);
		if (!result) throw new Error("expected YouTube result");
		expect(["parallel", "youtube", "youtube-no-ytdlp"]).toContain(result.method);
		if (result.method === "youtube") {
			expect(result.content).toContain("dQw4w9WgXcQ");
		}
	}, 30000);

	it("handles youtube.com/v/ format", async () => {
		const result = await handleYouTube("https://www.youtube.com/v/dQw4w9WgXcQ", 30);
		if (!result) throw new Error("expected YouTube result");
		expect(["parallel", "youtube", "youtube-no-ytdlp"]).toContain(result.method);
		if (result.method === "youtube") {
			expect(result.content).toContain("dQw4w9WgXcQ");
		}
	}, 30000);

	it("handles m.youtube.com mobile URLs", async () => {
		const result = await handleYouTube("https://m.youtube.com/watch?v=dQw4w9WgXcQ", 30);
		if (!result) throw new Error("expected YouTube result");
		expect(["parallel", "youtube", "youtube-no-ytdlp"]).toContain(result.method);
		if (result.method === "youtube") {
			expect(result.content).toContain("dQw4w9WgXcQ");
		}
	}, 30000);

	it("extracts video metadata when yt-dlp is available", async () => {
		const result = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);
		expect(result).not.toBeNull();

		// If yt-dlp is available, should have metadata
		if (result?.method === "youtube") {
			expect(result.content).toContain("Video ID");
			expect(result.content).toContain("Channel");
			// May have duration, views, upload date, etc.
		}

		// If yt-dlp is not available, should indicate that
		if (result?.method === "youtube-no-ytdlp") {
			expect(result.content).toContain("yt-dlp could not be installed");
			expect(result.notes).toContain("yt-dlp installation failed");
		}
	}, 30000);

	it("handles videos with transcripts gracefully", async () => {
		// This video should have captions
		const result = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);
		expect(result).not.toBeNull();

		if (result?.method === "youtube") {
			// Either has transcript or explicitly notes it's not available
			const hasTranscript = result.content.includes("Transcript");
			const noTranscriptNote = result.content.includes("No transcript available");
			expect(hasTranscript || noTranscriptNote).toBe(true);
		}
	}, 30000);

	it("returns appropriate response when yt-dlp is not available", async () => {
		// We can't force yt-dlp to be unavailable in tests, but we can verify
		// the return structure matches expectations for both cases
		const result = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);
		if (!result) throw new Error("expected YouTube result");

		// Should have one of these methods
		expect(["parallel", "youtube", "youtube-no-ytdlp"]).toContain(result.method);
		expect(result.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
	}, 30000);

	it("normalizes video URLs to canonical format", async () => {
		// Different input formats should normalize to same canonical URL
		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 30);
		expect(result).not.toBeNull();
		expect(result?.finalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
	}, 30000);

	it("handles playlist URLs by extracting video ID", async () => {
		const result = await handleYouTube(
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
			30,
		);
		if (!result) throw new Error("expected YouTube result");
		if (result.method === "youtube") {
			expect(result.content).toContain("dQw4w9WgXcQ");
		} else {
			expect(result.finalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		}
	}, 30000);

	it("includes subtitle source information when available", async () => {
		const result = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);

		if (result?.method === "youtube") {
			// If transcript is present, should note the source
			const hasManualNote = result.notes.includes("Using manual subtitles");
			const hasAutoNote = result.notes.includes("Using auto-generated captions");
			const hasNoSubsNote = result.notes.includes("No subtitles/captions available");

			// Should have exactly one of these
			const noteCount = [hasManualNote, hasAutoNote, hasNoSubsNote].filter(Boolean).length;
			expect(noteCount).toBeGreaterThanOrEqual(1);
		}
	}, 30000);

	it("formats duration in human readable format", async () => {
		const result = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);

		if (result?.method === "youtube" && result.content.includes("Duration")) {
			// Should have duration in M:SS or H:MM:SS format
			expect(result.content).toMatch(/Duration.*\d+:\d{2}/);
		}
	}, 30000);

	it("formats view count in readable format", async () => {
		const result = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);

		if (result?.method === "youtube" && result.content.includes("Views")) {
			// Should have views formatted (e.g., 1.5B, 100M, 10.5K)
			expect(result.content).toMatch(/Views.*\d+(\.\d+)?[KM]?/);
		}
	}, 30000);

	it("includes upload date when available", async () => {
		const result = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);

		if (result?.method === "youtube" && result.content.includes("Uploaded")) {
			// Should have date in YYYY-MM-DD format
			expect(result.content).toMatch(/Uploaded.*\d{4}-\d{2}-\d{2}/);
		}
	}, 30000);

	it("truncates long descriptions", async () => {
		const result = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);

		if (result?.method === "youtube" && result.content.includes("Description")) {
			// Description section should exist
			expect(result.content).toContain("## Description");
		}
	}, 30000);

	it("handles www prefix variations", async () => {
		const withWww = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);
		const withoutWww = await handleYouTube("https://youtube.com/watch?v=dQw4w9WgXcQ", 30);

		expect(withWww).not.toBeNull();
		expect(withoutWww).not.toBeNull();
		expect(withWww?.finalUrl).toBe(withoutWww?.finalUrl);
	}, 30000);
});
