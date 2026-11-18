/**
 * Starting shell processes (`exec/shell-process-worker.ts`) and serving them
 * this process's internal URLs.
 *
 * A named service and a `pty` command run in the embedded engine as a process
 * of their own: the command line {@link shellProcessCommand} builds re-enters
 * this build with the worker selector. The engine there has no session, so the
 * URL paths its command names come back here: {@link grantShellUrls} lends one
 * shell process a session filesystem (within its approval tier) for as long as
 * the grant lives.
 */
import * as crypto from "node:crypto";
import { type IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getShellRuntimeDir, logger, postmortem, SHELL_PROCESS_SELECTOR } from "@oh-my-pi/pi-utils";
import type { InternalUrlFilesystem } from "../internal-urls/url-filesystem";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import {
	decodeShellUrlFrame,
	encodeShellUrlFrame,
	type ShellProcessSpec,
	type ShellProcessUrls,
	type ShellUrlHello,
	type ShellUrlRequest,
	shellProcessArgs,
} from "./shell-process-protocol";

/** The program and arguments that run `spec` as a shell process of this build. */
export function shellProcessCommand(spec: ShellProcessSpec): { application: string; args: string[] } {
	const [application, ...entry] = resolveCliEntryCmd();
	return { application, args: [...entry, SHELL_PROCESS_SELECTOR, ...shellProcessArgs(spec)] };
}

/** A session filesystem lent to one shell process. */
export interface ShellUrlGrant {
	/** What the shell process is started with ({@link ShellProcessSpec.urls}). */
	urls: ShellProcessUrls;
	/** End the grant: the process's connections close and its URL paths are missing from then on. */
	revoke(): void;
}

/** Serves granted filesystems to the shell processes that connect with their token. */
class ShellUrlServer {
	readonly #grants = new Map<string, { filesystem: InternalUrlFilesystem; connections: Set<IpcConnection> }>();

	constructor(readonly endpoint: string) {}

	static async listen(): Promise<ShellUrlServer> {
		// One endpoint per omp process: a shell process outlives nothing it could reach through another's.
		const endpoint = ipcEndpoint(getShellRuntimeDir(), `urls-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
		const urls = new ShellUrlServer(endpoint);
		const server = await IpcServer.listen(endpoint, { framing: "lines" }, connection => urls.#serve(connection));
		// Serving URLs never keeps this process alive.
		server.unref();
		postmortem.register("shell-urls", () => server.close());
		return urls;
	}

	grant(filesystem: InternalUrlFilesystem): ShellUrlGrant {
		const token = crypto.randomUUID();
		const connections = new Set<IpcConnection>();
		this.#grants.set(token, { filesystem, connections });
		return {
			urls: { endpoint: this.endpoint, token },
			revoke: () => {
				this.#grants.delete(token);
				for (const connection of connections) connection.destroy();
			},
		};
	}

	#serve(connection: IpcConnection): void {
		let granted: { filesystem: InternalUrlFilesystem; connections: Set<IpcConnection> } | undefined;
		connection.unref();
		connection.start(
			line => {
				let frame: ShellUrlHello | ShellUrlRequest;
				try {
					frame = decodeShellUrlFrame(line) as ShellUrlHello | ShellUrlRequest;
				} catch {
					connection.destroy();
					return;
				}
				if (!granted) {
					granted = "token" in frame ? this.#grants.get(frame.token) : undefined;
					// An unknown or revoked token is a process whose session is gone.
					if (granted) granted.connections.add(connection);
					else connection.destroy();
					return;
				}
				if (!("id" in frame)) return;
				const { id, request } = frame;
				void granted.filesystem.handle(request).then(
					response => connection.send(encodeShellUrlFrame({ id, response })),
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						connection.send(encodeShellUrlFrame({ id, response: { error: { code: "EIO", message } } }));
					},
				);
			},
			() => granted?.connections.delete(connection),
		);
	}
}

let server: Promise<ShellUrlServer | undefined> | undefined;

/**
 * Lend `filesystem` to the shell process started with the returned
 * {@link ShellUrlGrant.urls}, until the grant is revoked or this process
 * exits. Undefined when this process cannot listen: the shell process then
 * runs without URL paths.
 */
export async function grantShellUrls(filesystem: InternalUrlFilesystem): Promise<ShellUrlGrant | undefined> {
	server ??= ShellUrlServer.listen().catch((error: unknown) => {
		logger.warn("Could not serve internal URLs to shell processes", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	});
	return (await server)?.grant(filesystem);
}
