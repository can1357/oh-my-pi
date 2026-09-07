import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as env from "@oh-my-pi/pi-utils/env";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { getDefault, type SettingPath, type SettingValue, type Settings } from "../config/settings";
import type { InteractiveModeContext } from "../modes/types";
import { expandTilde } from "../tools/path-utils";
import { sanitizeStatusText, TRUNCATE_LENGTHS } from "../tools/render-utils";
import { replaceFileAtomically } from "../utils/atomic-file";
import { CollabGuestLink } from "./guest";
import { CollabHost } from "./host";
import { DEFAULT_RELAY_URL } from "./protocol";

const hostStartAborts = new WeakMap<Promise<CollabHost>, AbortController>();

export const COLLAB_HOST_START_CANCELLED = "Collab host start cancelled";

export interface StartCollabOptions {
	relayUrl: string;
	webUrl?: string;
	writeLinkPath?: string;
}

/** Start a host and attach it to the interactive context. */
export async function startCollabHost(ctx: InteractiveModeContext, options: StartCollabOptions): Promise<CollabHost> {
	if (ctx.session.isDisposed) throw new Error(COLLAB_HOST_START_CANCELLED);
	if (ctx.collabGuest || ctx.collabGuestStart) throw new Error("Cannot host while joining as a guest");
	if (ctx.collabHost) return ctx.collabHost;
	if (ctx.collabHostStart) return ctx.collabHostStart;
	const abort = new AbortController();
	ctx.collabHostAbort = abort;
	const start = startCollabHostOnce(ctx, options, abort.signal);
	hostStartAborts.set(start, abort);
	ctx.collabHostStart = start;
	try {
		return await start;
	} finally {
		if (ctx.collabHostStart === start) ctx.collabHostStart = undefined;
		if (ctx.collabHostAbort === abort) ctx.collabHostAbort = undefined;
		hostStartAborts.delete(start);
	}
}

/** Join a guest session while reserving the collab role against host startup. */
export async function startCollabGuest(ctx: InteractiveModeContext, link: string): Promise<CollabGuestLink> {
	if (ctx.collabHost || ctx.collabHostStart) throw new Error("Stop hosting first (/collab stop)");
	if (ctx.collabGuest) return ctx.collabGuest;
	if (ctx.collabGuestStart) return ctx.collabGuestStart;
	const guest = new CollabGuestLink(ctx);
	const start = guest.join(link).then(() => guest);
	ctx.collabGuestStart = start;
	try {
		return await start;
	} finally {
		if (ctx.collabGuestStart === start) ctx.collabGuestStart = undefined;
	}
}

async function startCollabHostOnce(
	ctx: InteractiveModeContext,
	options: StartCollabOptions,
	signal: AbortSignal,
): Promise<CollabHost> {
	const host = new CollabHost(ctx);
	try {
		await host.start(options.relayUrl, options.webUrl ?? "", signal);
		await Promise.resolve();
	} catch (error) {
		if (signal.aborted) throw new Error(COLLAB_HOST_START_CANCELLED);
		throw error;
	}
	if (host.isStopped || signal.aborted || ctx.session.isDisposed || ctx.collabGuest || ctx.collabGuestStart) {
		await host.stop(
			signal.aborted || ctx.session.isDisposed || host.isStopped
				? "host start cancelled"
				: "guest joined while host was starting",
		);
		throw new Error(
			signal.aborted || ctx.session.isDisposed || host.isStopped
				? COLLAB_HOST_START_CANCELLED
				: "Cannot host while joined as a guest",
		);
	}
	ctx.collabHost = host;
	const writeLinkPath = options.writeLinkPath?.trim()
		? resolveCollabLinkPath(options.writeLinkPath, ctx.sessionManager.getCwd())
		: undefined;
	if (writeLinkPath && ctx.collabHost === host && !signal.aborted && !ctx.session.isDisposed) {
		try {
			await writeCollabLink(writeLinkPath, host.link, signal);
		} catch (error) {
			ctx.showError(`Failed to write collab link file: ${sanitizeCollabError(error)}`);
		}
	}
	if (ctx.collabHost !== host || signal.aborted || ctx.session.isDisposed) {
		await host.stop("host start cancelled");
		throw new Error(COLLAB_HOST_START_CANCELLED);
	}
	return host;
}

/** Cancel an in-flight host handshake or stop an attached host. */
export async function stopCollabHost(ctx: InteractiveModeContext, reason = "host stopped"): Promise<boolean> {
	const pending = ctx.collabHostStart;
	const abort = pending ? hostStartAborts.get(pending) : undefined;
	const settled = pending?.then(
		() => undefined,
		() => undefined,
	);
	abort?.abort();
	ctx.collabHostAbort?.abort();
	const host = ctx.collabHost;
	if (host) await host.stop(reason);
	if (settled) await settled;
	return host !== undefined || pending !== undefined;
}

function resolveCollabLinkPath(rawPath: string, ctxCwd: string): string {
	const expanded = expandTilde(rawPath.trim());
	return path.isAbsolute(expanded) ? expanded : path.resolve(ctxCwd, expanded);
}

async function withCollabLinkLock<T>(target: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	return await withFileLock(target, fn, { signal });
}

