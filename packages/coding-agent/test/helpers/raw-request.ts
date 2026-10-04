import * as net from "node:net";

/** JSON requests return a raw response line; raw bytes return parsed JSON or null on connection close. */
export function rawRequest(endpoint: string, request: object): Promise<string>;
export function rawRequest(endpoint: string, request: string): Promise<Record<string, unknown> | null>;
export function rawRequest(
	endpoint: string,
	request: object | string,
): Promise<string | Record<string, unknown> | null> {
	const { promise, resolve, reject } = Promise.withResolvers<string | Record<string, unknown> | null>();
	let buffer = "";
	const socket = net.createConnection({ path: endpoint });
	socket.setEncoding("utf8");
	socket.once("error", err => {
		socket.destroy();
		reject(err);
	});
	socket.once("connect", () => socket.write(typeof request === "string" ? request : `${JSON.stringify(request)}\n`));
	socket.on("data", chunk => {
		buffer += chunk;
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		try {
			const line = buffer.slice(0, newline);
			resolve(typeof request === "string" ? JSON.parse(line) : line);
		} catch (err) {
			reject(err);
		}
		socket.destroy();
	});
	socket.once("close", () => {
		if (typeof request === "string") resolve(null);
		else reject(new Error("Endpoint closed without a response"));
	});
	return promise;
}
