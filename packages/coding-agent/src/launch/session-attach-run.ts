import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { readSessionInfo } from "../session/session-listing";
import { createDaemonBrokerClient, type DaemonBrokerClient, requireTerminalProtocol } from "./client";
import {
	decideSessionAttach,
	probeSessionAttach,
	requestSessionTerminalRefresh,
	type SessionAttachTerminal,
} from "./session-attach";
import { runTerminalMirror, type TerminalMirrorOptions } from "./terminal-mirror";

/**
 * A live attach borrows this process's terminal until the owner exits or the
 * local terminal goes away; nothing here owns or disposes the session.
 */
export interface LiveSessionAttachOptions {
	/** The broker connection to stream from; defaults to this project's broker. */
	client?: DaemonBrokerClient;
	/** Endpoint directory that publishes the session's terminal refresh. */
	endpointDir?: string;
	/** Bound on the owner's `terminal_refreshed` reply. */
	timeoutMs?: number;
	sessionPath?: string;
	/** Local terminal seams, for tests and callers that already own a terminal. */
	mirror?: Partial<Omit<TerminalMirrorOptions, "client" | "name" | "id" | "subscriptionId" | "refresh">>;
}

/**
 * Reconnect this process to the live owner of `sessionId`: mirror the owner's
 * PTY into the local terminal and ask the owner to repaint for the new
 * subscriber. A refused refresh detaches only this mirror and rejects; the
 * owner keeps running.
 */
export async function runLiveSessionAttach(
	sessionId: string,
	terminal: SessionAttachTerminal,
	options: LiveSessionAttachOptions = {},
): Promise<number> {
	const client = options.client ?? (await createDaemonBrokerClient(terminal.projectDir, { existingOnly: true }));
	try {
		await requireTerminalProtocol(client);
	} catch (error) {
		client.close();
		throw error;
	}

	const result = await runTerminalMirror({
		...options.mirror,
		client,
		name: terminal.name,
		id: terminal.id,
		subscriptionId: `mirror-${Snowflake.next()}`,
		inputAfterRefresh: options.sessionPath !== undefined,
		refresh: async () => {
			if (options.sessionPath !== undefined) {
				const probe = await probeSessionAttach(sessionId, {
					endpointDir: options.endpointDir,
					timeoutMs: options.timeoutMs,
					sessionPath: options.sessionPath,
				});
				if (
					probe.status !== "live" ||
					probe.terminal?.projectDir !== terminal.projectDir ||
					probe.terminal.name !== terminal.name ||
					probe.terminal.id !== terminal.id
				) {
					throw new Error("The exact live owner changed before terminal attachment");
				}
			}
			await requestSessionTerminalRefresh(sessionId, terminal.id, {
				endpointDir: options.endpointDir,
				timeoutMs: options.timeoutMs,
			});
		},
	});
	return result.detached ? 0 : (result.exitCode ?? 1);
}

export async function runAttachOnly(sessionPath: string, options: LiveSessionAttachOptions = {}): Promise<void> {
	try {
		if (!path.isAbsolute(sessionPath)) throw new Error("--attach requires an absolute transcript path");
		const canonicalPath = await fs.realpath(sessionPath);
		const session = await readSessionInfo(canonicalPath);
		if (!session) throw new Error(`Not a readable session transcript: ${sessionPath}`);
		const probe = await probeSessionAttach(session.id, {
			endpointDir: options.endpointDir,
			timeoutMs: options.timeoutMs,
			sessionPath: canonicalPath,
		});
		const decision = decideSessionAttach(probe);
		if (decision.kind === "cold") throw new Error(`Session "${session.id}" has no live owner`);
		if (decision.kind === "refuse") throw new Error(`Session "${session.id}" attach refused: ${decision.code}`);
		process.exitCode = await runLiveSessionAttach(session.id, decision.terminal, {
			...options,
			sessionPath: canonicalPath,
		});
	} catch (error) {
		process.stderr.write(
			`Error: --attach refused: ${error instanceof Error ? error.message : String(error)}; no session or owner created.\n`,
		);
		process.exitCode = 2;
	}
}
