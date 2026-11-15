//! pi's in-process extras for the embedded shell: the uutils-style utilities
//! (`cat`, `grep`, `sed`, `ls`, …) and the process builtins (`ps`, `top`,
//! `sleep`, `pgrep`, `pkill`, `pidwait`, `lsof`). Hosts run them through
//! [`extras`].
#![cfg_attr(unix, feature(process_setsid))]

/// Atomic whole-file replacement behind `sponge FILE` and `sd`'s in-place edits.
#[cfg(any(feature = "util.sd", feature = "util.sponge"))]
mod atomic_write;
/// Output block sizes for `du` and `df`.
#[cfg(any(feature = "util.du", feature = "util.df"))]
mod block_size;
mod duration;
pub mod extras;
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
mod file_backup;
#[cfg(any(feature = "util.ls", feature = "util.stat", feature = "util.find"))]
mod fsmeta;
mod host;
#[cfg(unix)]
pub use host::read_process_umask;
mod openfile;
mod stdio;
/// The shell's locale categories, shared by the locale-aware utilities.
#[cfg(any(
	feature = "util.date",
	feature = "util.df",
	feature = "util.du",
	feature = "util.env",
	feature = "util.fold",
	feature = "util.sort",
	feature = "util.uniq"
))]
mod locale;
/// GNU `QUOTING_STYLE` names, shared by the utilities that honor them.
#[cfg(any(feature = "util.du", feature = "util.env"))]
mod quoting_style;
/// The shell's `TZ`, shared by the utilities that print local times.
#[cfg(any(
	feature = "util.awk",
	feature = "util.date",
	feature = "util.du",
	feature = "util.ls",
	feature = "util.rsync",
	feature = "util.tar",
	feature = "util.touch",
	feature = "util.uptime"
))]
mod time_zone;
#[cfg(any(feature = "util.cp", feature = "util.mv"))]
mod progress;

