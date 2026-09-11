//! Standard builtins.

#[cfg(feature = "builtin.alias")]
mod alias;
#[cfg(feature = "builtin.bg")]
mod bg;
#[cfg(feature = "builtin.bind")]
mod bind;
#[cfg(feature = "builtin.break")]
mod break_;
#[cfg(feature = "builtin.builtin")]
mod builtin_;
#[cfg(feature = "builtin.caller")]
mod caller;
#[cfg(feature = "builtin.cd")]
mod cd;
#[cfg(feature = "builtin.colon")]
mod colon;
#[cfg(feature = "builtin.command")]
mod command;
#[cfg(any(feature = "builtin.complete", feature = "builtin.compgen", feature = "builtin.compopt"))]
mod complete;
#[cfg(feature = "builtin.continue")]
mod continue_;
#[cfg(feature = "builtin.declare")]
mod declare;
#[cfg(feature = "builtin.dirs")]
mod dirs;
#[cfg(feature = "builtin.dot")]
mod dot;
#[cfg(feature = "builtin.echo")]
mod echo;
#[cfg(feature = "builtin.enable")]
mod enable;
#[cfg(feature = "builtin.eval")]
mod eval;
#[cfg(all(feature = "builtin.exec", unix))]
mod exec;
#[cfg(feature = "builtin.exit")]
mod exit;
#[cfg(feature = "builtin.export")]
mod export;
#[cfg(feature = "builtin.false")]
mod false_;
#[cfg(feature = "builtin.fc")]
mod fc;
#[cfg(feature = "builtin.fg")]
mod fg;
#[cfg(feature = "builtin.getopts")]
mod getopts;
#[cfg(feature = "builtin.hash")]
mod hash;
#[cfg(feature = "builtin.help")]
mod help;
#[cfg(feature = "builtin.history")]
mod history;
#[cfg(feature = "builtin.jobs")]
mod jobs;
// Needs either unix signals or the windows process table; no other target
// has a way to signal a process (upstream brush gated this to unix alone).
#[cfg(all(feature = "builtin.kill", any(unix, windows)))]
mod kill;
#[cfg(feature = "builtin.let")]
mod let_;
#[cfg(feature = "builtin.mapfile")]
mod mapfile;
#[cfg(feature = "builtin.popd")]
mod popd;
#[cfg(all(feature = "builtin.printf", any(unix, windows)))]
mod printf;
#[cfg(feature = "builtin.pushd")]
mod pushd;
#[cfg(feature = "builtin.pwd")]
mod pwd;
#[cfg(feature = "builtin.read")]
mod read;
#[cfg(feature = "builtin.return")]
mod return_;
#[cfg(feature = "builtin.set")]
mod set;
#[cfg(feature = "builtin.shift")]
mod shift;
#[cfg(feature = "builtin.shopt")]
mod shopt;
#[cfg(all(feature = "builtin.suspend", unix))]
mod suspend;
#[cfg(feature = "builtin.test")]
mod test;
#[cfg(feature = "builtin.times")]
mod times;
#[cfg(feature = "builtin.trap")]
mod trap;
#[cfg(feature = "builtin.true")]
mod true_;
#[cfg(feature = "builtin.type")]
mod type_;
#[cfg(all(feature = "builtin.ulimit", unix))]
mod ulimit;
#[cfg(all(feature = "builtin.umask", unix))]
mod umask;
#[cfg(feature = "builtin.unalias")]
mod unalias;
#[cfg(feature = "builtin.unset")]
mod unset;
#[cfg(feature = "builtin.wait")]
mod wait;

mod builder;
mod factory;
mod host;
mod unimp;

