import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type { AgentRegistry, AgentStatus } from "../registry/agent-registry";
import type { IrcBus, IrcDeliveryReceipt, IrcMessage, IrcSendOptions } from "./bus";

const DESCRIPTOR_TTL_MS = 30_000;
const HEARTBEAT_MS = 5_000;

export interface IrcRemotePeer {
	id: string;
	localId: string;
	processId: string;
	displayName: string;
	kind: string;
	status: AgentStatus;
	parentId?: string;
	lastActivity: number;
	activity?: string;
	color?: string;
	unread: number;
}

interface IrcPeerDescriptor {
	version: 1;
	processId: string;
	cwdKey: string;
	cwd: string;
	endpoint: string;
	token: string;
	updatedAt: number;
	agents: Array<{
		id: string;
		displayName: string;
		kind: string;
		status: AgentStatus;
		parentId?: string;
		lastActivity: number;
		activity?: string;
		color?: string;
	}>;
}

interface IrcServer {
	hostname?: string;
	port?: number;
	stop: (closeActiveConnections?: boolean) => void | Promise<void>;
}

interface RemoteDeliveryBody {
	ok?: boolean;
	outcome?: IrcDeliveryReceipt["outcome"];
	error?: string;
}
export type IrcFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface IrcIpcConfig {
	cwd: string;
	registry: AgentRegistry;
	bus: IrcBus;
	/** Optional transport seam for contract tests and embedders. */
	transport?: IrcFetch;
}
function descriptorDirectory(cwdKey: string): string {
	return path.join(os.tmpdir(), "omp-irc", cwdKey);
}

