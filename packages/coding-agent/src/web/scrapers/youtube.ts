import { ptree, tryParseJson } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { AgentStorageApi } from "../../session/agent-storage";
import { cfgProvidersFetch } from "../../session/settings";
import { throwIfAborted } from "../../tools/tool-errors";
import { extractWithParallel, findParallelApiKey, getParallelExtractContent } from "../parallel";
import type { RenderResult, SpecialHandler } from "./types";
import {
	buildResult,
	formatIsoDate,
	formatMediaDuration,
	formatNumber,
	handlerSettings,
	loadPage,
	type LoadPageOptions,
} from "./types";

interface YouTubeUrl {
	videoId: string;
	playlistId?: string;
}

/**
 * Parse YouTube URL into components
 */
function parseYouTubeUrl(url: string): YouTubeUrl | null {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.replace(/^www\./, "");

		// youtube.com/watch?v=VIDEO_ID
		if ((hostname === "youtube.com" || hostname === "m.youtube.com") && parsed.pathname === "/watch") {
			const videoId = parsed.searchParams.get("v");
			const playlistId = parsed.searchParams.get("list") || undefined;
			if (videoId) return { videoId, playlistId };
		}

		// youtube.com/v/VIDEO_ID or youtube.com/embed/VIDEO_ID
		if (hostname === "youtube.com" || hostname === "m.youtube.com") {
			const match = parsed.pathname.match(/^\/(v|embed)\/([a-zA-Z0-9_-]{11})/);
			if (match) return { videoId: match[2] };
		}

		// youtu.be/VIDEO_ID
		if (hostname === "youtu.be") {
			const videoId = parsed.pathname.slice(1).split("/")[0];
			if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
				return { videoId };
			}
		}

		// youtube.com/shorts/VIDEO_ID
		if (hostname === "youtube.com" && parsed.pathname.startsWith("/shorts/")) {
			const videoId = parsed.pathname.replace("/shorts/", "").split("/")[0];
			if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
				return { videoId };
			}
		}
	} catch {}

	return null;
}

interface CaptionTrack {
	baseUrl: string;
	languageCode: string;
	kind?: string;
}

