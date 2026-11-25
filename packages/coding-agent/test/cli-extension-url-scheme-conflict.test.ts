/**
 * Contract: two extensions the CLI loads that register one URL scheme reach the CLI's own
 * extension-load error path — a startup warning in print mode, and a fatal error before any
 * session is built under `--trusted-extension` — not only the SDK's returned load result.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { setInteractiveHost, TempDir } from "@oh-my-pi/pi-utils";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

/** An extension module registering the read-only scheme `demo://`, answering with `label`. */
function schemeExtension(label: string): string {
	return `export default function (pi) {
	pi.registerUrlScheme({
		scheme: "demo",
		spec: { backing: "remote", selectors: "none", immutable: true },
		resolve: async url => ({ url: url.href, content: ${JSON.stringify(label)}, contentType: "text/plain" }),
	});
}
`;
}

/** Run the root command in print mode with `extensionArgs`; report stderr, the throw, and whether a session was built. */
async function launchPrint(
	dir: string,
	extensionArgs: string[],
): Promise<{ stderr: string; thrown: unknown; sessionBuilt: boolean }> {
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	const rawArgs = [...extensionArgs, "--no-session", "-p", "hello"];
	const parsed = parseArgs(rawArgs);
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noLsp = true;
	let stderr = "";
	let sessionBuilt = false;
	const previousHost = setInteractiveHost(false);
	// A terminal on stdin, so print mode does not wait for piped input.
	const originalIsTTY = process.stdin.isTTY;
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ProcessExitSignal(code ?? 0);
	}) as typeof process.exit);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		stderr += String(chunk);
		return true;
	});
	try {
		await runRootCommand(parsed, rawArgs, {
			settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
			discoverAuthStorage: async () => authStorage,
			createAgentSession: async () => {
				sessionBuilt = true;
				throw new Error("session constructed");
			},
		});
		return { stderr, thrown: undefined, sessionBuilt };
	} catch (error) {
		return { stderr, thrown: error, sessionBuilt };
	} finally {
		vi.restoreAllMocks();
		Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		setInteractiveHost(previousHost);
		authStorage.close();
	}
}

// `runRootCommand` registers the CLI's extension roots process-wide.
afterEach(() => {
	clearOmpExtensionCliRoots();
});

describe("CLI extension URL scheme conflicts", () => {
	it("warns at print-mode startup that the later extension's scheme is not used", async () => {
		using dir = TempDir.createSync("@omp-cli-url-scheme-warn-");
		const first = dir.join("first.ts");
		const second = dir.join("second.ts");
		await Bun.write(first, schemeExtension("first"));
		await Bun.write(second, schemeExtension("second"));

		const { stderr } = await launchPrint(dir.path(), ["--no-extensions", "-e", first, "-e", second]);

		const warnings = stderr.split("\n").filter(line => line.includes("demo:// is already registered"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Failed to load extension");
		expect(warnings[0]).toContain("second.ts");
		expect(warnings[0]).toContain("first.ts");
	}, 30_000);

	it("fails a --trusted-extension launch before building a session", async () => {
		using dir = TempDir.createSync("@omp-cli-url-scheme-trusted-");
		const first = dir.join("first.ts");
		const second = dir.join("second.ts");
		await Bun.write(first, schemeExtension("first"));
		await Bun.write(second, schemeExtension("second"));

		const { thrown, sessionBuilt } = await launchPrint(dir.path(), [
			"--trusted-extension",
			first,
			"--trusted-extension",
			second,
		]);

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toMatch(
			/^Trusted extension failed to load: URL scheme demo:\/\/ is already registered/,
		);
		expect(sessionBuilt).toBe(false);
	}, 30_000);
});
