import { parseChangelog } from "../../src/utils/changelog";

const missingPackageChangelogPath = process.argv[2];
if (!missingPackageChangelogPath) {
	throw new Error("Expected a missing package changelog path argument");
}

const entries = await parseChangelog(missingPackageChangelogPath);
const latest = entries[0];
// The callers compare this output against a from-source run of the same probe,
// so the only local contract is "the bundled fallback asset parsed into a real
// release entry" — not that the latest entry matches the package version (a
// release may legally ship without coding-agent changelog content).
const version = latest ? `${latest.major}.${latest.minor}.${latest.patch}` : undefined;
if (version === undefined || !latest?.content.startsWith(`## [${version}]`)) {
	throw new Error(`Bundled changelog fallback did not parse a release entry: ${JSON.stringify({ version })}`);
}

process.stdout.write(JSON.stringify({ version, entries: entries.length }));