// ── Utility builtins ──────────────────────────────────────────────────────────
// Ports of the standalone command-line utilities the shell ships in-process.
// Each runs against the explicit `host::Host` view of the shell; see
// `src/host.rs` for the contract.
#[cfg(feature = "util.b2sum")]
mod b2sum;
#[cfg(feature = "util.base32")]
mod base32;
#[cfg(feature = "util.base64")]
mod base64;
#[cfg(feature = "util.basename")]
mod basename;
/// Shared POSIX basic-regular-expression translation behind `grep` and `sed`.
#[cfg(feature = "util.bre")]
mod bre;
#[cfg(feature = "util.cat")]
mod cat;
/// The `cksum` builtin plus the shared checksum machinery behind `md5sum`,
/// `sha*sum`, and `b2sum`.
#[cfg(feature = "util.cksum")]
mod cksum;
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
#[cfg(feature = "util.cmp")]
mod cmp;
#[cfg(feature = "util.comm")]
mod comm;
#[cfg(feature = "util.combine")]
mod combine;
#[cfg(feature = "util.cut")]
mod cut;
#[cfg(feature = "util.date")]
mod date;
#[cfg(feature = "util.diff")]
mod diff;
#[cfg(feature = "util.dirname")]
mod dirname;
#[cfg(all(feature = "util.errno", unix))]
mod errno;
#[cfg(feature = "util.fd")]
mod fd;
#[cfg(feature = "util.find")]
mod find;
#[cfg(feature = "util.grep")]
mod grep;
#[cfg(feature = "util.head")]
mod head;
#[cfg(feature = "util.hostname")]
mod hostname;
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
#[cfg(feature = "util.mkdir")]
mod mkdir;
#[cfg(feature = "util.mktemp")]
mod mktemp;
#[cfg(feature = "util.mv")]
mod mv;
#[cfg(feature = "util.nproc")]
mod nproc;
#[cfg(feature = "util.paste")]
mod paste;
#[cfg(feature = "util.nohup")]
mod nohup;
#[cfg(feature = "util.pgrep")]
mod pgrep;
#[cfg(feature = "util.pidwait")]
mod pidwait;
#[cfg(feature = "util.pkill")]
mod pkill;
/// Shared process-matching engine behind `pgrep`, `pkill`, and `pidwait`.
#[cfg(feature = "util.proc-match")]
mod proc_match;
/// Shared process-table snapshot behind the process builtins.
#[cfg(feature = "util.procs")]
mod proc_snapshot;
#[cfg(feature = "util.ps")]
mod ps;
#[cfg(feature = "util.sleep")]
mod sleep;
#[cfg(feature = "util.timeout")]
mod timeout;
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
#[cfg(feature = "util.tac")]
mod tac;
#[cfg(feature = "util.tail")]
mod tail;
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

pub use builder::ShellBuilderExt;
pub use factory::{BuiltinSet, default_builtins, process_builtins, utility_builtins};
pub use host::{panic_scope_active, rayon_global_pool_available, set_rayon_global_pool_available};
/// The process table the process builtins read, and the liveness state of an
/// entry in it. Public so an embedding shell can inspect processes through the
/// same snapshot its `ps`/`pgrep`/`kill` builtins use.
#[cfg(feature = "util.procs")]
pub use proc_snapshot::{ProcInfo, ProcessStatus};

/// Macro to define a struct that represents a shell built-in flag argument that
/// can be enabled or disabled by specifying an option with a leading '+' or '-'
/// character.
///
/// # Arguments
///
/// - `$struct_name` - The identifier to be used for the struct to define.
/// - `$flag_char` - The character to use as the flag.
/// - `$desc` - The string description of the flag.
#[macro_export]
macro_rules! minus_or_plus_flag_arg {
    ($struct_name:ident, $flag_char:literal, $desc:literal) => {
        #[derive(clap::Parser)]
        pub(crate) struct $struct_name {
            #[arg(short = $flag_char, name = concat!(stringify!($struct_name), "_enable"), action = clap::ArgAction::SetTrue, help = $desc)]
            _enable: bool,
            #[arg(long = concat!("+", $flag_char), name = concat!(stringify!($struct_name), "_disable"), action = clap::ArgAction::SetTrue, hide = true)]
            _disable: bool,
        }

        impl From<$struct_name> for Option<bool> {
            fn from(value: $struct_name) -> Self {
                value.to_bool()
            }
        }

        impl $struct_name {
            #[allow(dead_code, reason = "may not be used in all macro instantiations")]
            pub const fn is_some(&self) -> bool {
                self._enable || self._disable
            }

            pub const fn to_bool(&self) -> Option<bool> {
                match (self._enable, self._disable) {
                    (true, false) => Some(true),
                    (false, true) => Some(false),
                    _ => None,
                }
            }
        }
    };
}
