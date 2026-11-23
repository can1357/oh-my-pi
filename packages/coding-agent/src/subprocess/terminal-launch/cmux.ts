import { quotePosixArgvAsciiSafe } from "../../utils/shell-quote";
import { launchError, parseJson, runStep } from "./shared";
import type { SupportedMultiplexerCapabilities, TerminalLaunchBackend, TerminalLaunchProvider } from "./types";

const capabilities = {
	displayName: "CMUX",
	supported: true,
	pane: {
		displayName: "pane",
		execution: ["shell-input"],
		target: "surface",
		direction: ["right", "left", "up", "down"],
		focus: true,
		shellGrammar: "posix",
		cwdShellInput: true,
	},
	window: {
		displayName: "workspace",
		execution: ["shell-input"],
		target: "window",
		focus: true,
		name: true,
		shellGrammar: "posix",
	},
} as const satisfies SupportedMultiplexerCapabilities;

function cmuxPayload(value: Record<string, unknown>): Record<string, unknown> {
	if (value.ok === false) return value;
	const data = value.data;
	return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : value;
}

function cmuxId(value: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const id = value[key];
		if ((typeof id === "string" && id.trim()) || (typeof id === "number" && Number.isFinite(id))) return String(id);
	}
	return undefined;
}

const launchCmux: TerminalLaunchBackend<"cmux", typeof capabilities> = async (
	request,
	{ environment: env, runCli },
) => {
	if (!env.CMUX_WORKSPACE_ID && !env.CMUX_SURFACE_ID && !request.target) {
		throw launchError(request, "capability", "CMUX launch requires a CMUX context or explicit target ID.");
	}
	if (request.placement === "pane") {
		// An explicit surface is authoritative; never combine it with a different
		// ambient workspace target.
		const workspace = request.target ? undefined : env.CMUX_WORKSPACE_ID;
		const surface = request.target ?? env.CMUX_SURFACE_ID;
		const shellCommand = quotePosixArgvAsciiSafe(request.command, request.cwd);
		const focusArgs = request.focus === undefined ? [] : ["--focus", String(request.focus)];
		const argv = ["cmux", "--json", "new-split", request.direction ?? "right"];
		if (workspace) argv.push("--workspace", workspace);
		if (surface) argv.push("--surface", surface);
		argv.push("--command", shellCommand, ...focusArgs);
		// CMUX new-split restores CMUX_WORKSPACE_ID even with --surface, so an
		// explicit surface must not inherit an unrelated workspace context.
		const cliEnv = request.target ? { ...env, CMUX_WORKSPACE_ID: undefined } : undefined;
		const output = await runStep(request, "new-split", argv, request.cwd, runCli, cliEnv);
		const payload = cmuxPayload(parseJson(request, "new-split", output));
		if (payload.ok === false) {
			throw launchError(request, "new-split", "CMUX new-split returned an unsuccessful response.");
		}
		return { multiplexer: "cmux", placement: "pane", id: cmuxId(payload, "pane_id", "pane_ref") };
	}

	const argv = ["cmux", "--json", "workspace", "create"];
	if (request.target) {
		// A global --window focuses before dispatch; keep the target local so
		// --focus false can leave the existing window focused.
		argv.push("--window", request.target);
	}
	if (request.name) argv.push("--name", request.name);
	const focusArgs = request.focus === undefined ? [] : ["--focus", String(request.focus)];
	argv.push("--cwd", request.cwd, "--command", quotePosixArgvAsciiSafe(request.command), ...focusArgs);
	const output = await runStep(request, "workspace create", argv, request.cwd, runCli);
	const payload = cmuxPayload(parseJson(request, "workspace create", output));
	if (payload.ok === false) {
		throw launchError(request, "workspace create", "CMUX workspace create returned an unsuccessful response.");
	}
	return {
		multiplexer: "cmux",
		placement: "window",
		id: cmuxId(payload, "workspace_id", "workspace_ref"),
	};
};

export const cmuxLaunchProvider: TerminalLaunchProvider<"cmux", typeof capabilities> = {
	capabilities,
	launch: launchCmux,
};
