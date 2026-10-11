#!/usr/bin/env bun
//
// Render the Homebrew formula for `omp` from a build published on the build
// service (build.stencil.so) and write it to a tap checkout. Each formula
// target points at the build's immutable download URL
// (`/d/omp/<build-id>/<file>`) with the sha256 the service recorded at upload,
// so the formula never drifts from the shipped binaries. Fails when the
// version is not published for every formula target.
//
// Usage:
//   bun scripts/ci-update-brew-formula.ts <tag> --out <path/to/Formula/omp.rb>
//   bun scripts/ci-update-brew-formula.ts v18.8.9        # prints to stdout
//
// Environment:
//   BUILD_URL   service origin (default https://build.stencil.so)

const PRODUCT = "omp";
const SERVICE_URL = (process.env.BUILD_URL ?? "https://build.stencil.so").replace(/\/+$/, "");
const HOMEPAGE = "https://omp.sh";
const DESC = "Coding agent with the IDE wired in";

/** Build-service target of each formula stanza. */
const FORMULA_TARGETS = {
	macosArm: "macos-arm64",
	macosIntel: "macos-x86_64",
	linuxArm: "linux-arm64",
	linuxIntel: "linux-x86_64",
} as const;

type FormulaTarget = keyof typeof FORMULA_TARGETS;

/** A formula `url` stanza: where Homebrew downloads the binary and its sha256. */
export interface FormulaFile {
	url: string;
	sha256: string;
}

/** The fields of a build-service version answer the formula needs. */
interface VersionAnswer {
	build: { id: string };
	file: { name: string; sha256: string };
}

function parseArgs(argv: readonly string[]): {
	tag: string;
	out: string | null;
} {
	const rest = [...argv];
	let out: string | null = null;
	const outIdx = rest.indexOf("--out");
	if (outIdx >= 0) {
		out = rest[outIdx + 1] ?? null;
		if (!out) throw new Error("--out requires a path");
		rest.splice(outIdx, 2);
	}
	const tag = rest.find(a => !a.startsWith("--"));
	if (!tag) throw new Error("usage: ci-update-brew-formula.ts <tag> [--out <file>]");
	return { tag, out };
}

/** The formula file for `target` of `version`; throws when the service has not published it. */
async function resolveFile(version: string, target: string): Promise<FormulaFile> {
	const url = `${SERVICE_URL}/api/products/${PRODUCT}/versions/${encodeURIComponent(version)}/${target}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`${PRODUCT} ${version} is not published for ${target}: HTTP ${response.status} ${(await response.text()).trim()}`,
		);
	}
	const answer = (await response.json()) as VersionAnswer;
	if (!/^[0-9a-f]{64}$/.test(answer.file.sha256)) {
		throw new Error(`${url} answered no sha256 for ${answer.file.name}`);
	}
	return {
		url: `${SERVICE_URL}/d/${PRODUCT}/${encodeURIComponent(answer.build.id)}/${encodeURIComponent(answer.file.name)}`,
		sha256: answer.file.sha256,
	};
}

// `${...}` is JS interpolation; the literal `#{bin}` below is a Ruby
// interpolation Homebrew resolves when it evaluates the formula.
export function renderFormula(version: string, files: Record<FormulaTarget, FormulaFile>): string {
	// Each `url` carries `using: :nounzip` because the build files are bare
	// Mach-O/ELF executables, not archives. Without it Homebrew's default
	// CurlDownloadStrategy routes through UnpackStrategy::Uncompressed#extract_nestedly,
	// which nests the file outside the staging CWD; `Dir["omp-*"].first` then
	// returns `nil` and `bin.install nil => "omp"` raises.
	//
	// `with_env(HOME: buildpath)` redirects the CLI's `os.homedir()` lookup to
	// the writable staging dir so `generate_completions_from_executable` does
	// not touch the real `/Users/<user>/.omp` (denied by Homebrew's sandbox
	// profile, which would otherwise fail the popen).
	return `class Omp < Formula
  desc "${DESC}"
  homepage "${HOMEPAGE}"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${files.macosArm.url}",
          using: :nounzip
      sha256 "${files.macosArm.sha256}"
    end
    on_intel do
      url "${files.macosIntel.url}",
          using: :nounzip
      sha256 "${files.macosIntel.sha256}"
    end
  end

  on_linux do
    on_arm do
      url "${files.linuxArm.url}",
          using: :nounzip
      sha256 "${files.linuxArm.sha256}"
    end
    on_intel do
      url "${files.linuxIntel.url}",
          using: :nounzip
      sha256 "${files.linuxIntel.sha256}"
    end
  end

  def install
    bin.install Dir["omp-*"].first => "omp"
    (bin/"omp").chmod 0555
    with_env(HOME: buildpath) do
      generate_completions_from_executable(bin/"omp", "completions", shells: [:bash, :zsh, :fish])
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/omp --version")
  end
end
`;
}

async function main(): Promise<void> {
	const { tag, out } = parseArgs(process.argv.slice(2));
	const version = tag.replace(/^v/, "");

	const entries = await Promise.all(
		(Object.entries(FORMULA_TARGETS) as [FormulaTarget, string][]).map(
			async ([key, target]) => [key, await resolveFile(version, target)] as const,
		),
	);
	const formula = renderFormula(version, Object.fromEntries(entries) as Record<FormulaTarget, FormulaFile>);
	if (out) {
		await Bun.write(out, formula);
		console.log(`wrote ${out} for ${tag}`);
	} else {
		process.stdout.write(formula);
	}
}

if (import.meta.main) {
	await main();
}
