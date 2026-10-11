import { describe, expect, it } from "bun:test";
import { renderFormula } from "./ci-update-brew-formula";

const BASE = "https://build.stencil.so/d/omp/20261010-171748-fa5ff4a";
const FILES = {
	macosArm: { url: `${BASE}/omp-darwin-arm64`, sha256: "darwin_arm64_sha" },
	macosIntel: { url: `${BASE}/omp-darwin-x64`, sha256: "darwin_x64_sha" },
	linuxArm: { url: `${BASE}/omp-linux-arm64`, sha256: "linux_arm64_sha" },
	linuxIntel: { url: `${BASE}/omp-linux-x64`, sha256: "linux_x64_sha" },
};

describe("renderFormula", () => {
	const formula = renderFormula("18.8.9", FILES);

	// Regression: bare-binary URLs must opt out of Homebrew's UnpackStrategy.
	// Without `using: :nounzip` the default CurlDownloadStrategy nests the file
	// outside the staging CWD, `Dir["omp-*"].first` returns `nil`, and
	// `bin.install nil => "omp"` raises (issue #2398).
	it("attaches `using: :nounzip` to every per-platform url stanza", () => {
		const matches = formula.match(/using: :nounzip/g) ?? [];
		expect(matches).toHaveLength(4);
		for (const key in FILES) {
			const file = FILES[key as keyof typeof FILES];
			expect(formula).toContain(`url "${file.url}",\n          using: :nounzip\n      sha256 "${file.sha256}"`);
		}
	});

	// Regression: completions generation must run with HOME redirected so the
	// popened binary doesn't touch the real `~/.omp` (denied by Homebrew's
	// sandbox profile) during the build (issue #2398).
	it("wraps `generate_completions_from_executable` with a HOME redirect to buildpath", () => {
		expect(formula).toMatch(
			/with_env\(HOME: buildpath\) do\n\s+generate_completions_from_executable\(bin\/"omp", "completions", shells: \[:bash, :zsh, :fish\]\)\n\s+end/,
		);
		// And the bare form (which is what failed in the sandbox) must not appear
		// outside the `with_env` block.
		const blockless = formula.replace(/with_env\(HOME: buildpath\) do[\s\S]*?end/, "");
		expect(blockless).not.toMatch(/generate_completions_from_executable/);
	});
});
