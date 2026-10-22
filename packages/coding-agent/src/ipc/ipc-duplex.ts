import { Duplex } from "node:stream";
import type { IpcConnection } from "@oh-my-pi/pi-natives";

/**
 * Node duplex over a `raw` {@link IpcConnection}, for transports written against
 * `net.Socket` streams (`Readable.toWeb` input, a backpressured sink, `close`
 * once both directions ended). Starts the connection, so call it once.
 *
 * The native connection has no pause: received chunks buffer in the stream
 * until read, so the reader must keep consuming.
 */
export function ipcDuplex(connection: IpcConnection): Duplex {
	const stream = new Duplex({
		allowHalfOpen: false,
		read() {},
		write(chunk: Buffer, _encoding, callback) {
			if (connection.send(chunk)) callback();
			else void connection.drained().then(() => callback());
		},
		// Flush first: a `destroy()` from the `finish` handler drops whatever the native queue still holds.
		final(callback) {
			void connection.drained().then(() => {
				if (!connection.closed) connection.end();
				callback();
			});
		},
		destroy(error, callback) {
			connection.destroy();
			// End the readable side first, as `net.Socket` does: `Readable.toWeb` otherwise aborts its reader on close.
			if (!error) stream.push(null);
			callback(error);
		},
	});
	connection.startRaw(
		chunk => {
			if (!stream.destroyed) stream.push(chunk);
		},
		reason => {
			if (stream.destroyed) return;
			if (reason === null) stream.push(null);
			else stream.destroy(new Error(reason));
		},
	);
	return stream;
}
