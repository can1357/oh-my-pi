//! `--help`, `--version`, and daemon-mode help text (byte layout of rsync 3.5.1).
//!
//! The capability lines describe what this implementation supports; everything
//! else is the exact text the reference prints.

use crate::rsync::consts::{PROTOCOL_VERSION, SUBPROTOCOL_VERSION};

/// Program version reported everywhere.
pub(crate) const RSYNC_VERSION: &str = "3.5.1";
/// `--crtimes`/`-N` support (creation times can be set on macOS and Windows).
pub(crate) const SUPPORT_CRTIMES: bool = cfg!(any(target_os = "macos", windows));
/// `-A` support (no local ACLs on Windows).
pub(crate) const SUPPORT_ACLS: bool = cfg!(unix);
/// `-X` / `--fake-super` support (no local xattrs on Windows).
pub(crate) const SUPPORT_XATTRS: bool = cfg!(unix);
/// `--iconv` support (upstream ICONV_OPTION; no iconv on Windows).
pub(crate) const SUPPORT_ICONV: bool = cfg!(unix);
/// Device and special files exist (not on Windows).
const SUPPORT_SPECIALS: bool = cfg!(unix);
/// `--preallocate` support (the receiver never preallocates).
pub(crate) const SUPPORT_PREALLOCATION: bool = false;

const COPYRIGHT: &str = "(C) 1996-2026 by Andrew Tridgell, Wayne Davison, and others.";
const URL: &str = "https://rsync.samba.org/";

