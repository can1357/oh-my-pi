import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import { handleYouTube } from "@oh-my-pi/pi-coding-agent/web/scrapers/youtube";
import { ptree } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

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
			// Duration renders as M:SS or H:MM:SS, upload date as YYYY-MM-DD.
			if (result.content.includes("Duration")) {
				expect(result.content).toMatch(/Duration.*\d+:\d{2}/);
			}
			if (result.content.includes("Uploaded")) {
				expect(result.content).toMatch(/Uploaded.*\d{4}-\d{2}-\d{2}/);
			}
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

	it("handles www prefix variations", async () => {
		const withWww = await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 30);
		const withoutWww = await handleYouTube("https://youtube.com/watch?v=dQw4w9WgXcQ", 30);

		expect(withWww).not.toBeNull();
		expect(withoutWww).not.toBeNull();
		expect(withWww?.finalUrl).toBe(withoutWww?.finalUrl);
	}, 30000);
});

const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const MANUAL_VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.000
Never gonna give you up

00:00:04.000 --> 00:00:07.000
Never gonna let you down
`;

const AUTO_VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.500 --> 00:00:03.500
automatically generated caption

00:00:03.500 --> 00:00:06.500
second generated caption
`;

/** yt-dlp `--dump-json` record with the caption maps the scraper branches on. */
function metaJson(overrides: Record<string, unknown>): string {
	return JSON.stringify({
		title: "Never Gonna Give You Up",
		channel: "Rick Astley",
		description: "Official video for the song.",
		duration: 213,
		upload_date: "20091025",
		view_count: 1_500_000_000,
		...overrides,
	});
}

interface FakeSpawn {
	ok?: boolean;
	stdout?: string;
	stderr?: string;
	/** Written next to the `-o` template, like a real yt-dlp subtitle download. */
	subtitle?: string;
}

/**
 * Fake yt-dlp: the combined `--dump-json` spawn yields metadata plus the manual
 * subtitle, `--write-auto-sub` is the automatic-caption fallback. Returns the
 * invocations in order so tests can assert how many processes were started.
 */
function fakeYtDlp(metadata: FakeSpawn, autoCaptions?: FakeSpawn): string[][] {
	const calls: string[][] = [];
	const finish = async (spawn: FakeSpawn, args: string[]) => {
		const template = args[args.indexOf("-o") + 1];
		// --dump-json implies --simulate, which returns before yt-dlp writes subtitle files.
		const writesSubs = args.includes("--write-sub") || args.includes("--write-auto-sub");
		const simulates = args.includes("--dump-json") && !args.includes("--no-simulate");
		if (spawn.subtitle && writesSubs && !simulates) await Bun.write(`${template}.en.vtt`, spawn.subtitle);
		const ok = spawn.ok ?? false;
		return { ok, stdout: spawn.stdout ?? "", stderr: spawn.stderr ?? "", exitCode: ok ? 0 : 1 };
	};
	vi.spyOn(toolsManager, "ensureTool").mockResolvedValue("/usr/bin/yt-dlp");
	vi.spyOn(ptree, "exec").mockImplementation((async (cmd: string[]) => {
		const args = [...cmd];
		calls.push(args);
		if (args.includes("--dump-json")) return finish(metadata, args);
		if (args.includes("--write-auto-sub") && autoCaptions) return finish(autoCaptions, args);
		throw new Error(`unexpected yt-dlp invocation: ${args.join(" ")}`);
	}) as never);
	return calls;
}

describe("handleYouTube yt-dlp captions", () => {
	let settingsState: SettingsTestState;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		// Keep the suite on the yt-dlp path instead of the Parallel extract branch.
		await Settings.init({ inMemory: true, overrides: { "providers.fetch": "native" } });
	});

	afterEach(() => {
		restoreSettingsTestState(settingsState);
	});

	it("keeps metadata and manual subtitles when the combined spawn exits nonzero", async () => {
		const calls = fakeYtDlp({
			ok: false,
			// yt-dlp prints --dump-json before it writes subtitle files, so a
			// failing subtitle transfer exits nonzero with valid JSON on stdout.
			stdout: metaJson({
				subtitles: { en: [{ ext: "vtt", url: "https://example.com/en.vtt" }] },
				automatic_captions: { "en-orig": [{ ext: "vtt", url: "https://example.com/auto.vtt" }] },
			}),
			stderr: "ERROR: unable to download subtitles: HTTP Error 403",
			subtitle: MANUAL_VTT,
		});

		const result = await handleYouTube(VIDEO_URL, 30);

		expect(result?.method).toBe("youtube");
		expect(result?.content).toContain("# Never Gonna Give You Up");
		expect(result?.content).toContain("**Channel:** Rick Astley");
		expect(result?.content).toContain("**Duration:** 3:33");
		expect(result?.content).toContain("**Video ID:** dQw4w9WgXcQ");
		expect(result?.content).toContain("## Transcript (manual)");
		expect(result?.content).toContain("Never gonna give you up");
		expect(result?.notes).toContain("Using manual subtitles");
		// Metadata and subtitles share a single process; no fallback spawn.
		expect(calls).toHaveLength(1);
	});

	it("falls back to automatic captions when the manual subtitle transfer failed", async () => {
		const calls = fakeYtDlp(
			{
				ok: false,
				stdout: metaJson({
					subtitles: { en: [{ ext: "vtt", url: "https://example.com/en.vtt" }] },
					automatic_captions: { "en-orig": [{ ext: "vtt", url: "https://example.com/auto.vtt" }] },
				}),
				stderr: "ERROR: unable to download subtitles: HTTP Error 403",
			},
			{ ok: true, subtitle: AUTO_VTT },
		);

		const result = await handleYouTube(VIDEO_URL, 30);

		expect(result?.method).toBe("youtube");
		// Metadata survives the failed subtitle transfer instead of degrading
		// to the "YouTube Video" placeholder.
		expect(result?.content).toContain("# Never Gonna Give You Up");
		expect(result?.content).not.toContain("# YouTube Video");
		expect(result?.content).toContain("## Transcript (auto-generated)");
		expect(result?.content).toContain("automatically generated caption");
		expect(result?.notes).toContain("Using auto-generated captions");
		expect(calls).toHaveLength(2);
	});

	it("falls back to automatic captions when only automatic captions are advertised", async () => {
		const calls = fakeYtDlp(
			{ ok: true, stdout: metaJson({ automatic_captions: { "en-orig": [{ ext: "vtt" }] } }) },
			{
				ok: true,
				subtitle: AUTO_VTT,
			},
		);

		const result = await handleYouTube(VIDEO_URL, 30);

		expect(result?.method).toBe("youtube");
		expect(result?.content).toContain("## Transcript (auto-generated)");
		expect(result?.content).toContain("second generated caption");
		expect(result?.notes).toContain("Using auto-generated captions");
		expect(calls).toHaveLength(2);
	});

	it("reports no transcript when the spawn yields no usable JSON", async () => {
		const calls = fakeYtDlp({ ok: false, stdout: "", stderr: "ERROR: Video unavailable" });

		const result = await handleYouTube(VIDEO_URL, 30);

		expect(result?.method).toBe("youtube");
		expect(result?.content).toContain("# YouTube Video");
		expect(result?.content).toContain("*No transcript available for this video.*");
		expect(result?.notes).toContain("No subtitles/captions available");
		// No caption maps parsed, so the automatic-caption fallback never spawns.
		expect(calls).toHaveLength(1);
	});
});
