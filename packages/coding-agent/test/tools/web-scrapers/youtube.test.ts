import { afterEach, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { handleYouTube } from "@oh-my-pi/pi-coding-agent/web/scrapers/youtube";
import { asGlobalFetch } from "../../helpers/fetch-mock";

const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const settings = Settings.isolated({ "providers.fetch": "native" });

afterEach(() => vi.restoreAllMocks());

for (const manualWorks of [true, false]) {
	it(
		manualWorks ? "prefers manual English captions" : "keeps metadata and falls back when manual captions fail",
		async () => {
			vi.spyOn(globalThis, "fetch").mockImplementation(
				asGlobalFetch((input, init) => {
					const url = new URL(String(input));
					if (url.pathname === "/youtubei/v1/player") {
						if (String(init?.body).includes('"WEB"')) {
							return Response.json({
								microformat: { playerMicroformatRenderer: { uploadDate: "2009-10-24T23:57:33-07:00" } },
							});
						}
						return Response.json({
							videoDetails: { title: "Example video", author: "Example channel", lengthSeconds: "213" },
							captions: {
								playerCaptionsTracklistRenderer: {
									captionTracks: [
										{
											languageCode: "en",
											kind: "asr",
											baseUrl: "https://www.youtube.com/api/timedtext?track=auto",
										},
										{ languageCode: "en-US", baseUrl: "https://www.youtube.com/api/timedtext?track=manual" },
									],
								},
							},
						});
					}
					if (url.pathname !== "/api/timedtext" || url.searchParams.get("fmt") !== "json3")
						return new Response(null, { status: 400 });
					const track = url.searchParams.get("track");
					if (track === "manual" && !manualWorks) return new Response(null, { status: 404 });
					return Response.json({ events: [{ segs: [{ utf8: `${track} caption` }, { utf8: "\ntext" }] }] });
				}),
			);
			const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 10, undefined, null, undefined, settings);
			expect(result?.finalUrl).toBe(VIDEO_URL);
			expect(result?.content).toContain("# Example video");
			expect(result?.content).toContain("**Duration:** 3:33");
			expect(result?.content).toContain("**Uploaded:** 2009-10-24");
			expect(result?.content).toContain(
				manualWorks
					? "## Transcript (manual)\n\nmanual caption text"
					: "## Transcript (auto-generated)\n\nauto caption text",
			);
		},
	);
}

it("falls through when the player cannot provide metadata", async () => {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(() => Response.json({ playabilityStatus: { status: "ERROR" } })),
	);
	expect(await handleYouTube(VIDEO_URL, 10, undefined, null, undefined, settings)).toBeNull();
});

it.skipIf(!Bun.env.WEB_FETCH_INTEGRATION)("reads metadata and manual captions from YouTube", async () => {
	const result = await handleYouTube(VIDEO_URL, 10, undefined, null, undefined, settings);
	expect(result?.content).toContain("Rick Astley");
	expect(result?.content).toContain("## Transcript (manual)");
});