/// One `print_info_flags` entry: a section header or a capability word.
#[derive(Clone, Copy)]
enum Flag {
	Section(&'static str),
	Item(&'static str),
}

/// Capability and optimization words for this implementation, in upstream order.
fn info_flags() -> Vec<Flag> {
	use Flag::{Item, Section};
	vec![
		Section("Capabilities"),
		Item("64-bit files"),
		Item("64-bit inums"),
		Item("64-bit timestamps"),
		Item("64-bit long ints"),
		Item(if cfg!(unix) { "socketpairs" } else { "no socketpairs" }),
		Item("symlinks"),
		Item("symtimes"),
		Item("hardlinks"),
		Item(if SUPPORT_SPECIALS { "hardlink-specials" } else { "no hardlink-specials" }),
		Item("hardlink-symlinks"),
		Item("IPv6"),
		Item("atimes"),
		Item("batchfiles"),
		Item("inplace"),
		Item("append"),
		Item(if SUPPORT_ACLS { "ACLs" } else { "no ACLs" }),
		Item(if SUPPORT_XATTRS { "xattrs" } else { "no xattrs" }),
		Item("optional secluded-args"),
		Item(if SUPPORT_ICONV { "iconv" } else { "no iconv" }),
		Item(if SUPPORT_PREALLOCATION { "prealloc" } else { "no prealloc" }),
		Item("stop-at"),
		Item(if SUPPORT_CRTIMES { "crtimes" } else { "no crtimes" }),
		Item("no IDN"),
		Section("Optimizations"),
		Item("no SIMD-roll"),
		Item("no asm-roll"),
		Item("no openssl-crypto"),
		Item("no asm-MD5"),
	]
}

/// Negotiation lists shown by `--version`; parenthesized words are aliases.
const NNO_LISTS: [(&str, &str); 3] = [
	("Checksum list", "xxh128 xxh3 xxh64 (xxhash) md5 md4 sha1 none"),
	("Compress list", "zstd lz4 zlibx zlib none"),
	("Daemon auth list", "sha512 sha256 sha1 md5 md4"),
];

/// Width of upstream's line buffer: an item that would reach it starts a new line.
const LINE_BUF: usize = 75;

/// Text form of an info item (" word," or " word").
fn text_item(word: &str, comma: bool) -> String {
	format!(" {word}{}", if comma { "," } else { "" })
}

/// JSON form of an info item: `"name": value` with upstream's name mangling.
fn json_item(word: &str, comma: bool) -> String {
	let comma = if comma { "," } else { "" };
	let Some(space) = word.find(' ') else {
		return format!(" \"{}\": true{comma}", mangle(word));
	};
	let (head, tail) = (&word[..space], &word[space + 1..]);
	if head == "no" {
		return format!(" \"{}\": false{comma}", mangle(tail));
	}
	if head.starts_with(|c: char| c.is_ascii_digit()) {
		// "64-bit files" → "file_bits": 64
		let bits = head.split('-').next().unwrap_or(head);
		let mut name = mangle(tail);
		name.pop(); // drop the plural 's'
		return format!(" \"{name}_bits\": {bits}{comma}");
	}
	format!(" \"{}\": \"{head}\"{comma}", mangle(tail))
}

fn mangle(word: &str) -> String {
	word.chars().map(|c| if c == ' ' || c == '-' { '_' } else { c }).collect()
}

/// Renders the flag sections, wrapping items the way upstream fills its line buffer.
fn render_flags(flags: &[Flag], json: bool, out: &mut String) {
	let mut line = String::new();
	let mut in_section = false;
	for (i, flag) in flags.iter().enumerate() {
		let item = match *flag {
			Flag::Section(_) => None,
			Flag::Item(word) => {
				let comma = matches!(flags.get(i + 1), Some(Flag::Item(_)));
				Some(if json { json_item(word, comma) } else { text_item(word, comma) })
			}
		};
		let item_len = item.as_ref().map_or(1000, String::len);
		if !line.is_empty() && line.len() + item_len >= LINE_BUF {
			out.push_str("   ");
			out.push_str(&line);
			out.push('\n');
			line.clear();
		}
		match (flag, item) {
			(Flag::Section(name), _) => {
				if json {
					if in_section {
						out.push_str("  }");
					}
					let mut chars = name.chars();
					let first = chars.next().map(|c| c.to_ascii_lowercase()).unwrap_or(' ');
					out.push_str(&format!(",\n  \"{first}{}\": {{\n", chars.as_str()));
				} else {
					out.push_str(name);
					out.push_str(":\n");
				}
				in_section = true;
			}
			(Flag::Item(_), Some(item)) => line.push_str(&item),
			(Flag::Item(_), None) => {}
		}
	}
	if !line.is_empty() {
		out.push_str("   ");
		out.push_str(&line);
		out.push('\n');
	}
	if json && in_section {
		out.push_str("  }");
	}
}

/// `rsync --version` (also the head of `--help` and the usage error text).
pub(crate) fn version_text() -> String {
	version_text_with(&info_flags())
}

fn version_text_with(flags: &[Flag]) -> String {
	let mut out = format!(
		"rsync  version {RSYNC_VERSION}  protocol version {PROTOCOL_VERSION}\nCopyright {COPYRIGHT}\nWeb site: {URL}\n"
	);
	render_flags(flags, false, &mut out);
	for (name, list) in NNO_LISTS {
		out.push_str(&format!("{name}:\n    {list}\n"));
	}
	out.push_str(concat!(
		"\n",
		"rsync comes with ABSOLUTELY NO WARRANTY.  This is free software, and you\n",
		"are welcome to redistribute it under certain conditions.  See the GNU\n",
		"General Public Licence for details.\n",
	));
	out
}

/// `rsync -VV` (two or more `--version` on the client): the JSON form on stdout.
pub(crate) fn version_json_text() -> String {
	version_json_with(&info_flags())
}

fn version_json_with(flags: &[Flag]) -> String {
	let mut out = String::new();
	let protocol = format!("{PROTOCOL_VERSION}.{SUBPROTOCOL_VERSION}");
	let fields = [
		("program", "rsync"),
		("version", RSYNC_VERSION),
		("protocol", protocol.as_str()),
		("copyright", COPYRIGHT),
		("url", URL),
	];
	for (i, (name, value)) in fields.iter().enumerate() {
		out.push_str(&format!("{}\n  \"{name}\": \"{value}\"", if i == 0 { '{' } else { ',' }));
	}
	render_flags(flags, true, &mut out);
	for (name, list) in NNO_LISTS {
		let key = name.to_ascii_lowercase().replace(' ', "_");
		out.push_str(&format!(",\n  \"{key}\": [\n   "));
		let words: Vec<&str> = list.split(' ').filter(|w| !w.starts_with('(')).collect();
		for (i, word) in words.iter().enumerate() {
			let comma = if i + 1 < words.len() { "," } else { "" };
			out.push_str(&format!(" \"{word}\"{comma}"));
		}
		out.push_str("\n  ]");
	}
	out.push_str(",\n  \"license\": \"GPLv3\"");
	out.push_str(",\n  \"caveat\": \"rsync comes with ABSOLUTELY NO WARRANTY\"");
	out.push_str("\n}\n");
	out
}

/// `rsync --help` (stdout, exit 0) and the usage text printed on syntax errors.
pub(crate) fn help_text() -> String {
	let mut out = version_text();
	out.push_str(HELP_INTRO);
	out.push_str(HELP_OPTIONS);
	out.push_str(HELP_OUTRO);
	out
}

/// `rsync --daemon --help`.
pub(crate) fn daemon_help_text() -> String {
	let mut out = version_text();
	out.push_str("\nUsage: rsync --daemon [OPTION]...\n");
	out.push_str(DAEMON_OPTIONS);
	out.push_str(concat!(
		"\n",
		"If you were not trying to invoke rsync as a daemon, avoid using any of the\n",
		"daemon-specific rsync options.  See also the rsyncd.conf(5) manpage.\n",
	));
	out
}

const HELP_INTRO: &str = concat!(
	"\n",
	"rsync is a file transfer program capable of efficient remote update\n",
	"via a fast differencing algorithm.\n",
	"\n",
	"Usage: rsync [OPTION]... SRC [SRC]... DEST\n",
	"  or   rsync [OPTION]... SRC [SRC]... [USER@]HOST:DEST\n",
	"  or   rsync [OPTION]... SRC [SRC]... [USER@]HOST::DEST\n",
	"  or   rsync [OPTION]... SRC [SRC]... rsync://[USER@]HOST[:PORT]/DEST\n",
	"  or   rsync [OPTION]... [USER@]HOST:SRC [DEST]\n",
	"  or   rsync [OPTION]... [USER@]HOST::SRC [DEST]\n",
	"  or   rsync [OPTION]... rsync://[USER@]HOST[:PORT]/SRC [DEST]\n",
	"The ':' usages connect via remote shell, while '::' & 'rsync://' usages connect\n",
	"to an rsync daemon, and require SRC or DEST to start with a module name.\n",
	"\n",
	"Options\n",
);

const HELP_OUTRO: &str = concat!(
	"\n",
	"Use \"rsync --daemon --help\" to see the daemon-mode command-line options.\n",
	"Please see the rsync(1) and rsyncd.conf(5) manpages for full documentation.\n",
	"See https://rsync.samba.org/ for updates, bug reports, and answers\n",
);

const HELP_OPTIONS: &str = r#"--verbose, -v            increase verbosity
--info=FLAGS             fine-grained informational verbosity
--debug=FLAGS            fine-grained debug verbosity
--stderr=e|a|c           change stderr output mode (default: errors)
--quiet, -q              suppress non-error messages
--no-motd                suppress daemon-mode MOTD
--checksum, -c           skip based on checksum, not mod-time & size
--archive, -a            archive mode is -rlptgoD (no -A,-X,-U,-N,-H)
--no-OPTION              turn off an implied OPTION (e.g. --no-D)
--recursive, -r          recurse into directories
--inc-recursive, --i-r   enable incremental recursion
--no-inc-recursive       disable incremental recursion
--no-i-r                 same as --no-inc-recursive
--relative, -R           use relative path names
--no-implied-dirs        don't send implied directories with --relative
--backup, -b             make backups (see --suffix & --backup-dir)
--backup-dir=DIR         make backups into hierarchy based in DIR
--suffix=SUFFIX          backup suffix (default ~ w/o --backup-dir)
--update, -u             skip files that are newer on the receiver
--inplace                update destination files in-place
--append                 append data onto shorter files
--append-verify          --append w/old data in file checksum
--dirs, -d               transfer directories without recursing
--old-dirs               works like --dirs when talking to old rsync
--old-d                  same as --old-dirs
--mkpath                 create destination's missing path components
--links, -l              copy symlinks as symlinks
--copy-links, -L         transform symlink into referent file/directory
--copy-unsafe-links      only "unsafe" symlinks are transformed
--safe-links             ignore symlinks that point outside the tree
--insecure-links         follow attacker-owned symlinks in operator paths
--confine-root=DIR       refuse operator paths resolving outside DIR
--munge-links            munge symlinks to make them safe & unusable
--copy-dirlinks, -k      transform symlink to directory into referent directory
--keep-dirlinks, -K      treat symlinked directory on receiver as directory
--hard-links, -H         preserve hard links
--perms, -p              preserve permissions
--executability, -E      preserve executability
--chmod=CHMOD            affect file and/or directory permissions
--acls, -A               preserve ACLs (implies --perms)
--xattrs, -X             preserve extended attributes
--owner, -o              preserve owner (super-user only)
--group, -g              preserve group
--devices                preserve device files (super-user only)
--copy-devices           copy device contents as a regular file
--write-devices          write to devices as files (implies --inplace)
--specials               preserve special files
--drop-D                 receiver refuses to create devices/specials
-D                       same as --devices --specials
--times, -t              preserve modification times
--atimes, -U             preserve access (use) times
--open-noatime           avoid changing the atime on opened files
--crtimes, -N            preserve create times (newness)
--omit-dir-times, -O     omit directories from --times
--omit-link-times, -J    omit symlinks from --times
--super                  receiver attempts super-user activities
--fake-super             store/recover privileged attrs using xattrs
--sparse, -S             turn sequences of nulls into sparse blocks
--preallocate            allocate dest files before writing them
--dry-run, -n            perform a trial run with no changes made
--whole-file, -W         copy files whole (w/o delta-xfer algorithm)
--no-whole-file, --no-W  use the delta-xfer algorithm
--checksum-choice=STR    choose the checksum algorithm (aka --cc)
--one-file-system, -x    don't cross filesystem boundaries
--block-size=SIZE, -B    force a fixed checksum block-size
--rsh=COMMAND, -e        specify the remote shell to use
--rsync-path=PROGRAM     specify the rsync to run on remote machine
--existing               skip creating new files on receiver
--ignore-non-existing    skip creating new files on receiver
--ignore-existing        skip updating files that exist on receiver
--remove-source-files    sender removes synchronized files (non-directory)
--del                    an alias for --delete-during
--delete                 delete extraneous files from dest directories
--delete-before          receiver deletes before xfer, not during
--delete-during          receiver deletes during the transfer
--delete-delay           find deletions during, delete after
--delete-after           receiver deletes after transfer, not during
--delete-excluded        also delete excluded files from dest directories
--ignore-missing-args    ignore missing source arguments without error
--delete-missing-args    delete missing source arguments from destination
--ignore-errors          delete even if there are I/O errors
--force                  force deletion of directories even if not empty
--max-delete=NUM         don't delete more than NUM files
--max-size=SIZE          don't transfer any file larger than SIZE
--min-size=SIZE          don't transfer any file smaller than SIZE
--max-alloc=SIZE         change a limit relating to memory alloc
--partial                keep partially transferred files
--partial-dir=DIR        put a partially transferred file into DIR
--delay-updates          put all updated files into place at end
--prune-empty-dirs, -m   prune empty directory chains from file-list
--numeric-ids            don't map uid/gid values by user/group name
--usermap=STRING         custom username mapping
--groupmap=STRING        custom groupname mapping
--chown=USER:GROUP       simple username/groupname mapping
--timeout=SECONDS        set I/O timeout in seconds
--contimeout=SECONDS     set daemon connection timeout in seconds
--ignore-times, -I       don't skip files that match size and time
--size-only              skip files that match in size
--modify-window=NUM, -@  set the accuracy for mod-time comparisons
--temp-dir=DIR, -T       create temporary files in directory DIR
--fuzzy, -y              find similar file for basis if no dest file
--compare-dest=DIR       also compare destination files relative to DIR
--copy-dest=DIR          ... and include copies of unchanged files
--link-dest=DIR          hardlink to files in DIR when unchanged
--compress, -z           compress file data during the transfer
--compress-choice=STR    choose the compression algorithm (aka --zc)
--compress-level=NUM     explicitly set compression level (aka --zl)
--compress-threads=NUM   explicitly set compression threads (aka --zt)
--skip-compress=LIST     skip compressing files with suffix in LIST
--cvs-exclude, -C        auto-ignore files in the same way CVS does
--filter=RULE, -f        add a file-filtering RULE
-F                       same as --filter='dir-merge /.rsync-filter'
                         repeated: --filter='- .rsync-filter'
--exclude=PATTERN        exclude files matching PATTERN
--exclude-from=FILE      read exclude patterns from FILE
--include=PATTERN        don't exclude files matching PATTERN
--include-from=FILE      read include patterns from FILE
--files-from=FILE        read list of source-file names from FILE
--from0, -0              all *-from/filter files are delimited by 0s
--old-args               disable the modern argument-protection idiom
--secluded-args, -s      use the protocol to safely send the arguments
--trust-sender           trust the remote sender's file list
--copy-as=USER[:GROUP]   specify user & optional group for the copy
--address=ADDRESS        bind address for outgoing socket to daemon
--port=PORT              specify double-colon alternate port number
--sockopts=OPTIONS       specify custom TCP options
--blocking-io            use blocking I/O for the remote shell
--outbuf=N|L|B           set out buffering to None, Line, or Block
--stats                  give some file-transfer stats
--8-bit-output, -8       leave high-bit chars unescaped in output
--human-readable, -h     output numbers in a human-readable format
--progress               show progress during transfer
-P                       same as --partial --progress
--itemize-changes, -i    output a change-summary for all updates
--remote-option=OPT, -M  send OPTION to the remote side only
--out-format=FORMAT      output updates using the specified FORMAT
--log-file=FILE          log what we're doing to the specified FILE
--log-file-format=FMT    log updates using the specified FMT
--password-file=FILE     read daemon-access password from FILE
--early-input=FILE       use FILE for daemon's early exec input
--list-only              list the files instead of copying them
--bwlimit=RATE           limit socket I/O bandwidth
--stop-after=MINS        Stop rsync after MINS minutes have elapsed
--stop-at=y-m-dTh:m      Stop rsync at the specified point in time
--fsync                  fsync every written file
--write-batch=FILE       write a batched update to FILE
--only-write-batch=FILE  like --write-batch but w/o updating dest
--read-batch=FILE        read a batched update from FILE
--protocol=NUM           force an older protocol version to be used
--iconv=CONVERT_SPEC     request charset conversion of filenames
--checksum-seed=NUM      set block/file checksum seed (advanced)
--ipv4, -4               prefer IPv4
--ipv6, -6               prefer IPv6
--version, -V            print the version + other info and exit
--help, -h (*)           show this help (* -h is help only on its own)
"#;

const DAEMON_OPTIONS: &str = r#"--daemon                 run as an rsync daemon
--address=ADDRESS        bind to the specified address
--bwlimit=RATE           limit socket I/O bandwidth
--config=FILE            specify alternate rsyncd.conf file
--dparam=OVERRIDE, -M    override global daemon config parameter
--no-detach              do not detach from the parent
--port=PORT              listen on alternate port number
--log-file=FILE          override the "log file" setting
--log-file-format=FMT    override the "log format" setting
--sockopts=OPTIONS       specify custom TCP options
--verbose, -v            increase verbosity
--ipv4, -4               prefer IPv4
--ipv6, -6               prefer IPv6
--help, -h               show this help (when used with --daemon)
"#;

#[cfg(test)]
mod tests {
	use super::*;

	/// The flag words of the reference build (homebrew rsync 3.5.1 on macOS).
	fn reference_flags() -> Vec<Flag> {
		let mut flags = info_flags();
		for flag in &mut flags {
			if let Flag::Item(word) = flag {
				*word = match *word {
					"no IDN" => "IDN",
					"no openssl-crypto" => "openssl-crypto",
					"no crtimes" => "crtimes",
					"no socketpairs" => "socketpairs",
					"no hardlink-specials" => "hardlink-specials",
					"no ACLs" => "ACLs",
					"no xattrs" => "xattrs",
					"no iconv" => "iconv",
					other => other,
				};
			}
		}
		flags
	}

	const REF_VERSION: &str = r#"rsync  version 3.5.1  protocol version 33
Copyright (C) 1996-2026 by Andrew Tridgell, Wayne Davison, and others.
Web site: https://rsync.samba.org/
Capabilities:
    64-bit files, 64-bit inums, 64-bit timestamps, 64-bit long ints,
    socketpairs, symlinks, symtimes, hardlinks, hardlink-specials,
    hardlink-symlinks, IPv6, atimes, batchfiles, inplace, append, ACLs,
    xattrs, optional secluded-args, iconv, no prealloc, stop-at, crtimes, IDN
Optimizations:
    no SIMD-roll, no asm-roll, openssl-crypto, no asm-MD5
Checksum list:
    xxh128 xxh3 xxh64 (xxhash) md5 md4 sha1 none
Compress list:
    zstd lz4 zlibx zlib none
Daemon auth list:
    sha512 sha256 sha1 md5 md4

rsync comes with ABSOLUTELY NO WARRANTY.  This is free software, and you
are welcome to redistribute it under certain conditions.  See the GNU
General Public Licence for details.
"#;

	const REF_JSON: &str = r#"{
  "program": "rsync",
  "version": "3.5.1",
  "protocol": "33.0",
  "copyright": "(C) 1996-2026 by Andrew Tridgell, Wayne Davison, and others.",
  "url": "https://rsync.samba.org/",
  "capabilities": {
    "file_bits": 64, "inum_bits": 64, "timestamp_bits": 64,
    "long_int_bits": 64, "socketpairs": true, "symlinks": true,
    "symtimes": true, "hardlinks": true, "hardlink_specials": true,
    "hardlink_symlinks": true, "IPv6": true, "atimes": true,
    "batchfiles": true, "inplace": true, "append": true, "ACLs": true,
    "xattrs": true, "secluded_args": "optional", "iconv": true,
    "prealloc": false, "stop_at": true, "crtimes": true, "IDN": true
  },
  "optimizations": {
    "SIMD_roll": false, "asm_roll": false, "openssl_crypto": true,
    "asm_MD5": false
  },
  "checksum_list": [
    "xxh128", "xxh3", "xxh64", "md5", "md4", "sha1", "none"
  ],
  "compress_list": [
    "zstd", "lz4", "zlibx", "zlib", "none"
  ],
  "daemon_auth_list": [
    "sha512", "sha256", "sha1", "md5", "md4"
  ],
  "license": "GPLv3",
  "caveat": "rsync comes with ABSOLUTELY NO WARRANTY"
}
"#;

	const REF_HELP: &str = r#"rsync  version 3.5.1  protocol version 33
Copyright (C) 1996-2026 by Andrew Tridgell, Wayne Davison, and others.
Web site: https://rsync.samba.org/
Capabilities:
    64-bit files, 64-bit inums, 64-bit timestamps, 64-bit long ints,
    socketpairs, symlinks, symtimes, hardlinks, hardlink-specials,
    hardlink-symlinks, IPv6, atimes, batchfiles, inplace, append, ACLs,
    xattrs, optional secluded-args, iconv, no prealloc, stop-at, crtimes, IDN
Optimizations:
    no SIMD-roll, no asm-roll, openssl-crypto, no asm-MD5
Checksum list:
    xxh128 xxh3 xxh64 (xxhash) md5 md4 sha1 none
Compress list:
    zstd lz4 zlibx zlib none
Daemon auth list:
    sha512 sha256 sha1 md5 md4

rsync comes with ABSOLUTELY NO WARRANTY.  This is free software, and you
are welcome to redistribute it under certain conditions.  See the GNU
General Public Licence for details.

rsync is a file transfer program capable of efficient remote update
via a fast differencing algorithm.

Usage: rsync [OPTION]... SRC [SRC]... DEST
  or   rsync [OPTION]... SRC [SRC]... [USER@]HOST:DEST
  or   rsync [OPTION]... SRC [SRC]... [USER@]HOST::DEST
  or   rsync [OPTION]... SRC [SRC]... rsync://[USER@]HOST[:PORT]/DEST
  or   rsync [OPTION]... [USER@]HOST:SRC [DEST]
  or   rsync [OPTION]... [USER@]HOST::SRC [DEST]
  or   rsync [OPTION]... rsync://[USER@]HOST[:PORT]/SRC [DEST]
The ':' usages connect via remote shell, while '::' & 'rsync://' usages connect
to an rsync daemon, and require SRC or DEST to start with a module name.

Options
--verbose, -v            increase verbosity
--info=FLAGS             fine-grained informational verbosity
--debug=FLAGS            fine-grained debug verbosity
--stderr=e|a|c           change stderr output mode (default: errors)
--quiet, -q              suppress non-error messages
--no-motd                suppress daemon-mode MOTD
--checksum, -c           skip based on checksum, not mod-time & size
--archive, -a            archive mode is -rlptgoD (no -A,-X,-U,-N,-H)
--no-OPTION              turn off an implied OPTION (e.g. --no-D)
--recursive, -r          recurse into directories
--inc-recursive, --i-r   enable incremental recursion
--no-inc-recursive       disable incremental recursion
--no-i-r                 same as --no-inc-recursive
--relative, -R           use relative path names
--no-implied-dirs        don't send implied directories with --relative
--backup, -b             make backups (see --suffix & --backup-dir)
--backup-dir=DIR         make backups into hierarchy based in DIR
--suffix=SUFFIX          backup suffix (default ~ w/o --backup-dir)
--update, -u             skip files that are newer on the receiver
--inplace                update destination files in-place
--append                 append data onto shorter files
--append-verify          --append w/old data in file checksum
--dirs, -d               transfer directories without recursing
--old-dirs               works like --dirs when talking to old rsync
--old-d                  same as --old-dirs
--mkpath                 create destination's missing path components
--links, -l              copy symlinks as symlinks
--copy-links, -L         transform symlink into referent file/directory
--copy-unsafe-links      only "unsafe" symlinks are transformed
--safe-links             ignore symlinks that point outside the tree
--insecure-links         follow attacker-owned symlinks in operator paths
--confine-root=DIR       refuse operator paths resolving outside DIR
--munge-links            munge symlinks to make them safe & unusable
--copy-dirlinks, -k      transform symlink to directory into referent directory
--keep-dirlinks, -K      treat symlinked directory on receiver as directory
--hard-links, -H         preserve hard links
--perms, -p              preserve permissions
--executability, -E      preserve executability
--chmod=CHMOD            affect file and/or directory permissions
--acls, -A               preserve ACLs (implies --perms)
--xattrs, -X             preserve extended attributes
--owner, -o              preserve owner (super-user only)
--group, -g              preserve group
--devices                preserve device files (super-user only)
--copy-devices           copy device contents as a regular file
--write-devices          write to devices as files (implies --inplace)
--specials               preserve special files
--drop-D                 receiver refuses to create devices/specials
-D                       same as --devices --specials
--times, -t              preserve modification times
--atimes, -U             preserve access (use) times
--open-noatime           avoid changing the atime on opened files
--crtimes, -N            preserve create times (newness)
--omit-dir-times, -O     omit directories from --times
--omit-link-times, -J    omit symlinks from --times
--super                  receiver attempts super-user activities
--fake-super             store/recover privileged attrs using xattrs
--sparse, -S             turn sequences of nulls into sparse blocks
--preallocate            allocate dest files before writing them
--dry-run, -n            perform a trial run with no changes made
--whole-file, -W         copy files whole (w/o delta-xfer algorithm)
--no-whole-file, --no-W  use the delta-xfer algorithm
--checksum-choice=STR    choose the checksum algorithm (aka --cc)
--one-file-system, -x    don't cross filesystem boundaries
--block-size=SIZE, -B    force a fixed checksum block-size
--rsh=COMMAND, -e        specify the remote shell to use
--rsync-path=PROGRAM     specify the rsync to run on remote machine
--existing               skip creating new files on receiver
--ignore-non-existing    skip creating new files on receiver
--ignore-existing        skip updating files that exist on receiver
--remove-source-files    sender removes synchronized files (non-directory)
--del                    an alias for --delete-during
--delete                 delete extraneous files from dest directories
--delete-before          receiver deletes before xfer, not during
--delete-during          receiver deletes during the transfer
--delete-delay           find deletions during, delete after
--delete-after           receiver deletes after transfer, not during
--delete-excluded        also delete excluded files from dest directories
--ignore-missing-args    ignore missing source arguments without error
--delete-missing-args    delete missing source arguments from destination
--ignore-errors          delete even if there are I/O errors
--force                  force deletion of directories even if not empty
--max-delete=NUM         don't delete more than NUM files
--max-size=SIZE          don't transfer any file larger than SIZE
--min-size=SIZE          don't transfer any file smaller than SIZE
--max-alloc=SIZE         change a limit relating to memory alloc
--partial                keep partially transferred files
--partial-dir=DIR        put a partially transferred file into DIR
--delay-updates          put all updated files into place at end
--prune-empty-dirs, -m   prune empty directory chains from file-list
--numeric-ids            don't map uid/gid values by user/group name
--usermap=STRING         custom username mapping
--groupmap=STRING        custom groupname mapping
--chown=USER:GROUP       simple username/groupname mapping
--timeout=SECONDS        set I/O timeout in seconds
--contimeout=SECONDS     set daemon connection timeout in seconds
--ignore-times, -I       don't skip files that match size and time
--size-only              skip files that match in size
--modify-window=NUM, -@  set the accuracy for mod-time comparisons
--temp-dir=DIR, -T       create temporary files in directory DIR
--fuzzy, -y              find similar file for basis if no dest file
--compare-dest=DIR       also compare destination files relative to DIR
--copy-dest=DIR          ... and include copies of unchanged files
--link-dest=DIR          hardlink to files in DIR when unchanged
--compress, -z           compress file data during the transfer
--compress-choice=STR    choose the compression algorithm (aka --zc)
--compress-level=NUM     explicitly set compression level (aka --zl)
--compress-threads=NUM   explicitly set compression threads (aka --zt)
--skip-compress=LIST     skip compressing files with suffix in LIST
--cvs-exclude, -C        auto-ignore files in the same way CVS does
--filter=RULE, -f        add a file-filtering RULE
-F                       same as --filter='dir-merge /.rsync-filter'
                         repeated: --filter='- .rsync-filter'
--exclude=PATTERN        exclude files matching PATTERN
--exclude-from=FILE      read exclude patterns from FILE
--include=PATTERN        don't exclude files matching PATTERN
--include-from=FILE      read include patterns from FILE
--files-from=FILE        read list of source-file names from FILE
--from0, -0              all *-from/filter files are delimited by 0s
--old-args               disable the modern argument-protection idiom
--secluded-args, -s      use the protocol to safely send the arguments
--trust-sender           trust the remote sender's file list
--copy-as=USER[:GROUP]   specify user & optional group for the copy
--address=ADDRESS        bind address for outgoing socket to daemon
--port=PORT              specify double-colon alternate port number
--sockopts=OPTIONS       specify custom TCP options
--blocking-io            use blocking I/O for the remote shell
--outbuf=N|L|B           set out buffering to None, Line, or Block
--stats                  give some file-transfer stats
--8-bit-output, -8       leave high-bit chars unescaped in output
--human-readable, -h     output numbers in a human-readable format
--progress               show progress during transfer
-P                       same as --partial --progress
--itemize-changes, -i    output a change-summary for all updates
--remote-option=OPT, -M  send OPTION to the remote side only
--out-format=FORMAT      output updates using the specified FORMAT
--log-file=FILE          log what we're doing to the specified FILE
--log-file-format=FMT    log updates using the specified FMT
--password-file=FILE     read daemon-access password from FILE
--early-input=FILE       use FILE for daemon's early exec input
--list-only              list the files instead of copying them
--bwlimit=RATE           limit socket I/O bandwidth
--stop-after=MINS        Stop rsync after MINS minutes have elapsed
--stop-at=y-m-dTh:m      Stop rsync at the specified point in time
--fsync                  fsync every written file
--write-batch=FILE       write a batched update to FILE
--only-write-batch=FILE  like --write-batch but w/o updating dest
--read-batch=FILE        read a batched update from FILE
--protocol=NUM           force an older protocol version to be used
--iconv=CONVERT_SPEC     request charset conversion of filenames
--checksum-seed=NUM      set block/file checksum seed (advanced)
--ipv4, -4               prefer IPv4
--ipv6, -6               prefer IPv6
--version, -V            print the version + other info and exit
--help, -h (*)           show this help (* -h is help only on its own)

Use "rsync --daemon --help" to see the daemon-mode command-line options.
Please see the rsync(1) and rsyncd.conf(5) manpages for full documentation.
See https://rsync.samba.org/ for updates, bug reports, and answers
"#;

	const REF_DAEMON_HELP: &str = r#"rsync  version 3.5.1  protocol version 33
Copyright (C) 1996-2026 by Andrew Tridgell, Wayne Davison, and others.
Web site: https://rsync.samba.org/
Capabilities:
    64-bit files, 64-bit inums, 64-bit timestamps, 64-bit long ints,
    socketpairs, symlinks, symtimes, hardlinks, hardlink-specials,
    hardlink-symlinks, IPv6, atimes, batchfiles, inplace, append, ACLs,
    xattrs, optional secluded-args, iconv, no prealloc, stop-at, crtimes, IDN
Optimizations:
    no SIMD-roll, no asm-roll, openssl-crypto, no asm-MD5
Checksum list:
    xxh128 xxh3 xxh64 (xxhash) md5 md4 sha1 none
Compress list:
    zstd lz4 zlibx zlib none
Daemon auth list:
    sha512 sha256 sha1 md5 md4

rsync comes with ABSOLUTELY NO WARRANTY.  This is free software, and you
are welcome to redistribute it under certain conditions.  See the GNU
General Public Licence for details.

Usage: rsync --daemon [OPTION]...
--daemon                 run as an rsync daemon
--address=ADDRESS        bind to the specified address
--bwlimit=RATE           limit socket I/O bandwidth
--config=FILE            specify alternate rsyncd.conf file
--dparam=OVERRIDE, -M    override global daemon config parameter
--no-detach              do not detach from the parent
--port=PORT              listen on alternate port number
--log-file=FILE          override the "log file" setting
--log-file-format=FMT    override the "log format" setting
--sockopts=OPTIONS       specify custom TCP options
--verbose, -v            increase verbosity
--ipv4, -4               prefer IPv4
--ipv6, -6               prefer IPv6
--help, -h               show this help (when used with --daemon)

If you were not trying to invoke rsync as a daemon, avoid using any of the
daemon-specific rsync options.  See also the rsyncd.conf(5) manpage.
"#;

	#[test]
	fn version_layout_matches_reference_for_reference_flags() {
		assert_eq!(version_text_with(&reference_flags()), REF_VERSION);
	}

	#[test]
	fn json_layout_matches_reference_for_reference_flags() {
		assert_eq!(version_json_with(&reference_flags()), REF_JSON);
	}

	#[test]
	fn help_matches_reference_after_version_block() {
		let ours = help_text();
		let version = version_text();
		assert!(ours.starts_with(&version));
		assert_eq!(&ours[version.len()..], &REF_HELP[REF_VERSION.len()..]);
	}

	#[test]
	fn daemon_help_matches_reference_after_version_block() {
		let ours = daemon_help_text();
		assert_eq!(&ours[version_text().len()..], &REF_DAEMON_HELP[REF_VERSION.len()..]);
	}

	#[test]
	fn our_capabilities_wrap_and_say_what_we_lack() {
		let text = version_text();
		assert!(text.starts_with("rsync  version 3.5.1  protocol version 33\n"));
		assert!(text.contains("no IDN\n"));
		assert!(text.contains("Optimizations:\n    no SIMD-roll, no asm-roll, no openssl-crypto, no asm-MD5\n"));
		assert!(text.contains("Checksum list:\n    xxh128 xxh3 xxh64 (xxhash) md5 md4 sha1 none\n"));
		for line in text.lines() {
			assert!(line.len() < 3 + LINE_BUF, "{line}");
		}
		let json = version_json_text();
		assert!(json.contains("\"IDN\": false"));
		assert!(json.contains("\"openssl_crypto\": false"));
		assert!(json.ends_with("\n}\n"));
	}
}
