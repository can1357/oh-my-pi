/**
 * One RPC client: its frame codec, output writer, session-event projection,
 * prompt results, host tool/URI bridges and per-client flags. Session-wide
 * state lives in `RpcServer`.
 */
import type { Writable } from "node:stream";
import { isRecord } from "@oh-my-pi/pi-utils";
import { RpcHostToolBridge } from "./host-tools";
import { RpcHostUriBridge } from "./host-uris";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { readRpcInputFrames } from "./rpc-input";
import { RpcWordPredictor } from "./rpc-mode";
import { RpcOutputWriter } from "./rpc-output";
import { RpcPromptResults } from "./rpc-prompt-results";
import { RpcSessionEventForwarder } from "./rpc-session-events";
import type { RpcScheduledTurnProbe, RpcSettleSession } from "./rpc-session-settle";
import type { RpcSubagentSubscriptionLevel } from "./rpc-types";

export interface RpcConnectionTransport {
	input: ReadableStream<Uint8Array>;
	sink: Writable;
}

export interface RpcConnectionOptions {
	/** Socket connections: frames carry `seq`; stdio: false. */
	sequenced: boolean;
	/** Receives extension_ui_request frames and may answer them. */
	ui: boolean;
	/** Fail output once the undelivered backlog exceeds this (bytes). Undefined = unbounded; `RpcServer.connect` defaults it to 64 MiB. */
	maxSpoolBytes?: number;
	clientId: string;
	client?: { kind: string; label?: string };
}

export class RpcConnection {
	readonly encoder = new RpcFrameEncoder();
	readonly writer: RpcOutputWriter;
	readonly events: RpcSessionEventForwarder;
	readonly promptResults: RpcPromptResults;
	readonly wordPredictor = new RpcWordPredictor();
	readonly hostTools: RpcHostToolBridge;
	readonly hostUris: RpcHostUriBridge;
	/** Set by `set_ask_dialog`; hosts that never opt in keep the select/editor ask fallback. */
	askDialogEnabled = false;
	/** Set by `set_subagent_subscription`; gates which subagent frames this client receives. */
	subagentLevel: RpcSubagentSubscriptionLevel = "off";
	/**
	 * Reports a host-scheduled turn not yet admitted (a goal continuation), which keeps `prompt_result.sessionSettled`
	 * false. Set by the owning server: stdio's connection exists before its server does.
	 */
	scheduledTurn: RpcScheduledTurnProbe | undefined;
	/** Resolves when the input stream ends. */
	readonly inputClosed: Promise<void>;
	readonly #input: ReadableStream<Uint8Array>;
	readonly #sink: Writable;
	readonly #inputEnd = Promise.withResolvers<void>();
	readonly #dropped = new AbortController();
	#listening = false;

	/** Writes the `ready` frame. `onOutputFailure` runs once the sink can no longer take frames. */
	constructor(
		session: RpcSettleSession,
		transport: RpcConnectionTransport,
		readonly options: RpcConnectionOptions,
		onOutputFailure: (error: Error) => void,
	) {
		this.writer = new RpcOutputWriter(transport.sink, onOutputFailure, { maxSpoolBytes: options.maxSpoolBytes });
		// Signal to the client that the server is ready to accept commands.
		this.send({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
		});
		const send = (frame: object) => this.send(frame);
		this.promptResults = new RpcPromptResults(session, send, () => this.scheduledTurn?.() === true);
		this.events = new RpcSessionEventForwarder(send);
		this.hostTools = new RpcHostToolBridge(send);
		this.hostUris = new RpcHostUriBridge(send);
		this.#input = transport.input;
		this.#sink = transport.sink;
		this.inputClosed = this.#inputEnd.promise;
	}

	/** Encode and write one frame; flips the encoder to v2 after a successful negotiate_protocol response. */
	send(frame: object): void {
		this.writer.write(this.encoder.encodeFrames(frame));
		if (
			isRecord(frame) &&
			frame.type === "response" &&
			frame.command === "negotiate_protocol" &&
			frame.success === true
		)
			this.encoder.setProtocolVersion(2);
	}

	/**
	 * Read frames line by line until the input ends, then settle {@link inputClosed}.
	 * A malformed line reaches `onParseError` and reading continues (issue #5194).
	 */
	listen(onFrame: (frame: unknown) => void, onParseError: (message: string) => void): void {
		if (this.#listening) throw new Error("RPC connection is already listening");
		this.#listening = true;
		void readRpcInputFrames(this.#input, onFrame, onParseError).then(this.#inputEnd.resolve, this.#inputEnd.reject);
	}

	/** Deliver every queued frame to the sink. */
	close(): Promise<void> {
		return this.writer.close();
	}

	/** Aborts once the server drops this connection, so work waiting on this client (e.g. a login prompt) gives up. */
	get dropped(): AbortSignal {
		return this.#dropped.signal;
	}

	/** End the transport without delivering queued output, so the client learns it was dropped; aborts {@link dropped}. */
	drop(): void {
		this.#dropped.abort(new Error("RPC client disconnected"));
		this.#sink.destroy();
	}
}
