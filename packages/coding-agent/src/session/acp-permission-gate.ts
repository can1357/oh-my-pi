import { editInspect } from "@oh-my-pi/pi-natives";
import { isRecord, stringProperty } from "@oh-my-pi/pi-utils";
import { resolveToCwd } from "../tools/path-utils";
import type { ClientBridgePermissionOption } from "./client-bridge";

/** Tools that require user permission before execution when an ACP client is connected. */
export const PERMISSION_REQUIRED_TOOLS: Record<string, true> = {
	bash: true,
	edit: true,
	delete: true,
	move: true,
};

/** Permission options presented to the client on each gated tool call. */
export const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

/** Permission options indexed by their wire identifiers; unknown IDs miss and fail closed. */
export const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option]));

function getEditDestructiveIntent(args: unknown): { kind: "delete" | "move"; paths: string[] } | undefined {
	if (!isRecord(args)) return undefined;

	const argsJson = JSON.stringify(args);
	const modes = Array.isArray(args.edits) ? ["patch"] : ["hashline", "apply_patch"];
	for (const mode of modes) {
		try {
			const fileOps = editInspect(mode, argsJson).fileOps;
			const op =
				fileOps.find(candidate => candidate.kind === "delete") ??
				fileOps.find(candidate => candidate.kind === "move");
			if (!op || (op.kind !== "delete" && op.kind !== "move")) continue;
			const paths = op.kind === "move" && op.to ? [op.path, op.to] : [op.path];
			return { kind: op.kind, paths };
		} catch {
			// The payload does not use this edit mode's syntax.
		}
	}

	return undefined;
}

/** Describes the permission prompt required for a destructive tool call. */
export function getPermissionIntent(
	toolName: string,
	args: unknown,
): { toolName: string; title: string; paths?: string[]; cacheKey: string } | undefined {
	const input = isRecord(args) ? args : {};
	if (toolName === "bash") {
		const command = stringProperty(input, "command")?.slice(0, 80);
		return { toolName, title: command || toolName, cacheKey: toolName };
	}
	if (toolName === "delete") {
		const filePath = stringProperty(input, "path");
		return {
			toolName,
			title: filePath ? `Delete ${filePath}` : toolName,
			paths: filePath ? [filePath] : undefined,
			cacheKey: toolName,
		};
	}
	if (toolName === "move") {
		const from = stringProperty(input, "oldPath") ?? stringProperty(input, "path") ?? stringProperty(input, "from");
		const to =
			stringProperty(input, "newPath") ?? stringProperty(input, "to") ?? stringProperty(input, "destination");
		if (from && to) return { toolName, title: `Move ${from} to ${to}`, paths: [from, to], cacheKey: toolName };
		return {
			toolName,
			title: from ? `Move ${from}` : toolName,
			paths: from ? [from] : undefined,
			cacheKey: toolName,
		};
	}
	if (toolName === "edit") {
		const intent = getEditDestructiveIntent(args);
		if (!intent) return undefined;
		if (intent.kind === "delete") {
			return {
				toolName,
				title: `Delete ${intent.paths[0] ?? "edit target"}`,
				paths: intent.paths,
				cacheKey: "edit:delete",
			};
		}
		const from = intent.paths[0];
		const to = intent.paths[1];
		return {
			toolName,
			title: from && to ? `Move ${from} to ${to}` : `Move ${from ?? to ?? "edit target"}`,
			paths: intent.paths,
			cacheKey: "edit:move",
		};
	}
	return undefined;
}

/** Converts tool path arguments into absolute ACP editor locations. */
export function extractPermissionLocations(
	args: unknown,
	cwd: string,
	explicitPaths?: string[],
): { path: string; line?: number }[] {
	if (!isRecord(args)) return [];
	const out: { path: string; line?: number }[] = [];
	const pushPath = (value: unknown) => {
		if (typeof value !== "string" || value.length === 0) return;
		// ACP locations carry file paths that the editor host will open or focus;
		// they must be absolute or the client cannot resolve them. Resolve raw
		// tool args (often cwd-relative) against the session cwd before sending.
		let resolved: string;
		try {
			resolved = resolveToCwd(value, cwd);
		} catch {
			return;
		}
		if (out.some(location => location.path === resolved)) return;
		out.push({ path: resolved });
	};
	if (explicitPaths) {
		for (const filePath of explicitPaths) pushPath(filePath);
		return out;
	}
	pushPath(args.path);
	pushPath(args.file);
	if (Array.isArray(args.paths)) {
		for (const filePath of args.paths) {
			if (typeof filePath === "string") pushPath(filePath);
		}
	}
	pushPath(args.oldPath);
	pushPath(args.newPath);
	pushPath(args.from);
	pushPath(args.to);
	pushPath(args.source);
	pushPath(args.destination);
	return out;
}
