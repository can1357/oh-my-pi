/**
 * Egress tripwire: a loopback proxy that records every connection a child process opens through
 * its proxy environment and answers `502 Bad Gateway` without forwarding a byte off the machine.
 *
 * It speaks raw TCP rather than HTTP because a client may send an absolute-URI `GET` or a
 * `CONNECT` tunnel for HTTPS. Either way the first request line identifies the destination.
 */

export interface TripwireRecord {
	/** Epoch ms of the accepted connection. */
	atMs: number;
	/** First request line the client sent, or `""` when it closed without sending one. */
	requestLine: string;
}

export interface Tripwire {
	/** Proxy URL for the child environment, for example `http://127.0.0.1:41235`. */
	readonly url: string;
	readonly records: readonly TripwireRecord[];
	close(): void;
}

interface ConnectionState {
	record: TripwireRecord;
	buffered: string;
	answered: boolean;
}

const REFUSAL = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const MAX_BUFFERED_BYTES = 8192;

export function startTripwire(now: () => number = Date.now): Tripwire {
	const records: TripwireRecord[] = [];
	const listener = Bun.listen<ConnectionState>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				const record: TripwireRecord = { atMs: now(), requestLine: "" };
				records.push(record);
				socket.data = { record, buffered: "", answered: false };
			},
			data(socket, bytes) {
				const state = socket.data;
				if (state.answered) return;
				state.buffered += new TextDecoder().decode(bytes);
				const lineEnd = state.buffered.indexOf("\r\n");
				if (lineEnd < 0 && state.buffered.length < MAX_BUFFERED_BYTES) return;
				state.record.requestLine = (lineEnd < 0 ? state.buffered : state.buffered.slice(0, lineEnd)).slice(0, 512);
				state.answered = true;
				socket.write(REFUSAL);
				socket.end();
			},
			close() {},
			error() {},
		},
	});
	return {
		url: `http://127.0.0.1:${listener.port}`,
		get records() {
			return records;
		},
		close() {
			listener.stop(true);
		},
	};
}
