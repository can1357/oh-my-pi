import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { InternalUrlRouter } from "../internal-urls";
import { sessionResolveContext } from "../internal-urls/context";
import type { ToolSession } from "../tools";
import { resolveReadPathAsync } from "../tools/path-utils";
import { throwIfAborted } from "../tools/tool-errors";
import { parseCommandArgs } from "../utils/command-args";
import { normalizePackageRequirements } from "./package-requirements";

/** Code-only eval input; standalone percent commands prepare files or dependencies. */
export interface EvalSourceInput {
	language: "py" | "js";
	code: string;
}

/** A cell's source bytes and dependency requirements, resolved before execution. */
export interface PreparedEvalSource {
	code: string;
	filename?: string;
	packages?: string[];
	/** An explicit percent-command selection, committed only after successful execution. */
	environment?: "managed" | "project";
}

/**
 * Resolve standalone percent commands without downloads, execution, or source
 * echo. Python only intercepts `%load` (for internal URL paths); its `%pip`
 * runs through the runner's own magic in the kernel's interpreter.
 */
export async function prepareEvalSource(
	input: EvalSourceInput,
	session: ToolSession,
	signal?: AbortSignal,
): Promise<PreparedEvalSource> {
	throwIfAborted(signal);
	const command = /^%(load|pip|bun|environment)(?:[ \t]+([\s\S]*))?$/.exec(input.code.trim());
	if (!command || (input.language === "py" && command[1] !== "load")) return { code: input.code };
	const rawArgs = command[2] ?? "";
	if (/[\r\n]/.test(rawArgs)) {
		throw new ToolError(
			"Use %load, %pip, %bun, and %environment as standalone cells; run subsequent code in another eval call.",
		);
	}
	let args: string[];
	try {
		args = parseCommandArgs(rawArgs, { strict: true });
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
	if (command[1] === "environment") {
		const [environment] = args;
		if (args.length !== 1 || (environment !== "managed" && environment !== "project")) {
			throw new ToolError(
				"Usage: %environment managed|project. Project selection permits project dependency changes.",
			);
		}
		return { code: "", environment };
	}
	if (command[1] === "pip") throw new ToolError("Use %bun add for JavaScript dependencies.");
	if (command[1] === "bun") {
		if (args[0] !== "add" || args.length < 2) {
			throw new ToolError("Usage: %bun add <package requirements...>. Quote requirements containing spaces.");
		}
		return { code: "", packages: normalizePackageRequirements(args.slice(1)) };
	}
	const [file] = args;
	if (args.length !== 1 || !file) throw new ToolError("Usage: %load <script path>. Quote paths containing spaces.");
	let filename: string;
	const router = InternalUrlRouter.instance();
	if (router.canHandle(file)) {
		filename = await router.requireLocal(file, "load", sessionResolveContext(session, { signal }));
	} else {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file) && !file.startsWith("file://")) {
			throw new ToolError("Eval scripts must be local. Download and inspect remote scripts before executing them.");
		}
		filename = await resolveReadPathAsync(file, session.cwd);
	}
	let code: string;
	try {
		code = await Bun.file(filename).text();
	} catch (error) {
		throw new ToolError(`Cannot load eval script ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	throwIfAborted(signal);
	return { code, filename };
}
