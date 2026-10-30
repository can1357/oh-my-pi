/**
 * `OMP_SESSION_PATH_PREFIX_ALIAS` — cross-machine row-key sharing for
 * `SqlSessionStorage`. A machine mirroring the canonical machine's layout
 * under a different absolute home (VPS `/home/zbornheimer/…` mirroring the
 * Mac's `/Users/zbornheimer/…`) must read and write the same rows without
 * re-keying anything: writes land on canonical keys, imported canonical rows
 * are found from the mirroring prefix, and `SessionManager` list/open still
 * match through the converted keys. Unset, every key is used verbatim.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseSessionPathPrefixAlias } from "@oh-my-pi/pi-coding-agent/session/session-path-alias";
import { resolveSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage-env";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";

/** The mirroring (VPS) prefix first, the canonical (storage) prefix second. */
const VPS_ALIAS = "/home/zbornheimer=/Users/zbornheimer";

function aliasOrThrow(raw: string) {
	const alias = parseSessionPathPrefixAlias(raw);
	if (!alias) throw new Error(`expected an alias for ${raw}`);
	return alias;
}

function fakeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("parseSessionPathPrefixAlias", () => {
	it("treats an unset or blank value as no alias", () => {
		expect(parseSessionPathPrefixAlias(undefined)).toBeUndefined();
		expect(parseSessionPathPrefixAlias("")).toBeUndefined();
		expect(parseSessionPathPrefixAlias("   ")).toBeUndefined();
	});

	it("rewrites caller paths to storage keys and back", () => {
		const alias = aliasOrThrow(VPS_ALIAS);
		expect(alias.storageKey("/home/zbornheimer/Developer/app/s.jsonl")).toBe(
			"/Users/zbornheimer/Developer/app/s.jsonl",
		);
		expect(alias.localPath("/Users/zbornheimer/Developer/app/s.jsonl")).toBe(
			"/home/zbornheimer/Developer/app/s.jsonl",
		);
		expect(alias.localPath(alias.storageKey("/home/zbornheimer/Developer/app/s.jsonl"))).toBe(
			"/home/zbornheimer/Developer/app/s.jsonl",
		);
	});

	it("leaves sibling prefixes and unrelated roots untouched in both directions", () => {
		const alias = aliasOrThrow(VPS_ALIAS);
		// `/home/zbornheimer2` starts with the prefix string but is not under it.
		expect(alias.storageKey("/home/zbornheimer2/s.jsonl")).toBe("/home/zbornheimer2/s.jsonl");
		expect(alias.storageKey("/srv/local.jsonl")).toBe("/srv/local.jsonl");
		expect(alias.localPath("/srv/canonical.jsonl")).toBe("/srv/canonical.jsonl");
	});

	it("accepts trailing separators on both sides", () => {
		const alias = aliasOrThrow("/home/zbornheimer/=/Users/zbornheimer/");
		expect(alias.storageKey("/home/zbornheimer/a/b.jsonl")).toBe("/Users/zbornheimer/a/b.jsonl");
	});

	it("rejects malformed values naming the env var", () => {
		for (const raw of [
			"missing-separator",
			"relative=/Users/zbornheimer",
			"/home/zbornheimer=relative",
			"/=/Users/zbornheimer",
			"/home/zbornheimer=",
			"=/Users/zbornheimer",
		]) {
			expect(() => parseSessionPathPrefixAlias(raw)).toThrow(/OMP_SESSION_PATH_PREFIX_ALIAS/);
		}
	});
});

