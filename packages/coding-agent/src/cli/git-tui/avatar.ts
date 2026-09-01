/**
 * Commit-author avatar loading for the git TUI.
 *
 * Resolution order: GitHub-noreply address → Gravatar (`d=404` so misses fall
 * through) → GitHub commits API when the repo has a github remote. Hits are
 * normalized to a 64px PNG via `Bun.Image` and cached in ~/.omp/cache/avatars;
 * definite misses leave a `.miss` marker so offline sessions stay quiet. When
 * no photo exists (or the terminal cannot draw images) the sidebar falls back
 * to {@link identiconLines}, a deterministic half-block identicon.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getAvatarCacheDir, logger } from "@oh-my-pi/pi-utils";

const AVATAR_PX = 64;
const FETCH_TIMEOUT_MS = 5_000;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

function md5Hex(text: string): string {
	return new Bun.CryptoHasher("md5").update(text).digest("hex");
}

/** Candidate avatar URLs for a GitHub-noreply email, or empty for other hosts. */
function noreplyUrls(email: string): string[] {
	const withId = email.match(/^(\d+)\+[^@]+@users\.noreply\.github\.com$/);
	if (withId) return [`https://avatars.githubusercontent.com/u/${withId[1]}?s=${AVATAR_PX * 2}`];
	const plain = email.match(/^([^@+]+)@users\.noreply\.github\.com$/);
	if (plain) return [`https://avatars.githubusercontent.com/${plain[1]}?s=${AVATAR_PX * 2}`];
	return [];
}

async function fetchBytes(url: string, headers?: Record<string, string>): Promise<Uint8Array | null> {
	try {
		const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!response.ok) return null;
		return new Uint8Array(await response.arrayBuffer());
	} catch {
		return null;
	}
}

/** Look up the author's avatar through the GitHub commits API of the `origin` remote. */
async function githubApiAvatarUrl(cwd: string, email: string): Promise<string | null> {
	const remoteUrl = await vcs.git(cwd)?.remoteUrl("origin");
	const match = remoteUrl?.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (!match) return null;
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "oh-my-pi" };
	if (token) headers.Authorization = `Bearer ${token}`;
	try {
		const response = await fetch(
			`https://api.github.com/repos/${match[1]}/${match[2]}/commits?per_page=1&author=${encodeURIComponent(email)}`,
			{ headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
		);
		if (!response.ok) return null;
		const commits = (await response.json()) as { author?: { avatar_url?: string } }[];
		const avatarUrl = commits[0]?.author?.avatar_url;
		return avatarUrl ? `${avatarUrl}${avatarUrl.includes("?") ? "&" : "?"}s=${AVATAR_PX * 2}` : null;
	} catch {
		return null;
	}
}

/**
 * Async avatar cache keyed by author email. `get()` never blocks: it returns
 * the cached PNG (base64), `null` for a known miss, or `undefined` while a
 * background load is in flight (the loader re-renders via `onReady`).
 */
export class AvatarLoader {
	readonly #dir = getAvatarCacheDir();
	readonly #memory = new Map<string, string | null>();
	readonly #pending = new Set<string>();
	readonly #onReady: () => void;

	constructor(onReady: () => void) {
		this.#onReady = onReady;
	}

	/** Base64 PNG, `null` on definite miss, `undefined` while loading. */
	get(email: string, cwd: string): string | null | undefined {
		const key = md5Hex(email.trim().toLowerCase());
		const cached = this.#memory.get(key);
		if (cached !== undefined) return cached;
		if (!this.#pending.has(key)) {
			this.#pending.add(key);
			void this.#load(key, email.trim().toLowerCase(), cwd).finally(() => {
				this.#pending.delete(key);
				this.#onReady();
			});
		}
		return undefined;
	}

	async #load(key: string, email: string, cwd: string): Promise<void> {
		const pngPath = path.join(this.#dir, `${key}.png`);
		const missPath = path.join(this.#dir, `${key}.miss`);
		try {
			const bytes = await Bun.file(pngPath).bytes();
			this.#memory.set(key, Buffer.from(bytes).toBase64());
			return;
		} catch {
			// Not cached on disk; fall through to the network.
		}
		try {
			const stat = await fs.stat(missPath);
			if (Date.now() - stat.mtimeMs < NEGATIVE_TTL_MS) {
				this.#memory.set(key, null);
				return;
			}
		} catch {
			// No miss marker.
		}

		const urls = [...noreplyUrls(email), `https://www.gravatar.com/avatar/${key}.png?d=404&s=${AVATAR_PX * 2}`];
		let bytes: Uint8Array | null = null;
		for (const url of urls) {
			bytes = await fetchBytes(url);
			if (bytes) break;
		}
		if (!bytes) {
			const apiUrl = await githubApiAvatarUrl(cwd, email);
			if (apiUrl) bytes = await fetchBytes(apiUrl);
		}
		if (!bytes) {
			this.#memory.set(key, null);
			await Bun.write(missPath, "").catch(() => {});
			return;
		}
		try {
			const png = await new Bun.Image(bytes).resize(AVATAR_PX, AVATAR_PX).png().toBuffer();
			await Bun.write(pngPath, png);
			this.#memory.set(key, png.toBase64());
		} catch (err) {
			logger.debug("avatar normalize failed", { error: err instanceof Error ? err.message : String(err) });
			this.#memory.set(key, null);
		}
	}
}

/**
 * Deterministic 5x5 mirrored identicon rendered as half-block rows (3 lines,
 * 10 columns). Used while an avatar loads and when none exists.
 */
export function identiconLines(email: string, colorize: (hex: string, text: string) => string): string[] {
	const bytes = new Bun.CryptoHasher("md5").update(email.trim().toLowerCase()).digest();
	const hue = ((bytes[0] << 8) | bytes[1]) % 360;
	const hex = hslToHex(hue, 0.55, 0.58);
	const on = (x: number, y: number): boolean => {
		const column = x < 3 ? x : 4 - x;
		return bytes[3 + column * 5 + y] % 2 === 0;
	};
	const lines: string[] = [];
	for (let row = 0; row < 3; row++) {
		let line = "";
		for (let x = 0; x < 5; x++) {
			const top = on(x, row * 2);
			const bottom = row * 2 + 1 < 5 && on(x, row * 2 + 1);
			const cell = top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
			line += cell.repeat(2);
		}
		lines.push(colorize(hex, line));
	}
	return lines;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
	const base = lightness - chroma / 2;
	const sector = Math.floor(hue / 60) % 6;
	const rgb = [
		[chroma, second, 0],
		[second, chroma, 0],
		[0, chroma, second],
		[0, second, chroma],
		[second, 0, chroma],
		[chroma, 0, second],
	][sector];
	return `#${rgb
		.map(channel =>
			Math.round((channel + base) * 255)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}
