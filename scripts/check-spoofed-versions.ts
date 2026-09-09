#!/usr/bin/env bun

/**
 * Checks spoofed external tool versions against their latest GitHub releases.
 *
 * We impersonate several external tools (Gemini CLI, Antigravity) via User-Agent
 * strings. When these tools release new versions, the upstream service may start
 * rejecting or deprioritizing older versions. This script detects drift so we
 * can bump before users hit 403s/429s.
 *
 * Usage:
 *   bun scripts/check-spoofed-versions.ts          # check and report
 *   bun scripts/check-spoofed-versions.ts --update  # update source in-place
 */

import * as path from "node:path";
import { USER_AGENT } from "@oh-my-pi/pi-utils";

const PROVIDER_FILE = path.join(import.meta.dir, "../packages/catalog/src/wire/gemini-headers.ts");

interface VersionCheck {
	/** Human label for the report. */
	name: string;
	/** Regex to extract the current hardcoded version from PROVIDER_FILE. */
	sourcePattern: RegExp;
	/** GitHub owner/repo to fetch latest release from. */
	repo: string;
	/** Extract semver from the release tag name (e.g. "v0.35.3" -> "0.35.3"). */
	parseTag: (tag: string) => string | null;
}

/** Fetch latest non-prerelease tag from a GitHub repo. */
async function fetchLatestGitHubRelease(
	repo: string,
	parseTag: (tag: string) => string | null,
): Promise<string | null> {
	try {
		// /releases/latest only returns non-prerelease, non-draft releases
		const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { tag_name?: string };
		return data.tag_name ? parseTag(data.tag_name) : null;
	} catch {
		return null;
	}
}

const SEMVER_RE = /(\d+\.\d+\.\d+)/;

const checks: VersionCheck[] = [
	{
		name: "Gemini CLI",
		sourcePattern: /PI_AI_GEMINI_CLI_VERSION\s*\|\|\s*"(\d+\.\d+\.\d+)"/,
		repo: "google-gemini/gemini-cli",
		parseTag: tag => SEMVER_RE.exec(tag)?.[1] ?? null,
	},
];

async function run() {
	const doUpdate = process.argv.includes("--update");
	let source = await Bun.file(PROVIDER_FILE).text();
	let anyDrift = false;
	let anyUpdate = false;
	let anyChecked = false;

	for (const check of checks) {
		const match = check.sourcePattern.exec(source);
		if (!match?.[1]) {
			console.error(`[WARN] Could not extract current ${check.name} version from source`);
			continue;
		}

		const current = match[1];
		const latest = await fetchLatestGitHubRelease(check.repo, check.parseTag);

		if (!latest) {
			console.error(`[FAIL] Could not fetch latest ${check.name} version from ${check.repo}`);
			continue;
		}

		anyChecked = true;

		if (current === latest) {
			console.log(`[OK]   ${check.name}: ${current} (up to date)`);
		} else {
			console.log(`[DRIFT] ${check.name}: ${current} -> ${latest}`);
			anyDrift = true;

			if (doUpdate) {
				source = source.replace(match[0], match[0].replace(current, latest));
				anyUpdate = true;
				console.log(`       Updated in source.`);
			}
		}
	}

	if (anyUpdate) {
		await Bun.write(PROVIDER_FILE, source);
		console.log(`\nWrote updates to ${path.relative(process.cwd(), PROVIDER_FILE)}`);
	}

	if (!anyChecked) {
		console.error("\nNo version checks succeeded. Cannot verify freshness.");
		process.exit(1);
	}

	if (anyDrift && !doUpdate) {
		console.log("\nRun with --update to apply version bumps.");
		process.exit(1);
	}
}

run();