interface PlayerResponse {
	videoDetails?: {
		title?: string;
		author?: string;
		shortDescription?: string;
		lengthSeconds?: string;
		viewCount?: string;
	};
	microformat?: { playerMicroformatRenderer?: { uploadDate?: string } };
	captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

interface CaptionResponse {
	events?: { segs?: { utf8?: string }[] }[];
}

async function loadJson<T>(url: string, options: LoadPageOptions): Promise<T | null> {
	try {
		const page = await loadPage(url, options);
		return page.ok ? tryParseJson<T>(page.content) : null;
	} catch {
		return null;
	}
}

/**
 * Handle YouTube URLs - fetch metadata and transcript
 */
export const handleYouTube: SpecialHandler = async (
	url: string,
	timeout: number,
	userSignal?: AbortSignal,
	storage?: AgentStorageApi | null,
	_modelRegistry?: ModelRegistry,
	sessionSettings?: Settings,
): Promise<RenderResult | null> => {
	throwIfAborted(userSignal);
	const yt = parseYouTubeUrl(url);
	if (!yt) return null;

	const signal = ptree.combineSignals(userSignal, timeout * 1000);
	const fetchedAt = new Date().toISOString();
	const notes: string[] = [];
	const videoUrl = `https://www.youtube.com/watch?v=${yt.videoId}`;

	// Prefer Parallel extract when it sits in the reader chain and creds exist
	const fetchPreference = cfgProvidersFetch.get(handlerSettings(sessionSettings));
	if ((fetchPreference === "auto" || fetchPreference === "parallel") && findParallelApiKey(storage)) {
		try {
			const parallelResult = await extractWithParallel(
				[videoUrl],
				{
					objective: "Extract the main content of this YouTube video page",
					excerpts: true,
					fullContent: false,
					signal,
				},
				storage,
			);
			const firstDocument = parallelResult.results[0];
			if (firstDocument) {
				const content = getParallelExtractContent(firstDocument);
				if (content.trim().length > 100) {
					return buildResult(content, {
						url,
						finalUrl: videoUrl,
						method: "parallel",
						fetchedAt,
						notes: ["Used Parallel extract for YouTube"],
					});
				}
			}
		} catch {
			throwIfAborted(signal);
		}
	}

	const playerUrl = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
	const player = (clientName: string, clientVersion: string, userAgent: string) =>
		loadJson<PlayerResponse>(playerUrl, {
			signal,
			method: "POST",
			headers: { "Content-Type": "application/json", "User-Agent": userAgent },
			body: JSON.stringify({ context: { client: { clientName, clientVersion, hl: "en" } }, videoId: yt.videoId }),
		});
	// The Android player supplies usable timed-text URLs; the web player supplies the upload date.
	const web = player("WEB", "2.20251120.01.00", "Mozilla/5.0");
	const android = await player(
		"ANDROID",
		"20.10.38",
		"com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
	);
	const tracks = android?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
	let transcript = "";
	let transcriptSource = "";
	for (const automatic of [false, true]) {
		for (const track of tracks) {
			if (!/^en(?:-|$)/i.test(track.languageCode) || (track.kind === "asr") !== automatic) continue;
			if (signal?.aborted) break;
			const captionUrl = URL.parse(track.baseUrl);
			if (captionUrl?.origin !== "https://www.youtube.com" || captionUrl.pathname !== "/api/timedtext") continue;
			captionUrl.searchParams.set("fmt", "json3");
			const captions = await loadJson<CaptionResponse>(captionUrl.href, { signal });
			const lines: string[] = [];
			for (const event of captions?.events ?? []) {
				const line = event.segs
					?.map(segment => segment.utf8 ?? "")
					.join("")
					.replace(/\s+/g, " ")
					.trim();
				if (line && line !== lines.at(-1)) lines.push(line);
			}
			if (lines.length === 0) continue;
			transcript = lines.join(" ");
			transcriptSource = automatic ? "auto-generated" : "manual";
			notes.push(automatic ? "Using auto-generated captions" : "Using manual subtitles");
			break;
		}
		if (transcript) break;
	}
	const webPlayer = await web;
	throwIfAborted(userSignal);
	const details = android?.videoDetails ?? webPlayer?.videoDetails;
	if (!details?.title) return null;
	const { title, author: channel, shortDescription: description } = details;
	const duration = Number(details.lengthSeconds);
	const viewCount = Number(details.viewCount);
	const formattedDate = formatIsoDate(webPlayer?.microformat?.playerMicroformatRenderer?.uploadDate);

	// Only a user-initiated abort is fatal; the per-fetch time budget expiring
	// just means partial metadata/transcript, which we surface as a note.
	if (signal?.aborted) {
		notes.push("Fetch time budget exhausted; metadata/transcript may be incomplete");
	}

	// Build markdown output
	let md = `# ${title}\n\n`;
	if (channel) md += `**Channel:** ${channel}\n`;
	if (formattedDate) md += `**Uploaded:** ${formattedDate}\n`;
	if (duration > 0) md += `**Duration:** ${formatMediaDuration(duration)}\n`;
	if (viewCount > 0) md += `**Views:** ${formatNumber(viewCount)}\n`;
	md += `**Video ID:** ${yt.videoId}\n\n`;

	if (description) {
		// Truncate long descriptions
		const descPreview = description.length > 1000 ? `${description.slice(0, 1000)}…` : description;
		md += `---\n\n## Description\n\n${descPreview}\n\n`;
	}

	if (transcript) {
		md += `---\n\n## Transcript (${transcriptSource})\n\n${transcript}\n`;
	} else {
		notes.push("No subtitles/captions available");
		md += `---\n\n*No transcript available for this video.*\n`;
	}

	return buildResult(md, { url, finalUrl: videoUrl, method: "youtube", fetchedAt, notes });
};