export async function canonicalIrcCwd(cwd: string): Promise<string> {
	try {
		return await realpath(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

export function ircCwdKey(cwd: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(cwd);
	return hasher.digest("hex").slice(0, 32);
}

function isDescriptor(value: unknown): value is IrcPeerDescriptor {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<IrcPeerDescriptor>;
	return (
		candidate.version === 1 &&
		typeof candidate.processId === "string" &&
		typeof candidate.cwdKey === "string" &&
		typeof candidate.endpoint === "string" &&
		typeof candidate.token === "string" &&
		typeof candidate.updatedAt === "number" &&
		Array.isArray(candidate.agents)
	);
}

function isLoopbackEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		return url.protocol === "http:" && url.hostname === "127.0.0.1";
	} catch {
		return false;
	}
}

export class IrcIpc {
	static #global: IrcIpc | undefined;

	static global(): IrcIpc {
		if (!IrcIpc.#global) IrcIpc.#global = new IrcIpc();
		return IrcIpc.#global;
	}

	static resetGlobalForTests(): void {
		void IrcIpc.#global?.stop();
		IrcIpc.#global = new IrcIpc();
	}

	#config: IrcIpcConfig | undefined;
	#cwdKey: string | undefined;
	#processId: string | undefined;
	#token: string | undefined;
	#descriptorPath: string | undefined;
	#server: IrcServer | undefined;
	#heartbeat: NodeJS.Timeout | undefined;
	#unsubscribeRegistry: (() => void) | undefined;
	#enabled = true;
	#starting: Promise<void> | undefined;

	get enabled(): boolean {
		return this.#enabled;
	}

	async configure(config: IrcIpcConfig): Promise<void> {
		this.#config = config;
		if (!this.#enabled) return;
		if (this.#server) {
			await this.#writeDescriptor();
			return;
		}
		if (this.#starting) return this.#starting;
		this.#starting = this.#start();
		try {
			await this.#starting;
		} finally {
			this.#starting = undefined;
		}
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (this.#enabled === enabled) {
			if (enabled && this.#config && !this.#server) await this.configure(this.#config);
			return;
		}
		this.#enabled = enabled;
		if (!enabled) {
			await this.stop();
			return;
		}
		if (this.#config) await this.configure(this.#config);
	}

	async stop(): Promise<void> {
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = undefined;
		this.#unsubscribeRegistry?.();
		this.#unsubscribeRegistry = undefined;
		try {
			await this.#server?.stop(true);
		} catch {
			// IPC teardown is best effort.
		}
		this.#server = undefined;
		if (this.#descriptorPath) {
			try {
				await rm(this.#descriptorPath, { force: true });
			} catch {
				// Stale cleanup on the next discovery pass handles this case.
			}
		}
	}

	async list(_viewerId?: string): Promise<IrcRemotePeer[]> {
		if (!this.#enabled || !this.#cwdKey) return [];
		const peers: IrcRemotePeer[] = [];
		for (const descriptor of await this.#readDescriptors()) {
			if (descriptor.processId === this.#processId) continue;
			for (const agent of descriptor.agents) {
				if (agent.kind === "advisor") continue;
				peers.push({
					id: `${agent.id}@${descriptor.processId}`,
					localId: agent.id,
					processId: descriptor.processId,
					displayName: agent.displayName,
					kind: agent.kind,
					status: agent.status,
					parentId: agent.parentId,
					lastActivity: agent.lastActivity,
					activity: agent.activity,
					color: agent.color,
					unread: 0,
				});
			}
		}
		return peers;
	}

	async send(
		targetId: string,
		message: Omit<IrcMessage, "id" | "ts">,
		opts?: IrcSendOptions,
	): Promise<IrcDeliveryReceipt | undefined> {
		if (!this.#enabled || !this.#cwdKey) return undefined;
		const at = targetId.lastIndexOf("@");
		if (at <= 0 || at === targetId.length - 1) return undefined;
		const localId = targetId.slice(0, at);
		const processId = targetId.slice(at + 1);
		const descriptor = (await this.#readDescriptors()).find(item => item.processId === processId);
		if (!descriptor) return { to: targetId, outcome: "failed", error: `Unknown remote IRC peer "${targetId}".` };
		try {
			const transport: IrcFetch = this.#config?.transport ?? ((input, init) => fetch(input, init));
			const response = await transport(`${descriptor.endpoint}/irc`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${descriptor.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					cwdKey: this.#cwdKey,
					fromProcessId: this.#processId,
					from: message.from,
					to: localId,
					body: message.body,
					replyTo: message.replyTo,
					isBroadcast: opts?.isBroadcast === true,
					expectsReply: opts?.expectsReply === true,
				}),
			});
			const body = (await response.json().catch(() => ({}))) as RemoteDeliveryBody;
			if (!response.ok || body.ok === false || !body.outcome) {
				return {
					to: targetId,
					outcome: "failed",
					error: body.error ?? `Remote IRC endpoint returned HTTP ${response.status}.`,
				};
			}
			return { to: targetId, outcome: body.outcome, error: body.error };
		} catch (error) {
			return { to: targetId, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
		}
	}

	async #start(): Promise<void> {
		const config = this.#config;
		if (!config) return;
		const cwd = await canonicalIrcCwd(config.cwd);
		this.#cwdKey = ircCwdKey(cwd);
		this.#processId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
		this.#token = crypto.randomUUID();
		const directory = descriptorDirectory(this.#cwdKey);
		await mkdir(directory, { recursive: true });
		const token = this.#token;
		const cwdKey = this.#cwdKey;
		try {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const url = new URL(request.url);
					if (request.method !== "POST" || url.pathname !== "/irc")
						return new Response("Not Found", { status: 404 });
					if (request.headers.get("authorization") !== `Bearer ${token}`) {
						return Response.json({ ok: false, error: "IRC authentication failed." }, { status: 403 });
					}
					let body: {
						cwdKey?: unknown;
						fromProcessId?: unknown;
						from?: unknown;
						to?: unknown;
						body?: unknown;
						replyTo?: unknown;
						isBroadcast?: unknown;
						expectsReply?: unknown;
					};
					try {
						body = (await request.json()) as typeof body;
					} catch {
						return Response.json({ ok: false, error: "Invalid IRC JSON body." }, { status: 400 });
					}
					if (
						body.cwdKey !== cwdKey ||
						typeof body.fromProcessId !== "string" ||
						typeof body.from !== "string" ||
						typeof body.to !== "string" ||
						typeof body.body !== "string"
					) {
						return Response.json({ ok: false, error: "Invalid IRC delivery." }, { status: 400 });
					}
					const qualifiedFrom = `${body.from}@${body.fromProcessId}`;
					const result = await config.bus.deliverRemote(
						{
							id: crypto.randomUUID(),
							from: qualifiedFrom,
							to: body.to,
							body: body.body,
							ts: Date.now(),
							replyTo: typeof body.replyTo === "string" ? body.replyTo : undefined,
						},
						{
							isBroadcast: body.isBroadcast === true,
							expectsReply: body.expectsReply === true,
						},
					);
					return Response.json({ ok: result.outcome !== "failed", outcome: result.outcome, error: result.error });
				},
			});
			this.#server = server;
		} catch (error) {
			logger.warn("IRC cross-process IPC unavailable", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		this.#descriptorPath = path.join(directory, `${this.#processId}.json`);
		this.#unsubscribeRegistry = config.registry.onChange(() => void this.#writeDescriptor());
		this.#heartbeat = setInterval(() => void this.#writeDescriptor(), HEARTBEAT_MS);
		this.#heartbeat.unref?.();
		await this.#writeDescriptor();
	}

	async #writeDescriptor(): Promise<void> {
		if (!this.#descriptorPath || !this.#cwdKey || !this.#processId || !this.#token || !this.#server || !this.#config)
			return;
		const port = this.#server.port;
		if (port === undefined) return;
		const agents = this.#config.registry
			.list()
			.filter(ref => ref.cwd === undefined || ref.cwd === this.#config?.cwd)
			.map(ref => ({
				id: ref.id,
				displayName: ref.displayName,
				kind: ref.kind,
				status: ref.status,
				parentId: ref.parentId,
				lastActivity: ref.lastActivity,
				activity: ref.activity,
				color: ref.color,
			}));
		const descriptor: IrcPeerDescriptor = {
			version: 1,
			processId: this.#processId,
			cwdKey: this.#cwdKey,
			cwd: this.#config.cwd,
			endpoint: `http://${this.#server.hostname ?? "127.0.0.1"}:${port}`,
			token: this.#token,
			updatedAt: Date.now(),
			agents,
		};
		try {
			await Bun.write(this.#descriptorPath, JSON.stringify(descriptor));
		} catch (error) {
			logger.debug("IRC descriptor update failed", { error: String(error) });
		}
	}

	async #readDescriptors(): Promise<IrcPeerDescriptor[]> {
		if (!this.#cwdKey || !this.#processId) return [];
		const directory = descriptorDirectory(this.#cwdKey);
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch {
			return [];
		}
		const descriptors: IrcPeerDescriptor[] = [];
		for (const name of entries) {
			const filePath = path.join(directory, name);
			const file = Bun.file(filePath);
			try {
				const parsed = JSON.parse(await file.text()) as unknown;
				if (!isDescriptor(parsed) || parsed.cwdKey !== this.#cwdKey || !isLoopbackEndpoint(parsed.endpoint)) {
					await rm(filePath, { force: true });
					continue;
				}
				if (Date.now() - parsed.updatedAt > DESCRIPTOR_TTL_MS) {
					await rm(filePath, { force: true });
					continue;
				}
				descriptors.push(parsed);
			} catch {
				await rm(filePath, { force: true }).catch(() => {});
			}
		}
		return descriptors;
	}
}
