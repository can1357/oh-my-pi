import * as fs from "node:fs";
import * as path from "node:path";

export const ESTATE_ROLE_COORDINATION_SCHEMA = "estate-role-coordination.v1";

export interface EstateRoleCoordinationEntry {
	role: string;
	thread?: string;
	cmux?: string;
	owner?: string;
	responsibility?: string;
	status?: string;
	evidence?: string;
	source_thread?: string;
	presentation?: string;
}

export interface EstateRoleCoordinationFile {
	schema: string;
	roles: EstateRoleCoordinationEntry[];
}

export interface EstateRoleCoordinationRegistry {
	path: string;
	roles: readonly EstateRoleCoordinationEntry[];
	byRole: ReadonlyMap<string, EstateRoleCoordinationEntry>;
	byThread: ReadonlyMap<string, EstateRoleCoordinationEntry>;
	byCmux: ReadonlyMap<string, EstateRoleCoordinationEntry>;
}

function indexRoles(roles: readonly EstateRoleCoordinationEntry[]): EstateRoleCoordinationRegistry {
	const byRole = new Map<string, EstateRoleCoordinationEntry>();
	const byThread = new Map<string, EstateRoleCoordinationEntry>();
	const byCmux = new Map<string, EstateRoleCoordinationEntry>();
	for (const entry of roles) {
		byRole.set(entry.role, entry);
		if (entry.thread) byThread.set(entry.thread, entry);
		if (entry.cmux) byCmux.set(entry.cmux, entry);
	}
	return { path: "", roles, byRole, byThread, byCmux };
}

/** Load a read-only estate role coordination file. Returns undefined when absent or invalid. */
export function loadEstateRoleCoordination(filePath: string): EstateRoleCoordinationRegistry | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as EstateRoleCoordinationFile;
		if (parsed.schema !== ESTATE_ROLE_COORDINATION_SCHEMA || !Array.isArray(parsed.roles)) return undefined;
		const roles = parsed.roles.filter(
			(entry): entry is EstateRoleCoordinationEntry =>
				typeof entry === "object" && entry !== null && typeof entry.role === "string" && entry.role.length > 0,
		);
		return { ...indexRoles(roles), path: path.resolve(filePath) };
	} catch {
		return undefined;
	}
}

/** Resolve an optional coordination file from cwd and explicit override. */
export function resolveEstateRoleCoordinationFile(cwd: string, overridePath?: string): string | undefined {
	const candidates = [
		overridePath,
		path.join(cwd, "estate-roles.json"),
		path.join(cwd, ".omp", "estate-roles.json"),
	].filter((candidate): candidate is string => Boolean(candidate?.trim()));
	for (const candidate of candidates) {
		const resolved = path.resolve(candidate);
		if (fs.existsSync(resolved)) return resolved;
	}
	return undefined;
}

/** Load the first existing coordination file for a workspace. */
export function loadWorkspaceEstateRoleCoordination(
	cwd: string,
	overridePath?: string,
): EstateRoleCoordinationRegistry | undefined {
	const filePath = resolveEstateRoleCoordinationFile(cwd, overridePath);
	return filePath ? loadEstateRoleCoordination(filePath) : undefined;
}
