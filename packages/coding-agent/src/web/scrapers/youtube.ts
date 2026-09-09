import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree, Snowflake } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import type { AgentStorage } from "../../session/agent-storage";
import { throwIfAborted } from "../../tools/tool-errors";
import { ensureTool } from "../../utils/tools-manager";
import { extractWithParallel, findParallelApiKey, getParallelExtractContent } from "../parallel";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatMediaDuration, formatNumber } from "./types";

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

/**
 * Clean VTT subtitle content to plain text
 */
function cleanVttToText(vtt: string): string {
	const lines = vtt.split("\n");
	const textLines: string[] = [];
	let lastLine = "";

	for (const line of lines) {
		// Skip WEBVTT header, timestamps, and metadata
		if (
			line.startsWith("WEBVTT") ||
			line.startsWith("Kind:") ||
			line.startsWith("Language:") ||
			line.match(/^\d{2}:\d{2}/) || // Timestamp lines
			line.match(/^[a-f0-9-]{36}$/) || // UUID cue identifiers
			line.match(/^\d+$/) || // Numeric cue identifiers
			line.includes("-->") ||
			line.trim() === ""
		) {
			continue;
		}

		// Remove inline timestamp tags like <00:00:01.520>
		let cleaned = line.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "");
		// Remove other VTT tags like <c> </c>
		cleaned = cleaned.replace(/<\/?[^>]+>/g, "");
		cleaned = cleaned.trim();

		// Skip duplicates (auto-generated captions often repeat)
		if (cleaned && cleaned !== lastLine) {
			textLines.push(cleaned);
			lastLine = cleaned;
		}
	}

	return textLines.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Handle YouTube URLs - fetch metadata and transcript
 */
export const handleYouTube: SpecialHandler = async (
	url: string,
	timeout: number,
	userSignal?: AbortSignal,
	storage?: AgentStorage | null,
): Promise<RenderResult | null> => {
	throwIfAborted(userSignal);
	const yt = parseYouTubeUrl(url);
	if (!yt) return null;

	const signal = ptree.combineSignals(userSignal, timeout * 1000);
	const fetchedAt = new Date().toISOString();
	const notes: string[] = [];
	const videoUrl = `https://www.youtube.com/watch?v=${yt.videoId}`;

	// Prefer Parallel extract when it sits in the reader chain and creds exist
	const fetchPreference = settings.get("providers.fetch");
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

	// Ensure yt-dlp is available (auto-download if missing)
	const ytdlp = await ensureTool("yt-dlp", { signal, silent: true });
	if (!ytdlp) {
		return {
			url,
			finalUrl: url,
			contentType: "text/plain",
			method: "youtube-no-ytdlp",
			content: "YouTube video detected but yt-dlp could not be installed.",
			fetchedAt: new Date().toISOString(),
			truncated: false,
			notes: ["yt-dlp installation failed"],
		};
	}

	const execOptions = {
		mode: "group" as const,
		signal,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full" as const,
	};

	// Fetch video metadata
	const metaResult = await ptree.exec(
		[ytdlp, "--dump-json", "--no-warnings", "--no-playlist", "--skip-download", videoUrl],
		execOptions,
	);

	let title = "YouTube Video";
	let channel = "";
	let description = "";
	let duration = 0;
	let uploadDate = "";
	let viewCount = 0;

	if (metaResult.ok && metaResult.stdout.trim()) {
		try {
			const meta = JSON.parse(metaResult.stdout) as {
				title?: string;
				channel?: string;
				uploader?: string;
				description?: string;
				duration?: number;
				upload_date?: string;
				view_count?: number;
			};
			title = meta.title || title;
			channel = meta.channel || meta.uploader || "";
			description = meta.description || "";
			duration = meta.duration || 0;
			uploadDate = meta.upload_date || "";
			viewCount = meta.view_count || 0;
		} catch {}
	}

	// Format upload date
	let formattedDate = "";
	if (uploadDate && uploadDate.length === 8) {
		formattedDate = `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
	}

	// Try to fetch subtitles
	let transcript = "";
	let transcriptSource = "";

	// First, list available subtitles
	const listResult = await ptree.exec(
		[ytdlp, "--list-subs", "--no-warnings", "--no-playlist", "--skip-download", videoUrl],
		execOptions,
	);

	const hasManualSubs = listResult.stdout.includes("[info] Available subtitles");
	const hasAutoSubs = listResult.stdout.includes("[info] Available automatic captions");

	// Create temp directory for subtitle download
	const tmpDir = os.tmpdir();
	const tmpBase = path.join(tmpDir, `yt-${yt.videoId}-${Snowflake.next()}`);

	try {
		// Try manual subtitles first (English preferred)
		if (hasManualSubs) {
			const subResult = await ptree.exec(
				[
					ytdlp,
					"--write-sub",
					"--sub-lang",
					"en,en-US,en-GB",
					"--sub-format",
					"vtt",
					"--skip-download",
					"--no-warnings",
					"--no-playlist",
					"-o",
					tmpBase,
					videoUrl,
				],
				execOptions,
			);

			if (subResult.ok) {
				// Find the downloaded subtitle file using glob
				const subFiles = await Array.fromAsync(new Bun.Glob(`${tmpBase}*.vtt`).scan({ absolute: true }));
				if (subFiles.length > 0) {
					const vttContent = await Bun.file(subFiles[0]).text();
					transcript = cleanVttToText(vttContent);
					transcriptSource = "manual";
					notes.push("Using manual subtitles");
				}
			}
		}

		// Fall back to auto-generated captions
		if (!transcript && hasAutoSubs) {
			const autoResult = await ptree.exec(
				[
					ytdlp,
					"--write-auto-sub",
					"--sub-lang",
					"en,en-US,en-GB",
					"--sub-format",
					"vtt",
					"--skip-download",
					"--no-warnings",
					"--no-playlist",
					"-o",
					tmpBase,
					videoUrl,
				],
				execOptions,
			);

			if (autoResult.ok) {
				const subFiles = await Array.fromAsync(new Bun.Glob(`${tmpBase}*.vtt`).scan({ absolute: true }));
				if (subFiles.length > 0) {
					const vttContent = await Bun.file(subFiles[0]).text();
					transcript = cleanVttToText(vttContent);
					transcriptSource = "auto-generated";
					notes.push("Using auto-generated captions");
				}
			}
		}
	} finally {
		// Cleanup temp files (fire-and-forget with error suppression)
		Array.fromAsync(new Bun.Glob(`${tmpBase}*`).scan({ absolute: true }))
			.then(tmpFiles => Promise.all(tmpFiles.map(f => fs.unlink(f).catch(() => {}))))
			.catch(() => {});
	}
	// Only a user-initiated abort is fatal; the per-fetch time budget expiring
	// just means partial metadata/transcript, which we surface as a note.
	throwIfAborted(userSignal);
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