describe("SqlSessionStorage path alias (SQLite backend)", () => {
	async function createAliasedSqlite() {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({
			client,
			pathAlias: aliasOrThrow(VPS_ALIAS),
		});
		return { client, storage };
	}

	async function selectPaths(client: InstanceType<typeof SQL>): Promise<string[]> {
		const rows = (await client.unsafe(`SELECT path FROM omp_session_files ORDER BY path`)) as Array<{
			path: string;
		}>;
		return rows.map(row => row.path);
	}

	it("stores caller paths under canonical keys and never under the alias prefix", async () => {
		const { client, storage } = await createAliasedSqlite();
		const localSession = "/home/zbornheimer/Developer/app/s.jsonl";

		await storage.writeText(localSession, "body\n");
		// A path outside the alias prefix must pass through verbatim.
		await storage.writeText("/srv/unrelated.jsonl", "unrelated\n");

		expect(await selectPaths(client)).toEqual([
			"/Users/zbornheimer/Developer/app/s.jsonl",
			"/srv/unrelated.jsonl",
		]);

		expect(await storage.readText(localSession)).toBe("body\n");
		expect((await storage.readTextSlices(localSession, 4, 2))).toEqual(["body", "y\n"]);
		expect(storage.existsSync(localSession)).toBe(true);

		// A truncating writer rewrites the same canonical row, not a new key.
		const writer = storage.openWriter(localSession, { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();
		expect(await storage.readText(localSession)).toBe("fresh\n");
		expect(await selectPaths(client)).toEqual([
			"/Users/zbornheimer/Developer/app/s.jsonl",
			"/srv/unrelated.jsonl",
		]);
		await client.end();
	});

	it("finds an imported canonical-keyed row from the alias prefix", async () => {
		const client = new SQL("sqlite::memory:");
		// The canonical machine's storage owns the table and its key space.
		const mac = await SqlSessionStorage.create({ client });
		const canonicalPath = "/Users/zbornheimer/Developer/app/imported.jsonl";
		await client.unsafe(`INSERT INTO omp_session_files (path, content, mtime_ms) VALUES (?, ?, ?)`, [
			canonicalPath,
			"from the canonical machine\n",
			Date.now(),
		]);
		await mac.refresh();

		const vps = await SqlSessionStorage.create({ client, pathAlias: aliasOrThrow(VPS_ALIAS) });
		const localPath = "/home/zbornheimer/Developer/app/imported.jsonl";

		// Warmed from SQL, the mirroring machine sees the row under its prefix…
		expect(vps.existsSync(localPath)).toBe(true);
		expect(await vps.readText(localPath)).toBe("from the canonical machine\n");
		expect(vps.listFilesSync("/home/zbornheimer/Developer/app", "*.jsonl")).toEqual([localPath]);
		// …so does the canonical machine under its own key: one row, two views.
		expect(mac.existsSync(canonicalPath)).toBe(true);

		// A title update from the mirroring machine lands on the canonical row
		// (an unaliased UPDATE would silently match nothing).
		await vps.updateSessionTitle(localPath, { title: "Mirrored", source: "user", updatedAt: "t2" });
		const titled = (await client.unsafe(
			`SELECT path, title, title_source FROM omp_session_files`,
		)) as Array<{ path: string; title: string; title_source: string }>;
		expect(titled).toEqual([
			{ path: canonicalPath, title: "Mirrored", title_source: "user" },
		]);
		await client.end();
	});

	it("rename and unlink through the alias move and delete canonical rows", async () => {
		const { client, storage } = await createAliasedSqlite();
		await storage.writeText("/home/zbornheimer/Developer/app/a.jsonl", "payload\n");

		await storage.rename("/home/zbornheimer/Developer/app/a.jsonl", "/home/zbornheimer/Developer/app/b.jsonl");
		expect(await selectPaths(client)).toEqual(["/Users/zbornheimer/Developer/app/b.jsonl"]);

		await storage.unlink("/home/zbornheimer/Developer/app/b.jsonl");
		expect(await selectPaths(client)).toEqual([]);
		await client.end();
	});
});

describe("SessionManager across mirrored machines", () => {
	it("lists, resumes, and extends one canonical row through the alias", async () => {
		const client = new SQL("sqlite::memory:");
		const macDir = "/Users/zbornheimer/Developer/alias-proj";
		const vpsDir = "/home/zbornheimer/Developer/alias-proj";

		// The canonical machine writes first, keying the row under its own prefix.
		const mac = await SqlSessionStorage.create({ client });
		const macManager = SessionManager.create("/repo", macDir, mac);
		macManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "written on the canonical machine" }],
			usage: fakeUsage(10, 5),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await macManager.flush();
		await mac.drain();
		const macFile = macManager.getSessionFile();
		if (!macFile) throw new Error("Expected session file");
		await macManager.close();

		// The mirroring machine lists the row under its own prefix and resumes it.
		const vps = await SqlSessionStorage.create({ client, pathAlias: aliasOrThrow(VPS_ALIAS) });
		const listed = await SessionManager.list("/repo", vpsDir, vps);
		expect(listed.map(session => session.path)).toEqual([
			`${vpsDir}/${path.basename(macFile)}`,
		]);

		const vpsManager = await SessionManager.open(listed[0].path, vpsDir, vps);
		vpsManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "replied from the mirror" }],
			usage: fakeUsage(3, 7),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await vpsManager.flush();
		await vps.drain();
		await vpsManager.close();

		// One row, canonical key: the canonical machine reads the mirror's turn.
		await mac.refresh();
		expect(await mac.readText(macFile)).toContain("replied from the mirror");
		const rows = (await client.unsafe(`SELECT path FROM omp_session_files`)) as Array<{
			path: string;
		}>;
		expect(rows.map(row => row.path)).toEqual([macFile]);
		await client.end();
	});
});

describe("resolveSessionStorage alias wiring", () => {
	it("passes the parsed alias env into the shared SQL storage", async () => {
		const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-alias-"));
		const dbFile = path.join(dbDir, "sessions.db");
		const previousUrl = process.env.SESSIONS_DB_URL;
		const previousAlias = process.env.OMP_SESSION_PATH_PREFIX_ALIAS;
		process.env.SESSIONS_DB_URL = `sqlite:${dbFile}`;
		process.env.OMP_SESSION_PATH_PREFIX_ALIAS = VPS_ALIAS;
		try {
			const storage = await resolveSessionStorage();
			await storage.writeText("/home/zbornheimer/Developer/wired.jsonl", "wired\n");

			// A second connection sees the canonical key, proving the env value
			// reached the backend rather than being ignored.
			const probe = new SQL(`sqlite:${dbFile}`);
			const rows = (await probe.unsafe(`SELECT path FROM omp_session_files`)) as Array<{
				path: string;
			}>;
			await probe.end();
			expect(rows.map(row => row.path)).toEqual(["/Users/zbornheimer/Developer/wired.jsonl"]);
		} finally {
			if (previousUrl === undefined) delete process.env.SESSIONS_DB_URL;
			else process.env.SESSIONS_DB_URL = previousUrl;
			if (previousAlias === undefined) delete process.env.OMP_SESSION_PATH_PREFIX_ALIAS;
			else process.env.OMP_SESSION_PATH_PREFIX_ALIAS = previousAlias;
			fs.rmSync(dbDir, { recursive: true, force: true });
		}
	});
});
