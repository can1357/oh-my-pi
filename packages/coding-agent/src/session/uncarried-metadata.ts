/**
 * What the archive does not carry of a file or a directory, and the check a
 * reclaim makes that a live entry carries none of it before giving it up.
 *
 * The archive holds a file's bytes and permission bits, and a directory's
 * permission bits, which a restore gives back narrowed by its umask and never
 * wider than the live directory's (see `directoryModeFor`). Everything else a
 * person or a program can set on an entry is held by the live entry alone,
 * and a reclaim that gives the entry up loses it for good: a review gave an
 * artifact a file capability, and archive, reclaim and restore each exited 0
 * with the capability gone. So for every kind of metadata the archive does
 * not carry, a reclaim compares the live entry with what a restore would
 * make, and keeps an entry that differs:
 *
 * - Owner: a restore makes every entry this user's.
 * - Group: a restore's new entry takes the group any new entry in its
 *   directory takes — the directory's own where it is setgid, this
 *   process's effective group otherwise.
 * - Extended attributes, every one this process can list: `user.*`, ACLs
 *   (`system.posix_acl_*`), file capabilities (`security.capability`),
 *   integrity data (`security.ima`, `security.evm`), and the label a Linux
 *   security module keeps on a file (`security.selinux`, `security.SMACK64`).
 *   A restore gives a new file the label the policy gives a new file there,
 *   which is not the label `chcon` set by hand, and nothing here can show
 *   the two are the same — so on a host that labels every file, SELinux or
 *   Smack, a reclaim keeps every entry and gives up nothing. That is the
 *   price of not losing a label; the refusal says so. `trusted.*`
 *   attributes are listed only to a process with `CAP_SYS_ADMIN`: a reclaim
 *   run with it sees one and keeps the entry, and one run without it cannot
 *   see one that root put on a user's file. Only root can make or read
 *   such an attribute, and only root could restore one.
 * - Inode flags, the ones `chattr` sets (no-dump, no-atime, append-only,
 *   immutable, no-copy-on-write, case-folding, encryption, verity, …), read
 *   with `FS_IOC_GETFLAGS`: a new entry takes only those its directory passes
 *   on, so a flag set on the entry by hand, or one its directory passes on
 *   that the entry lacks, keeps it. Which flags a directory passes on is the
 *   ext4 rule; a filesystem that passes on fewer makes this keep more, never
 *   less. Where the call cannot be made — see `libc.ts` — no flag is seen.
 * - The sticky bit on a directory, and setgid on one whose own directory is
 *   not setgid: a restore sets neither.
 * - Other names: a file with more than one hard link. The archive holds one
 *   file, so a restore brings back a separate copy, and giving up one name
 *   frees no space.
 *
 * Not carried and not checked, by design: times — a restore is a new write,
 * and no process can set a change time or a birth time — and the inode
 * number and device, which the filesystem chooses.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errnoName, isErrno, type Libc, libc } from "./libc";

/** Labels a Linux security module keeps on a file; see the module comment. */
const SECURITY_LABELS: Record<string, true> = {
	"security.selinux": true,
	"security.SMACK64": true,
	"security.SMACK64TRANSMUTE": true,
	"security.SMACK64EXEC": true,
	"security.SMACK64MMAP": true,
};

/**
 * The names of the extended attributes on the file or directory open at
 * `fd`: every one this process can list, none of which the archive carries.
 * Throws when they cannot be read: "could not look" is not "none". Windows
 * has no extended attributes in this sense; an NTFS alternate data stream
 * is not asked about.
 */
export function extendedAttributeNames(fd: number): string[] {
	if (process.platform === "win32") return [];
	const lib = libc();
	for (let attempt = 0; attempt < 8; attempt++) {
		const size = lib.flistxattr(fd, null, 0);
		if (size < 0) {
			const code = lib.errno();
			// The filesystem keeps no extended attributes.
			if (isErrno(code, "ENOTSUP", "EOPNOTSUPP")) return [];
			throw new Error(`its extended attributes could not be listed (${errnoName(code)})`);
		}
		if (size === 0) return [];
		const names = Buffer.alloc(size);
		const got = lib.flistxattr(fd, names, size);
		if (got < 0) {
			const code = lib.errno();
			// The list grew between sizing the buffer and reading it.
			if (isErrno(code, "ERANGE")) continue;
			if (isErrno(code, "ENOTSUP", "EOPNOTSUPP")) return [];
			throw new Error(`its extended attributes could not be listed (${errnoName(code)})`);
		}
		return names
			.subarray(0, got)
			.toString("utf8")
			.split("\0")
			.filter(name => name.length > 0);
	}
	throw new Error("its extended attributes kept changing while they were listed");
}

/** `FS_IOC_GETFLAGS`, `_IOR('f', 1, long)` on the 64-bit systems omp runs on; the kernel writes an `int`. */
const FS_IOC_GETFLAGS = 0x80086601;

/** The `chattr` letter of each flag a person or a program sets. */
const FLAG_LETTERS: ReadonlyArray<readonly [number, string]> = [
	[0x1, "s"],
	[0x2, "u"],
	[0x4, "c"],
	[0x8, "S"],
	[0x10, "i"],
	[0x20, "a"],
	[0x40, "d"],
	[0x80, "A"],
	[0x400, "m"],
	[0x800, "E"],
	[0x4000, "j"],
	[0x8000, "t"],
	[0x10000, "D"],
	[0x20000, "T"],
	[0x100000, "V"],
	[0x800000, "C"],
	[0x2000000, "x"],
	[0x20000000, "P"],
	[0x40000000, "F"],
];

/**
 * The flags a person or a program sets. The rest — extents, an indexed
 * directory, inline data and their like — the filesystem sets on its own,
 * on a restored entry as on any other.
 */
