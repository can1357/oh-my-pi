import { afterEach, describe, expect, it, onTestFinished, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	resolveTmuxClientTerminalNames,
	tmuxClientRendersSixel,
	tmuxPaneAllowsPassthrough,
} from "@oh-my-pi/pi-tui/tmux";
import * as testRuntime from "@oh-my-pi/pi-utils/test-runtime";

/** A `tmux` client that answers each capability query the way a kitty-hosted tmux 3.4 with SIXEL does. */
const FAKE_TMUX = `#!/bin/sh
case "$*" in
	*client_termtype*) printf 'ghostty 1.2\\txterm-kitty\\n' ;;
	*client_name*) echo /dev/pts/7 ;;
	*show-messages*) echo '  1: Sxl: (flag) true' ;;
	*allow-passthrough*) echo on ;;
esac
`;

afterEach(() => {
	vi.restoreAllMocks();
});

// Each capability is cached, and a cache made while no `tmux` was on PATH must not outlive a PATH
// that holds one, as when a plugin's `bin` directory joins PATH mid-session.
describe.skipIf(process.platform === "win32")("tmux capabilities across PATH changes", () => {
	it.each([
		{
			capability: "the client's terminal names",
			query: (env: NodeJS.ProcessEnv) => resolveTmuxClientTerminalNames(env),
			without: [],
			with: ["ghostty", "kitty"],
		},
		{ capability: "SIXEL rendering", query: tmuxClientRendersSixel, without: false, with: true },
		{ capability: "pane passthrough", query: tmuxPaneAllowsPassthrough, without: false, with: true },
	])("queries $capability again once PATH holds a tmux", ({ capability, query, without, with: found }) => {
		// The terminal-name query is skipped outright under `bun test`; this test is its caller.
		vi.spyOn(testRuntime, "isBunTestRuntime").mockReturnValue(false);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tmux-path-"));
		onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
		const empty = path.join(root, "empty");
		const bin = path.join(root, "bin");
		fs.mkdirSync(empty);
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, "tmux"), FAKE_TMUX);
		fs.chmodSync(path.join(bin, "tmux"), 0o755);
		// A socket of its own per case, so no case reads another's cached answer.
		const env: NodeJS.ProcessEnv = { TMUX: `${root}/${capability},1,0`, TMUX_PANE: "%0", PATH: empty };

		expect(query(env)).toEqual(without);
		env.PATH = [bin, empty].join(path.delimiter);
		expect(query(env)).toEqual(found);
	});
});