async function writeCollabLink(target: string, link: string, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	const tempPath = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
	);
	try {
		await withCollabLinkLock(
			target,
			async () => {
				if (signal?.aborted) return;
				let removeTemp = false;
				try {
					const handle = await fs.open(tempPath, "wx", 0o600);
					removeTemp = true;
					try {
						await handle.writeFile(link, "utf8");
						await handle.sync();
					} finally {
						await handle.close();
					}
					if (signal?.aborted) return;
					await replaceFileAtomically(tempPath, target);
					removeTemp = false;
				} finally {
					if (removeTemp) await fs.rm(tempPath, { force: true }).catch(() => {});
				}
			},
			signal,
		);
	} catch (error) {
		if (signal?.aborted) return;
		throw error;
	}
}

function sanitizeCollabError(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return sanitizeStatusText(detail, TRUNCATE_LENGTHS.CONTENT, "Unknown error");
}

export function resolveRelayUrl(input: string): string {
	const trimmed = input.trim();
	return trimmed.includes("://") ? trimmed : `wss://${trimmed}`;
}

type CollabSettingPath = Extract<SettingPath, `collab.${string}`>;

const PROJECT_DOTENV_GLOBAL_DIR_KEYS = [
	"PI_CODING_AGENT_DIR",
	"OMP_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"OMP_CONFIG_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
] as const;

function layerCollabValue(layer: unknown, path: CollabSettingPath): unknown {
	let current: unknown = layer;
	for (const segment of path.split(".")) {
		if (current === null || current === undefined || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function trustedCollabSetting<P extends CollabSettingPath>(settings: Settings, path: P): SettingValue<P> {
	const provenance = settings.getProvenance(path);
	if (provenance === "runtime" || provenance === "default") return settings.get(path);
	const effective = settings.get(path);
	if (path === "collab.autoStart") {
		if (effective === false) return false as SettingValue<P>;
		if (layerCollabValue(settings.getProjectSettings(), path) === false) return false as SettingValue<P>;
		if (settings.getConfigOverlayLayers().some(layer => layerCollabValue(layer, path) === false)) {
			return false as SettingValue<P>;
		}
	}
	if (PROJECT_DOTENV_GLOBAL_DIR_KEYS.some(name => env.isEnvOwnedByProjectDotenv(name))) return getDefault(path);
	if (provenance === "project" || provenance === "overlay") {
		const globalValue = layerCollabValue(settings.getGlobalSettings(), path);
		return (globalValue !== undefined ? globalValue : getDefault(path)) as SettingValue<P>;
	}
	return effective;
}

function isTrustedCollabConfigured(settings: Settings, path: CollabSettingPath): boolean {
	const provenance = settings.getProvenance(path);
	if (provenance === "runtime") return true;
	if (PROJECT_DOTENV_GLOBAL_DIR_KEYS.some(name => env.isEnvOwnedByProjectDotenv(name))) return false;
	if (provenance === "global") return true;
	if (provenance !== "project" && provenance !== "overlay") return false;
	return layerCollabValue(settings.getGlobalSettings(), path) !== undefined;
}

/** Start the configured host once during interactive startup. */
export async function autoStartCollab(ctx: InteractiveModeContext): Promise<boolean> {
	if (ctx.collabGuest || ctx.collabHost) return false;
	const autoStart = trustedCollabSetting(ctx.settings, "collab.autoStart");
	if (!autoStart) {
		if (ctx.settings.get("collab.autoStart")) {
			ctx.showWarning("Collab auto-start skipped: configure collab.autoStart outside project settings.");
		}
		return false;
	}
	const relayInput = trustedCollabSetting(ctx.settings, "collab.relayUrl")?.trim() ?? "";
	if (!relayInput) {
		ctx.showWarning("Collab auto-start skipped: set collab.relayUrl to a relay endpoint.");
		return false;
	}
	const relayUrl = resolveRelayUrl(relayInput);
	if (relayUrl === DEFAULT_RELAY_URL && !isTrustedCollabConfigured(ctx.settings, "collab.relayUrl")) {
		ctx.showWarning("Collab auto-start skipped: configure collab.relayUrl explicitly before using the public relay.");
		return false;
	}
	if ((ctx.settings.get("collab.relayUrl") ?? "") !== relayInput) {
		ctx.showWarning("Collab auto-start ignored a project or overlay collab.relayUrl.");
	}
	const writeLinkPath = trustedCollabSetting(ctx.settings, "collab.writeLinkPath") ?? "";
	if ((ctx.settings.get("collab.writeLinkPath") ?? "") !== writeLinkPath) {
		ctx.showWarning("Collab link file skipped: configure collab.writeLinkPath outside project settings.");
	}
	const webUrl = trustedCollabSetting(ctx.settings, "collab.webUrl") ?? "";
	if ((ctx.settings.get("collab.webUrl") ?? "") !== webUrl) {
		ctx.showWarning("Collab auto-start ignored a project or overlay collab.webUrl.");
	}
	try {
		await startCollabHost(ctx, {
			relayUrl,
			webUrl,
			writeLinkPath,
		});
		ctx.showStatus("Collab auto-started", { dim: true });
		return true;
	} catch (error) {
		if (error instanceof Error && error.message === COLLAB_HOST_START_CANCELLED) return false;
		ctx.showError(`Failed to auto-start collab session: ${sanitizeCollabError(error)}`);
		return false;
	}
}
