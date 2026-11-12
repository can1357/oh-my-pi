// Listens on a Unix socket, prints one line once it does, then blocks its event
// loop for good: it never accepts, so connections queue until its accept queue
// is full, as they do for a live broker too busy to accept.
// argv: <socketPath>
import * as net from "node:net";

const [socketPath] = process.argv.slice(2);
net.createServer().listen(socketPath, () => {
	process.stdout.write("listening\n", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));
});
