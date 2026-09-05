import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { arch, env, platform } from "node:process";
import { getAgentDir, isRecord, logger, ptree, withFileLock, writeFileAtomic } from "@oh-my-pi/pi-utils";

export const CURSOR_IDE_VERSION = "3.18.9";
export const CURSOR_IDE_COMMIT = "2ba48ff3f7514cc4643c52ca9f7b3173d9b66130";

const CURSOR_IDENTITY_COMMAND_TIMEOUT_MS = 5_000;
const REJECTED_MAC_ADDRESSES = new Set(["00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff", "ac:de:48:00:11:22"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface CursorMachineIdentity {
	readonly machineId: string;
	readonly macMachineId?: string;
	readonly machineIdSource: "host" | "fallback";
}

export interface NetworkInterfaceMap {
	readonly [name: string]: readonly { readonly mac: string }[] | undefined;
}

export interface IdentityDependencies {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly env: NodeJS.ProcessEnv;
	readonly execute: (command: string) => Promise<string>;
	readonly interfaces: () => NetworkInterfaceMap;
	readonly createUuid: () => string;
}

/** Execute one host-identity command with bounded, deadlock-safe process supervision. */
export async function executeIdentityCommand(
	command: string,
	targetPlatform: NodeJS.Platform = platform,
	targetEnv: NodeJS.ProcessEnv = env,
	timeoutMs = CURSOR_IDENTITY_COMMAND_TIMEOUT_MS,
): Promise<string> {
	const shell =
		targetPlatform === "win32"
			? [targetEnv.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
			: ["/bin/sh", "-c", command];
	const result = await ptree.exec(shell, { timeout: timeoutMs, stderr: "full" });
	return result.stdout;
}

const DEFAULT_DEPENDENCIES: IdentityDependencies = {
	platform,
	arch,
	env,
	execute: executeIdentityCommand,
	interfaces: os.networkInterfaces,
	createUuid: () => crypto.randomUUID(),
};

export function machineIdCommand(
	targetPlatform: NodeJS.Platform,
	targetArch: string,
	targetEnv: NodeJS.ProcessEnv,
): string {
	switch (targetPlatform) {
		case "darwin":
			return "ioreg -rd1 -c IOPlatformExpertDevice";
		case "win32": {
			const windowsRoot =
				targetArch === "ia32" && Object.hasOwn(targetEnv, "PROCESSOR_ARCHITEW6432")
					? "%windir%\\sysnative\\cmd.exe /c %windir%\\System32"
					: "%windir%\\System32";
			return `${windowsRoot}\\REG.exe QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid`;
		}
		case "linux":
			return "( cat /var/lib/dbus/machine-id /etc/machine-id 2> /dev/null || hostname ) | head -n 1 || :";
		case "freebsd":
			return "kenv -q smbios.system.uuid || sysctl -n kern.hostuuid";
		default:
			throw new Error(`Unsupported platform: ${targetPlatform}`);
	}
}

/** Normalize the platform command output exactly as Cursor 3.18.9. */
export function normalizeHardwareId(targetPlatform: NodeJS.Platform, output: string): string {
	switch (targetPlatform) {
		case "darwin": {
			const value = output.split("IOPlatformUUID")[1]?.split("\n")[0];
			if (value === undefined) throw new Error("IOPlatformUUID is missing");
			return value.replace(/=|\s+|"/giu, "").toLowerCase();
		}
		case "win32": {
			const value = output.split("REG_SZ")[1];
			if (value === undefined) throw new Error("MachineGuid is missing");
			return value.replace(/\r+|\n+|\s+/giu, "").toLowerCase();
		}
		case "linux":
		case "freebsd":
			return output.replace(/\r+|\n+|\s+/giu, "").toLowerCase();
		default:
			throw new Error(`Unsupported platform: ${targetPlatform}`);
	}
}

export async function deriveHostMachineId(dependencies: IdentityDependencies = DEFAULT_DEPENDENCIES): Promise<string> {
	const command = machineIdCommand(dependencies.platform, dependencies.arch, dependencies.env);
	const hardwareId = normalizeHardwareId(dependencies.platform, await dependencies.execute(command));
	if (hardwareId === "") throw new Error("Cursor host identity is empty");
	return new Bun.CryptoHasher("sha256").update(hardwareId).digest("hex");
}

export function firstUsableMac(interfaces: NetworkInterfaceMap): string {
	for (const name in interfaces) {
		const entries = interfaces[name];
		if (entries === undefined) continue;
		for (const entry of entries) {
			const normalized = entry.mac.replace(/-/gu, ":").toLowerCase();
			if (!REJECTED_MAC_ADDRESSES.has(normalized)) return entry.mac;
		}
	}
	throw new Error("Unable to retrieve mac address (unexpected format)");
}

export function deriveMacMachineId(
	dependencies: Pick<IdentityDependencies, "interfaces"> = DEFAULT_DEPENDENCIES,
): string | undefined {
	try {
		return new Bun.CryptoHasher("sha256").update(firstUsableMac(dependencies.interfaces())).digest("hex");
	} catch {
		return undefined;
	}
}

function fallbackIdentityPath(agentDir: string): string {
	return path.join(agentDir, "cursor", "identity.json");
}

function parseFallbackIdentity(raw: string): string {
	const value: unknown = JSON.parse(raw);
	if (!isRecord(value) || typeof value.machineId !== "string" || !UUID_PATTERN.test(value.machineId)) {
		throw new Error("Persisted Cursor fallback identity is invalid");
	}
	return value.machineId;
}

function isErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

async function loadOrCreateFallbackIdentity(agentDir: string, createUuid: () => string): Promise<string> {
	const identityPath = fallbackIdentityPath(agentDir);
	try {
		return parseFallbackIdentity(await Bun.file(identityPath).text());
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}

	await fs.mkdir(path.dirname(identityPath), { recursive: true, mode: 0o700 });
	return await withFileLock(identityPath, async () => {
		try {
			return parseFallbackIdentity(await Bun.file(identityPath).text());
		} catch (error) {
			if (!isErrorCode(error, "ENOENT")) throw error;
		}
		const machineId = createUuid();
		if (!UUID_PATTERN.test(machineId)) throw new Error("Generated Cursor fallback identity is invalid");
		await writeFileAtomic(identityPath, `${JSON.stringify({ machineId })}\n`, { mode: 0o600, directoryMode: 0o700 });
		return machineId;
	});
}

/** Derive Cursor's host identity, persisting and reporting a UUID only when host derivation fails. */
export async function loadCursorMachineIdentity(
	agentDir = getAgentDir(),
	dependencies: IdentityDependencies = DEFAULT_DEPENDENCIES,
): Promise<CursorMachineIdentity> {
	let machineId: string;
	let machineIdSource: CursorMachineIdentity["machineIdSource"];
	try {
		machineId = await deriveHostMachineId(dependencies);
		machineIdSource = "host";
	} catch (error) {
		machineId = await loadOrCreateFallbackIdentity(agentDir, dependencies.createUuid);
		machineIdSource = "fallback";
		logger.warn("Cursor host identity unavailable; using persisted fallback", { error: String(error) });
	}
	const macMachineId = deriveMacMachineId(dependencies);
	return macMachineId === undefined ? { machineId, machineIdSource } : { machineId, macMachineId, machineIdSource };
}
