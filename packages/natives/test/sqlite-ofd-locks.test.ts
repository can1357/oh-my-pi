import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { grep, HeldFileKind, heldFileKind, Shell } from "../native/index.js";
import { installSqliteLockShim } from "../native/sqlite-locks.js";

// Issue #15586: closing any descriptor of a live database or its `-shm` released the
// connection's POSIX locks, and Bun's own file APIs close with raw syscalls nothing can
// guard. Once SQLite's locks are open-file-description locks, no such close releases them.
test.skipIf(process.platform !== "linux")(
	"in-process reads leave a live WAL connection's locks in place once SQLite uses OFD locks",
	async () => {
		expect(installSqliteLockShim()).toBe(true);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ofd-locks-"));
		const dbPath = path.join(dir, "agent.db");
		const db = new Database(dbPath);
		try {
			db.run("PRAGMA journal_mode=WAL");
			db.run("CREATE TABLE t(id INTEGER PRIMARY KEY, v BLOB)");
			const locksOn = () => {
				const inodes = [dbPath, `${dbPath}-shm`].map(file => `:${fs.statSync(file).ino}`);
				return fs
					.readFileSync("/proc/locks", "utf8")
					.split("\n")
					.map(line => line.replace("->", "").trim().split(/\s+/))
					.filter(fields => inodes.some(ino => fields[5]?.endsWith(ino)))
					.map(fields => fields[1]);
			};
			expect(locksOn()).toEqual(["OFDLCK", "OFDLCK"]);

			await Bun.file(dbPath).text();
			await Bun.file(`${dbPath}-shm`).bytes();
			fs.readFileSync(dbPath);
			fs.copyFileSync(`${dbPath}-shm`, path.join(dir, "copy"));
			// The addon's own opens and closes: native grep and the bash tool's builtins.
			await grep({ pattern: "x", path: dir, hidden: true, gitignore: false });
			await new Shell({ sessionEnv: { HOME: os.homedir(), PATH: "/usr/bin:/bin" } }).run(
				{ command: `cat agent.db-shm > /dev/null; cp agent.db ${dir}/copy2; grep -rl x . > /dev/null`, cwd: dir },
				() => {},
			);
			expect(locksOn()).toEqual(["OFDLCK", "OFDLCK"]);
			expect(heldFileKind(dbPath)).toBe(HeldFileKind.Database);
			expect(heldFileKind(`${dbPath}-shm`)).toBe(HeldFileKind.WalIndex);
			expect(heldFileKind(path.join(dir, "copy"))).toBeNull();

			// A peer on POSIX locks still sees this connection and leaves its WAL in place.
			const walInode = fs.statSync(`${dbPath}-wal`).ino;
			const code = `const {Database}=require("bun:sqlite");const d=new Database(${JSON.stringify(dbPath)});d.run("PRAGMA busy_timeout=2000");d.run("INSERT INTO t VALUES (NULL, randomblob(3000))");d.close();`;
			expect(Bun.spawnSync([process.execPath, "-e", code]).exitCode).toBe(0);
			expect(fs.statSync(`${dbPath}-wal`).ino).toBe(walInode);
			db.run("INSERT INTO t VALUES (NULL, randomblob(3000))");
			expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			db.close();
		}
		// The last close released the locks, so this connection cleaned up as the last one.
		expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	},
);

test.skipIf(process.platform !== "linux")(
	"heldFileKind still reports a database once the connection that took its first lock closed",
	() => {
		expect(installSqliteLockShim()).toBe(true);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ofd-held-"));
		const dbPath = path.join(dir, "store.db");
		try {
			// Rollback journal: no lock outlives a transaction, so the first connection's
			// descriptor really closes and the shim's private descriptor (older than the
			// second connection's) is the first one `/proc/self/fd` lists.
			const first = new Database(dbPath);
			first.run("CREATE TABLE t(x)");
			const second = new Database(dbPath);
			second.query("SELECT count(*) FROM t").get();
			first.close();
			second.run("BEGIN IMMEDIATE");
			try {
				expect(heldFileKind(dbPath)).toBe(HeldFileKind.Database);
			} finally {
				second.run("ROLLBACK");
				second.close();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);
