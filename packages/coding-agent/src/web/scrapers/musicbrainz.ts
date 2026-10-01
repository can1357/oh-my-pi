/**
 * MusicBrainz URL handler for artists, releases, and recordings
 */

import { tryParseJson, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatMediaDuration, loadPage } from "./types";

type MusicBrainzEntity = "artist" | "release" | "recording";

interface MusicBrainzLifeSpan {
	begin?: string;
	end?: string;
	ended?: boolean;
}

interface MusicBrainzArtist {
	id: string;
	name: string;
	type?: string;
	country?: string;
	"life-span"?: MusicBrainzLifeSpan;
}

interface MusicBrainzArtistCredit {
	name?: string;
	artist?: {
		id?: string;
		name: string;
	};
}

interface MusicBrainzRecording {
	id: string;
	title: string;
	length?: number;
	"artist-credit"?: MusicBrainzArtistCredit[];
}

interface MusicBrainzTrack {
	id?: string;
	title?: string;
	number?: string;
	position?: number;
	length?: number;
	recording?: {
		title?: string;
		length?: number;
	};
}

interface MusicBrainzMedium {
	position?: number;
	format?: string;
	"track-count"?: number;
	tracks?: MusicBrainzTrack[];
}

interface MusicBrainzRelease {
	id: string;
	title: string;
	"track-count"?: number;
	media?: MusicBrainzMedium[];
}

const MUSICBRAINZ_HOSTS = new Set(["musicbrainz.org", "www.musicbrainz.org"]);
const MAX_TRACKS = 50;

function parseEntity(url: URL): { entity: MusicBrainzEntity; mbid: string } | null {
	if (!MUSICBRAINZ_HOSTS.has(url.hostname)) return null;

	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 2) return null;

	const entity = parts[0] as MusicBrainzEntity;
	if (entity !== "artist" && entity !== "release" && entity !== "recording") return null;

	const mbid = parts[1];
	if (!/^[0-9a-fA-F-]{36}$/.test(mbid)) return null;

	return { entity, mbid };
}

async function fetchJson<T>(apiUrl: string, timeout: number, signal?: AbortSignal): Promise<T | null> {
	const result = await loadPage(apiUrl, {
		timeout,
		signal,
		headers: {
			"User-Agent": USER_AGENT,
			Accept: "application/json",
		},
	});

	if (!result.ok) return null;

	return tryParseJson<T>(result.content);
}

function formatLifeSpan(life: MusicBrainzLifeSpan | undefined): string | null {
	if (!life) return null;

	const begin = life.begin?.trim();
	const end = life.end?.trim();

	if (begin && end) return `${begin} - ${end}`;
	if (begin && !end) return `${begin} - ${life.ended ? "ended" : "present"}`;
	if (!begin && end) return `? - ${end}`;
	if (life.ended !== undefined) return life.ended ? "ended" : "present";

	return null;
}

function formatDurationMs(lengthMs: number | undefined): string | null {
	if (!lengthMs || lengthMs <= 0) return null;
	return formatMediaDuration(Math.round(lengthMs / 1000));
}

function formatArtistCredits(credits: MusicBrainzArtistCredit[] | undefined): string | null {
	if (!credits?.length) return null;

	const names = credits
		.map(credit => credit.name || credit.artist?.name)
		.filter((name): name is string => Boolean(name));

	if (!names.length) return null;
	return names.join(", ");
}

function formatTrack(track: MusicBrainzTrack): string {
	const title = track.title || track.recording?.title || "Untitled";
	const duration = formatDurationMs(track.length ?? track.recording?.length);
	const number = track.number || (track.position ? String(track.position) : null);

	const prefix = number ? `${number}. ` : "- ";
	let line = `${prefix}${title}`;
	if (duration) line += ` (${duration})`;
	return line;
}

function buildMediumLabel(medium: MusicBrainzMedium, includePosition: boolean): string | null {
	const parts: string[] = [];
	if (includePosition && medium.position) parts.push(`Disc ${medium.position}`);
	if (medium.format) parts.push(medium.format);
	return parts.length ? parts.join(" - ") : null;
}

function buildArtistMarkdown(artist: MusicBrainzArtist): string {
	let md = `# ${artist.name}\n\n`;
	const meta: string[] = [];

	if (artist.type) meta.push(`**Type**: ${artist.type}`);
	if (artist.country) meta.push(`**Country**: ${artist.country}`);

	const lifeSpan = formatLifeSpan(artist["life-span"]);
	if (lifeSpan) meta.push(`**Life Span**: ${lifeSpan}`);

	if (meta.length) md += `${meta.join("\n")}\n`;

	return md;
}

function buildReleaseMarkdown(release: MusicBrainzRelease): string {
	let md = `# ${release.title}\n\n`;

	const media = release.media ?? [];
	const totalTracks =
		release["track-count"] ??
		media.reduce((sum, medium) => sum + (medium["track-count"] ?? medium.tracks?.length ?? 0), 0);

	if (totalTracks) {
		md += `**Tracks**: ${totalTracks}\n\n`;
	}

	if (media.length) {
		md += "## Tracks\n\n";
		const includePosition = media.length > 1;

		for (const medium of media) {
			const label = buildMediumLabel(medium, includePosition);
			if (label) md += `### ${label}\n\n`;

			const tracks = medium.tracks ?? [];
			if (tracks.length) {
				const lines = tracks.slice(0, MAX_TRACKS).map(formatTrack).join("\n");
				md += `${lines}\n\n`;

				if (tracks.length > MAX_TRACKS) {
					md += `_Showing first ${MAX_TRACKS} of ${tracks.length} tracks._\n\n`;
				}
			} else if (medium["track-count"]) {
				md += `- ${medium["track-count"]} tracks (details unavailable)\n\n`;
			}
		}
	}

	return md;
}

function buildRecordingMarkdown(recording: MusicBrainzRecording): string {
	let md = `# ${recording.title}\n\n`;
	const meta: string[] = [];

	const artists = formatArtistCredits(recording["artist-credit"]);
	if (artists) meta.push(`**Artists**: ${artists}`);

	const length = formatDurationMs(recording.length);
	if (length) meta.push(`**Length**: ${length}`);

	if (meta.length) md += `${meta.join("\n")}\n`;

	return md;
}

export const handleMusicBrainz: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		const parsedEntity = parseEntity(parsed);
		if (!parsedEntity) return null;

		const { entity, mbid } = parsedEntity;
		const fetchedAt = new Date().toISOString();
		let md = "";

		if (entity === "artist") {
			const apiUrl = `https://musicbrainz.org/ws/2/artist/${mbid}?fmt=json&inc=url-rels`;
			const artist = await fetchJson<MusicBrainzArtist>(apiUrl, timeout, signal);
			if (!artist) return null;
			md = buildArtistMarkdown(artist);
		} else if (entity === "release") {
			const apiUrl = `https://musicbrainz.org/ws/2/release/${mbid}?fmt=json&inc=recordings`;
			const release = await fetchJson<MusicBrainzRelease>(apiUrl, timeout, signal);
			if (!release) return null;
			md = buildReleaseMarkdown(release);
		} else {
			const apiUrl = `https://musicbrainz.org/ws/2/recording/${mbid}?fmt=json`;
			const recording = await fetchJson<MusicBrainzRecording>(apiUrl, timeout, signal);
			if (!recording) return null;
			md = buildRecordingMarkdown(recording);
		}

		return buildResult(md, { url, method: "musicbrainz-api", fetchedAt, notes: ["Fetched via MusicBrainz API"] });
	} catch {}

	return null;
};