// ── Utility builtins ──────────────────────────────────────────────────────────
// Ports of the standalone command-line utilities the shell ships in-process.
// Each runs against the explicit `host::Host` view of the shell; see
// `src/host.rs` for the contract.
#[cfg(feature = "util.ast-grep")]
mod ast_grep;
#[cfg(feature = "util.awk")]
mod awk;
#[cfg(feature = "util.b2sum")]
mod b2sum;
#[cfg(feature = "util.base32")]
mod base32;
#[cfg(feature = "util.base64")]
mod base64;
#[cfg(feature = "util.basename")]
mod basename;
/// Shared POSIX basic-regular-expression translation behind `grep`, `sed`,
/// and `nl`.
#[cfg(feature = "util.bre")]
mod bre;
#[cfg(feature = "util.cat")]
mod cat;
/// The `cksum` builtin plus the shared checksum machinery behind `md5sum`,
/// `sha*sum`, and `b2sum`.
#[cfg(feature = "util.cksum")]
mod cksum;
#[cfg(feature = "util.md5")]
mod md5;
#[cfg(feature = "util.md5sum")]
mod md5sum;
#[cfg(feature = "util.sha1sum")]
mod sha1sum;
#[cfg(feature = "util.sha224sum")]
mod sha224sum;
#[cfg(feature = "util.sha256sum")]
mod sha256sum;
#[cfg(feature = "util.sha384sum")]
mod sha384sum;
#[cfg(feature = "util.sha512sum")]
mod sha512sum;
#[cfg(feature = "util.shasum")]
mod shasum;
#[cfg(all(feature = "util.chmod", unix))]
mod chmod;
#[cfg(feature = "util.cmp")]
mod cmp;
#[cfg(feature = "util.comm")]
mod comm;
#[cfg(feature = "util.cp")]
mod cp;
#[cfg(feature = "util.combine")]
mod combine;
#[cfg(feature = "util.cut")]
mod cut;
#[cfg(feature = "util.date")]
mod date;
#[cfg(feature = "util.dd")]
mod dd;
#[cfg(feature = "util.df")]
mod df;
#[cfg(feature = "util.diff")]
mod diff;
#[cfg(feature = "util.dirname")]
mod dirname;
#[cfg(feature = "util.du")]
mod du;
#[cfg(feature = "util.env")]
mod env;
#[cfg(all(feature = "util.errno", unix))]
mod errno;
#[cfg(feature = "util.fd")]
mod fd;
#[cfg(feature = "util.find")]
mod find;
#[cfg(feature = "util.fold")]
mod fold;
#[cfg(feature = "util.grep")]
mod grep;
#[cfg(feature = "util.head")]
mod head;
#[cfg(feature = "util.hostname")]
mod hostname;
#[cfg(all(feature = "util.id", unix))]
mod id;
#[cfg(feature = "util.ifne")]
mod ifne;
#[cfg(feature = "util.isutf8")]
mod isutf8;
#[cfg(feature = "util.jq")]
mod jq;
#[cfg(feature = "util.ln")]
mod ln;
#[cfg(feature = "util.ls")]
mod ls;
#[cfg(all(
	feature = "util.lsof",
	any(target_os = "linux", target_os = "macos", target_os = "windows")
))]
mod lsof;
#[cfg(feature = "util.mkdir")]
mod mkdir;
#[cfg(feature = "util.mktemp")]
mod mktemp;
#[cfg(feature = "util.mv")]
mod mv;
#[cfg(feature = "util.nl")]
mod nl;
#[cfg(feature = "util.nproc")]
mod nproc;
#[cfg(feature = "util.od")]
mod od;
#[cfg(feature = "util.paste")]
mod paste;
#[cfg(feature = "util.pgrep")]
mod pgrep;
#[cfg(feature = "util.pidwait")]
mod pidwait;
#[cfg(feature = "util.pkill")]
mod pkill;
/// Shared process-matching engine behind `pgrep`, `pkill`, and `pidwait`.
#[cfg(feature = "util.proc-match")]
mod proc_match;
/// Process selector lists shared by `ps` and the process-matching engine.
#[cfg(any(feature = "util.ps", feature = "util.proc-match"))]
mod proc_select;
/// Shared process-table snapshot behind the process builtins.
#[cfg(feature = "util.procs")]
mod proc_snapshot;
#[cfg(feature = "util.ps")]
mod ps;
#[cfg(feature = "util.sleep")]
mod sleep;
#[cfg(feature = "util.top")]
mod top;
#[cfg(feature = "util.printenv")]
mod printenv;
#[cfg(feature = "util.readlink")]
mod readlink;
#[cfg(feature = "util.realpath")]
mod realpath;
#[cfg(feature = "util.rg")]
mod rg;
#[cfg(feature = "util.rm")]
mod rm;
#[cfg(feature = "util.rmdir")]
mod rmdir;
#[cfg(all(feature = "util.rsync", any(unix, windows)))]
mod rsync;
#[cfg(feature = "util.sd")]
mod sd;
#[cfg(feature = "util.sed")]
mod sed;
#[cfg(feature = "util.seq")]
mod seq;
#[cfg(feature = "util.sort")]
mod sort;
#[cfg(feature = "util.sponge")]
mod sponge;
#[cfg(feature = "util.stat")]
mod stat;
#[cfg(feature = "util.strings")]
mod strings;
#[cfg(feature = "util.tac")]
mod tac;
#[cfg(feature = "util.tail")]
mod tail;
#[cfg(all(feature = "util.tar", any(unix, windows)))]
mod tar;
#[cfg(feature = "util.tee")]
mod tee;
#[cfg(feature = "util.touch")]
mod touch;
#[cfg(feature = "util.tr")]
mod tr;
#[cfg(feature = "util.truncate")]
mod truncate;
#[cfg(feature = "util.ts")]
mod ts;
#[cfg(feature = "util.uname")]
mod uname;
#[cfg(feature = "util.uniq")]
mod uniq;
#[cfg(feature = "util.uptime")]
mod uptime;
#[cfg(feature = "util.wc")]
mod wc;
#[cfg(feature = "util.which")]
mod which;
#[cfg(feature = "util.whoami")]
mod whoami;
#[cfg(feature = "util.xargs")]
mod xargs;
#[cfg(feature = "util.yes")]
mod yes;

pub use duration::parse_duration;
pub use host::{panic_scope_active, rayon_global_pool_available, set_rayon_global_pool_available};
/// The process table the process builtins read, and the liveness state of an
/// entry in it. Public so an embedding shell can inspect processes through the
/// same snapshot its `ps`/`pgrep` builtins use.
#[cfg(feature = "util.procs")]
pub use proc_snapshot::{ProcInfo, ProcessStatus};
/// The OS process primitives under those snapshots. `pi-shell` builds its
/// identity-pinned process references on them, so each platform query has one
/// implementation.
#[cfg(all(
	feature = "util.procs",
	any(target_os = "linux", target_os = "macos", target_os = "windows")
))]
pub use proc_snapshot::sys as proc_sys;