const SET_BY_HAND = FLAG_LETTERS.reduce((mask, [bit]) => mask | bit, 0);

/** What a new file takes from its directory, by ext4's rule (`EXT4_FL_INHERITED` less the directory-only flags). */
const PASSED_TO_FILE = 0x1 | 0x2 | 0x4 | 0x8 | 0x40 | 0x80 | 0x400 | 0x800 | 0x4000 | 0x8000 | 0x800000 | 0x2000000;

/** What a new directory takes from its directory: a file's, and directory sync, project inheritance and case folding. */
const PASSED_TO_DIRECTORY = PASSED_TO_FILE | 0x10000 | 0x20000000 | 0x40000000;

/**
 * The inode flags of the entry open at `fd`, or undefined where the
 * filesystem keeps none or the call cannot be made here. Throws when they
 * exist and could not be read.
 */
export function inodeFlags(fd: number): number | undefined {
	let lib: Libc;
	try {
		lib = libc();
	} catch {
		return undefined;
	}
	if (!lib.ioctl) return undefined;
	const into = Buffer.alloc(8);
	if (lib.ioctl(fd, FS_IOC_GETFLAGS, into) === 0) return into.readUInt32LE(0);
	const code = lib.errno();
	if (isErrno(code, "ENOTTY", "ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS")) return undefined;
	throw new Error(`its inode flags could not be read (${errnoName(code)})`);
}

/** The directory an entry is in, as a restore's new entry there would see it. */
export interface ParentDirectory {
	stat: Stats;
	/** Its inode flags; undefined where none are kept. */
	flags: number | undefined;
}

/** What the directory open at `fd` passes on; see {@link ParentDirectory}. */
export async function parentDirectoryFrom(handle: fs.FileHandle): Promise<ParentDirectory> {
	return { stat: await handle.stat(), flags: inodeFlags(handle.fd) };
}

/** What the directory `entry` is in passes on, read through a descriptor on it. */
export async function parentDirectoryOf(entry: string): Promise<ParentDirectory> {
	const handle = await fs.open(path.dirname(entry), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
	try {
		return await parentDirectoryFrom(handle);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Why `entry`, open at `fd` and seen through it as `stat`, must be kept: it
 * carries something the archive does not hold and a restore would not make
 * again in `parent` — see the module comment — or what it carries could not
 * be read. Undefined when it carries nothing of the kind.
 *
 * Every clause names the entry, and the sentence ends with what to do.
 */
export function uncarriedMetadataRefusal(
	entry: string,
	fd: number,
	stat: Stats,
	parent: ParentDirectory,
): string | undefined {
	const reasons: string[] = [];
	const kind = stat.isDirectory() ? "directory" : "file";
	const uid = process.geteuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		reasons.push(`${entry} is owned by user ${stat.uid}, and a restore would make it this user's (${uid})`);
	}
	const egid = process.getegid?.();
	if (egid !== undefined) {
		const group = parent.stat.mode & 0o2000 ? parent.stat.gid : egid;
		if (stat.gid !== group)
			reasons.push(`${entry} has group ${stat.gid}, and a restore would give it group ${group}`);
	}
	if (stat.isFile() && stat.nlink > 1) {
		reasons.push(
			`${entry} has ${stat.nlink} names (hard links): the archive holds one file, so a restore would bring back a ` +
				`separate copy, and giving up this name frees no space`,
		);
	}
	if (stat.isDirectory() && stat.mode & 0o1000) {
		reasons.push(`${entry} has the sticky bit, which a restore does not set`);
	}
	if (stat.isDirectory() && stat.mode & 0o2000 && !(parent.stat.mode & 0o2000)) {
		reasons.push(`${entry} is setgid in a directory that is not, and a restore does not set that`);
	}
	let labelled = false;
	try {
		const names = extendedAttributeNames(fd);
		if (names.length > 0) {
			reasons.push(`${entry} carries extended attributes (${names.join(", ")}), which the archive does not hold`);
			labelled = names.some(name => SECURITY_LABELS[name] === true);
		}
	} catch (error) {
		reasons.push(`${entry}: ${error instanceof Error ? error.message : String(error)}, and the archive holds none`);
	}
	try {
		const flags = inodeFlags(fd);
		if (flags !== undefined) {
			const passed = (parent.flags ?? 0) & (stat.isDirectory() ? PASSED_TO_DIRECTORY : PASSED_TO_FILE);
			const differ = (flags ^ passed) & SET_BY_HAND;
			if (differ !== 0) {
				const said = FLAG_LETTERS.filter(([bit]) => differ & bit)
					.map(([bit, letter]) => `${flags & bit ? "+" : "-"}${letter}`)
					.join(" ");
				reasons.push(
					`${entry} has inode flags (${said}, as \`chattr\` shows them) that a new ${kind} in ` +
						`${path.dirname(entry)} would not have, which the archive does not hold`,
				);
			}
		}
	} catch (error) {
		reasons.push(`${entry}: ${error instanceof Error ? error.message : String(error)}, and the archive holds none`);
	}
	if (reasons.length === 0) return undefined;
	if (labelled) {
		return (
			`${reasons.join("; ")}. A restore gives a new ${kind} the security label this system's policy gives it ` +
			`there, and nothing shows that is this one, so giving it up could lose its label; it was kept. On a host ` +
			`that labels every file, \`omp gc --reclaim\` keeps every session, and the archived copy is still there for ` +
			`\`omp gc --restore\``
		);
	}
	return (
		`${reasons.join("; ")}. Giving it up would lose that for good, so it was kept; change it if nothing needs it, ` +
		`and reclaim again`
	);
}
