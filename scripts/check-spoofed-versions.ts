#!/usr/bin/env bun

/**
 * Checks spoofed external tool versions against their latest upstream releases.
 *
 * We impersonate several external tools (Gemini CLI, Claude Code) via User-Agent
 * strings. When these tools release new versions, the upstream service may start
 * rejecting or deprioritizing older versions. This script detects drift so we
 * can bump the pinned fallbacks before users hit 400s/403s/429s.
 *
 * Usage:
 *   bun scripts/check-spoofed-versions.ts          # check and report
 *   bun scripts/check-spoofed-versions.ts --update  # update source in-place
 */

import * as path from "node:path";
import { USER_AGENT } from "@oh-my-pi/pi-utils";

const REPO_ROOT = path.join(import.meta.dir, "..");
const SEMVER_RE = /(\d+\.\d+\.\d+)/;

interface VersionCheck {
	/** Human label for the report. */
	name: string;
	/** Repo-relative source file holding the pinned version. */
	file: string;
	/** Regex whose first group captures the pinned version in `file`. */
	sourcePattern: RegExp;
	/** Resolves the latest released version, or null when upstream is unreachable. */
	fetchLatest: () => Promise<string | null>;
}

/** Fetch the latest non-prerelease tag from a GitHub repo, reduced to semver. */
async function fetchLatestGitHubRelease(repo: string): Promise<string | null> {
	try {
		// /releases/latest only returns non-prerelease, non-draft releases
		const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { tag_name?: string };
		return data.tag_name ? (SEMVER_RE.exec(data.tag_name)?.[1] ?? null) : null;
	} catch {
		return null;
	}
}

/** Fetch the `latest` dist-tag version of an npm package. */
async function fetchLatestNpmVersion(pkg: string): Promise<string | null> {
	try {
		const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
			headers: { Accept: "application/json", "User-Agent": USER_AGENT },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: string };
		return data.version ? (SEMVER_RE.exec(data.version)?.[1] ?? null) : null;
	} catch {
		return null;
	}
}

const checks: VersionCheck[] = [
	{
		name: "Gemini CLI",
		file: "packages/catalog/src/wire/gemini-headers.ts",
		sourcePattern: /PI_AI_GEMINI_CLI_VERSION\s*\|\|\s*"(\d+\.\d+\.\d+)"/,
		fetchLatest: () => fetchLatestGitHubRelease("google-gemini/gemini-cli"),
	},
	{
		// `latest`, not `stable`: Anthropic gates new models on the newest release.
		name: "Claude Code",
		file: "packages/ai/src/providers/claude-code-fingerprint.ts",
		sourcePattern: /DEFAULT_CLAUDE_CODE_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/,
		fetchLatest: () => fetchLatestNpmVersion("@anthropic-ai/claude-code"),
	},
];

async function run() {
	const doUpdate = process.argv.includes("--update");
	let anyDrift = false;
	let anyChecked = false;

	for (const check of checks) {
		const file = path.join(REPO_ROOT, check.file);
		const source = await Bun.file(file).text();
		const match = check.sourcePattern.exec(source);
		if (!match?.[1]) {
			console.error(`[WARN] Could not extract current ${check.name} version from ${check.file}`);
			continue;
		}

		const current = match[1];
		const latest = await check.fetchLatest();
		if (!latest) {
			console.error(`[FAIL] Could not fetch latest ${check.name} version`);
			continue;
		}

		anyChecked = true;
		if (current === latest) {
			console.log(`[OK]   ${check.name}: ${current} (up to date)`);
			continue;
		}

		console.log(`[DRIFT] ${check.name}: ${current} -> ${latest}`);
		anyDrift = true;
		if (doUpdate) {
			await Bun.write(file, source.replace(match[0], match[0].replace(current, latest)));
			console.log(`       Updated ${check.file}`);
		}
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
