#![allow(
	clippy::style,
	clippy::complexity,
	clippy::perf,
	clippy::pedantic,
	clippy::nursery,
	reason = "shared builtin implementations use deliberate lint exceptions"
)]
//! In-process utility and process builtins for omp-shell.

mod cksum;
mod r#dyn;
mod factory;
pub mod graphics;
mod host;
mod proc_match;
mod proc_snapshot;
mod support;

mod b2sum;
mod base32;
mod base64;
mod basename;
mod cat;
mod cmp;
mod combine;
mod comm;
mod cut;
mod date;
mod diff;
mod dirname;
#[cfg(unix)]
mod errno;
mod fd;
mod find;
mod grep;
mod head;
mod hostname;
mod ifne;
mod isutf8;
mod jq;
mod ln;
mod ls;
mod md5sum;
mod mkdir;
mod mktemp;
mod mv;
mod nproc;
mod paste;
mod printenv;
mod readlink;
mod realpath;
mod rg;
mod rm;
mod sed;
mod seq;
mod sha1sum;
mod sha224sum;
mod sha256sum;
mod sha384sum;
mod sha512sum;
mod sort;
mod sponge;
mod stat;
mod tac;
mod tail;
mod tee;
mod touch;
mod tr;
mod truncate;
mod ts;
mod uname;
mod uniq;
mod wc;
mod which;
mod whoami;
mod xargs;
mod yes;

mod nohup;
mod pgrep;
mod pidwait;
mod pkill;
mod ps;
mod sleep;
mod timeout;
mod top;

pub use factory::{dyn_builtin, process_builtins, utility_builtins};
pub use graphics::{
	ImagePassthrough, encode_image_passthrough, extract_image_passthrough, image_passthrough_ranges,
};
pub use host::{
	DynCallOutput, DynDevice, DynFault, DynFuture, DynHost, DynOutput, DynSchema,
	panic_scope_active, rayon_global_pool_available, set_rayon_global_pool_available,
};
pub use proc_snapshot::{ProcInfo, ProcessStatus};
