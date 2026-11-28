/**
 * An in-memory double of the Redis server `RedisSessionStorage` talks to, so its tests run without a live server.
 * It mirrors only the surface the storage uses: the client methods, and each script the storage sends, answered by
 * the marker on the script's first line (`-- OMP_…`) with what that script does on a server. As on a server, a key
 * holds a string or a hash, and a hash command on a key that holds a string fails with WRONGTYPE: in a script, the
 * writes before it stay, and none after it runs.
 */
import type { RedisSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";

interface FakeRedisCall {
	method: string;
	args: unknown[];
}

export interface FakeRedis extends RedisSessionStorageClient {
	/** Every call the client got, in order: a script as `send` with its command and arguments. */
	calls: FakeRedisCall[];
	strings: Map<string, string>;
	hashes: Map<string, Map<string, string>>;
	/**
	 * Fail the next call to `method` with `error`: a client method, or a write command a script runs (in lower
	 * case), which fails that script at that command. As on a server, the script's commands before it stay as they
	 * ran, and none after it runs.
	 */
	failNext(method: string, error: Error): void;
}

/**
 * A fake server over two maps. It answers each script the storage sends by the marker on the script's first line,
 * doing in TypeScript what that script does on a server.
 */
export function createFakeRedis(): FakeRedis {
	const strings = new Map<string, string>();
	const hashes = new Map<string, Map<string, string>>();
	const calls: FakeRedisCall[] = [];
	const failures = new Map<string, Error[]>();

	const checkFailure = (method: string): void => {
		const queue = failures.get(method);
		if (!queue || queue.length === 0) return;
		throw queue.shift() as Error;
	};

	const record = (method: string, args: unknown[]): void => {
		calls.push({ method, args });
	};

	/** The hash at `key`, if any; a key that holds a string fails a hash command with WRONGTYPE, as on a server. */
	const hashAt = (key: string): Map<string, string> | undefined => {
		if (strings.has(key)) throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
		return hashes.get(key);
	};

	const getHash = (key: string): Map<string, string> => {
		let h = hashAt(key);
		if (!h) {
			h = new Map();
			hashes.set(key, h);
		}
		return h;
	};

	/** HGET's reply: `field` of the hash `key`, null when missing. */
	const readField = (key: string, field: string): string | null => hashAt(key)?.get(field) ?? null;

	const byteLength = (key: string): number => Buffer.byteLength(strings.get(key) ?? "", "utf-8");

	/** GETRANGE's bytes of `key`, with its negative offsets counted from the end. */
	const byteRange = (key: string, start: number, end: number): string => {
		const bytes = Buffer.from(strings.get(key) ?? "", "utf-8");
		if (bytes.length === 0) return "";
		const from = Math.max(0, start < 0 ? bytes.length + start : start);
		const to = Math.min(bytes.length - 1, end < 0 ? bytes.length + end : end);
		if (to < from) return "";
		return bytes.subarray(from, to + 1).toString("utf-8");
	};

	/**
	 * What each script does, by its marker, given its keys and its arguments, as the storage's script with that
	 * marker does it and in its order: each write command takes the failure `failNext` set for it just before its
	 * own write, so a failing command leaves the writes before it in place, as on a server, and so does a hash read
	 * or write on a key that holds a string. A missing hash field is null, as a script's nil reply is.
	 */
	const scripts: Record<string, (keys: string[], argv: string[]) => unknown> = {
		"-- OMP_WRITE_FULL": ([fileKey, metaKey, titleKey], [content, path, mtimeMs, hasTitle, title, expected]) => {
			const actual = strings.has(fileKey) ? byteLength(fileKey) : -1;
			if (expected !== "" && Number(expected) !== actual) return [0, actual];
			hashAt(metaKey);
			hashAt(titleKey);
			checkFailure("set");
			strings.set(fileKey, content);
			checkFailure("hset");
			getHash(metaKey).set(path, mtimeMs);
			if (hasTitle === "1") {
				checkFailure("hset");
				getHash(titleKey).set(path, title);
			} else {
				checkFailure("hdel");
				getHash(titleKey).delete(path);
			}
			return [1, Buffer.byteLength(content, "utf-8")];
		},
		"-- OMP_APPEND": ([fileKey, metaKey, titleKey], [line, path, mtimeMs]) => {
			if (!strings.has(fileKey)) {
				checkFailure("hdel");
				getHash(titleKey).delete(path);
			}
			checkFailure("append");
			strings.set(fileKey, (strings.get(fileKey) ?? "") + line);
			checkFailure("hset");
			getHash(metaKey).set(path, mtimeMs);
			return byteLength(fileKey);
		},
		"-- OMP_UPDATE_TITLE": ([metaKey, titleKey, fileKey], [path, mtimeMs, title]) => {
			if (!strings.has(fileKey)) return 0;
			hashAt(titleKey);
			checkFailure("hset");
			getHash(metaKey).set(path, mtimeMs);
			checkFailure("hset");
			getHash(titleKey).set(path, title);
			return 1;
		},
		"-- OMP_READ_FULL": ([fileKey, titleKey], [path]) => {
			const text = strings.get(fileKey);
			return text === undefined ? null : [text, readField(titleKey, path)];
		},
		"-- OMP_READ_SLICES": ([fileKey, titleKey], [path, prefix, suffix]) => {
			if (!strings.has(fileKey)) return null;
			const head = Number(prefix) > 0 ? byteRange(fileKey, 0, Number(prefix) - 1) : "";
			const tail = Number(suffix) > 0 ? byteRange(fileKey, -Number(suffix), -1) : "";
			return [head, tail, readField(titleKey, path)];
		},
		"-- OMP_MOVE": ([srcKey, dstKey, metaKey, titleKey], [src, dst, mtimeMs]) => {
			const title = readField(titleKey, src);
			hashAt(metaKey);
			checkFailure("rename");
			const content = strings.get(srcKey);
			if (content === undefined) throw new Error("ERR no such key");
			strings.delete(srcKey);
			strings.set(dstKey, content);
			checkFailure("hdel");
			getHash(metaKey).delete(src);
			checkFailure("hset");
			getHash(metaKey).set(dst, mtimeMs);
			checkFailure("hdel");
			getHash(titleKey).delete(src);
			if (title !== null) {
				checkFailure("hset");
				getHash(titleKey).set(dst, title);
			} else {
				checkFailure("hdel");
				getHash(titleKey).delete(dst);
			}
			return 1;
		},
		"-- OMP_REMOVE": ([metaKey, titleKey, ...fileKeys], paths) => {
			hashAt(metaKey);
			hashAt(titleKey);
			for (const fileKey of fileKeys) {
				checkFailure("del");
				strings.delete(fileKey);
			}
			for (const path of paths) {
				checkFailure("hdel");
				getHash(metaKey).delete(path);
				checkFailure("hdel");
				getHash(titleKey).delete(path);
			}
			return paths.length;
		},
	};

	const client: FakeRedis = {
		calls,
		strings,
		hashes,
		failNext(method: string, error: Error): void {
			const queue = failures.get(method) ?? [];
			queue.push(error);
			failures.set(method, queue);
		},
		async send(command, args) {
			record("send", [command, args]);
			checkFailure("send");
			if (command !== "EVAL") throw new Error(`Unsupported Redis command: ${command}`);
			const [source = "", keyCount = "0"] = args;
			const marker = source.split("\n")[0];
			const script = scripts[marker];
			if (!script) throw new Error(`Unsupported Redis script: ${marker}`);
			return script(args.slice(2, 2 + Number(keyCount)), args.slice(2 + Number(keyCount)));
		},
		async get(key) {
			record("get", [key]);
			checkFailure("get");
			return strings.has(key) ? (strings.get(key) as string) : null;
		},
		async getrange(key, start, end) {
			record("getrange", [key, start, end]);
			checkFailure("getrange");
			return byteRange(key, start, end);
		},
		async strlen(key) {
			record("strlen", [key]);
			checkFailure("strlen");
			return byteLength(key);
		},
		async set(key, value) {
			record("set", [key, value]);
			checkFailure("set");
			hashes.delete(key);
			strings.set(key, value);
			return "OK";
		},
		async append(key, value) {
			record("append", [key, value]);
			checkFailure("append");
			const current = strings.get(key) ?? "";
			const next = current + value;
			strings.set(key, next);
			return Buffer.byteLength(next, "utf-8");
		},
		async del(...keys) {
			record("del", keys);
			checkFailure("del");
			let deleted = 0;
			for (const k of keys) {
				if (strings.delete(k)) deleted += 1;
			}
			return deleted;
		},
		async rename(src, dst) {
			record("rename", [src, dst]);
			checkFailure("rename");
			if (!strings.has(src)) {
				throw new Error("ERR no such key");
			}
			strings.set(dst, strings.get(src) as string);
			strings.delete(src);
			return "OK";
		},
		async scan(cursor, ...rest) {
			record("scan", [cursor, ...rest]);
			checkFailure("scan");
			let pattern = "*";
			for (let i = 0; i < rest.length; i++) {
				if (String(rest[i]).toUpperCase() === "MATCH") {
					pattern = String(rest[i + 1] ?? "*");
				}
			}
			const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
			const matches = Array.from(strings.keys()).filter(k => regex.test(k));
			return ["0", matches];
		},
		async hset(key, field, value) {
			record("hset", [key, field, value]);
			checkFailure("hset");
			getHash(key).set(field, value);
			return 1;
		},
		async hgetall(key) {
			record("hgetall", [key]);
			checkFailure("hgetall");
			const h = hashAt(key);
			if (!h) return {};
			const out: Record<string, string> = {};
			for (const [k, v] of h) out[k] = v;
			return out;
		},
		async hdel(key, ...fields) {
			record("hdel", [key, ...fields]);
			checkFailure("hdel");
			const h = hashAt(key);
			if (!h) return 0;
			let n = 0;
			for (const f of fields) {
				if (h.delete(f)) n += 1;
			}
			return n;
		},
	};

	return client;
}
