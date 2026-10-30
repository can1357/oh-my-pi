//! `rsync` builtin: a clean-room implementation of rsync 3.5.1 (protocol 33).
//!
//! The builtin acts as a client for local, remote-shell (`-e`), and daemon
//! (`rsync://`, `host::module`) transfers and as the server half of a transfer
//! (`--server`), speaking the rsync wire protocol (versions 29–33) with real
//! rsync peers. Local copies run both halves in-process over an in-memory
//! duplex, so they exercise the same protocol path as remote transfers.
//!
//! Layering, bottom up:
//!
//! - [`consts`], [`wire`], [`mux`]: protocol constants, integer/string codecs,
//!   and the multiplexed message stream.
//! - [`cstr`], [`time`]: upstream's C-string parsing (`isspace`, `atol`, NUL
//!   termination) and epoch-time conversions shared across the layers.
//! - [`checksum`], [`token`]: rolling and strong checksums, delta token
//!   streams and their compression.
//! - [`flist`], [`ids`], [`hlink`], [`xattr`], [`acl`]: the file list and the
//!   per-entry metadata that travels with it.
//! - [`filter`], [`wildmatch`]: include/exclude/merge rules.
//! - [`tree`], [`paths`], [`meta`], [`chmod`]: confined filesystem access and
//!   attribute application on the local side.
//! - [`log`], [`exit`], [`progress`]: everything the user sees.
//! - [`options`], [`usage`], [`operands`], [`transport`], [`daemon`]: the
//!   command line and how the peer is reached.
//! - [`flists`], [`scan`], [`iconv`]: building, sending, and receiving file
//!   lists.
//! - [`generator`], [`delete`], [`backup`], [`sender`], [`matcher`],
//!   [`receiver`]: the transfer engine.
//! - [`session`], [`handshake`], [`batch`]: role orchestration, protocol
//!   setup, and batch files.

use std::ffi::OsString;

use brush_core::{ShellExtensions, builtins::Registration};

use crate::host::{Host, Utility, util};

mod acl;
mod backup;
mod batch;
mod checksum;
mod chmod;
#[cfg(test)]
mod conformance;
mod consts;
mod cstr;
mod daemon;
mod delete;
mod exit;
mod filter;
mod flist;
mod flists;
mod generator;
mod handshake;
mod hlink;
mod iconv;
mod ids;
mod log;
mod matcher;
mod meta;
mod mux;
mod operands;
mod options;
mod paths;
mod progress;
mod receiver;
mod scan;
mod sender;
mod session;
mod time;
mod token;
mod transport;
mod tree;
mod usage;
mod wildmatch;
mod wire;
mod xattr;

/// Parsed `rsync` invocation: the raw argument vector. rsync's own popt-style
/// parser ([`options::parse`]) owns the command line, so clap only collects
/// the words untouched (help and version handling included).
#[derive(clap::Parser)]
#[command(name = "rsync", disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct Rsync {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true, value_parser = clap::value_parser!(OsString))]
	args: Vec<OsString>,
}

impl Utility for Rsync {
	const NAME: &'static str = "rsync";
	const USAGE_ERROR: u8 = 1;
	/// rsync catches SIGINT/SIGTERM/SIGHUP: a cancelled run ends with code 20
	/// and its `received SIGINT, SIGTERM, or SIGHUP` trailer.
	const OWNS_CANCELLATION: bool = true;

	/// Puts every word after `--`, so clap never interprets one (rsync itself
	/// gives `--` its meaning).
	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		let at = argv.len().min(1);
		argv.insert(at, OsString::from("--"));
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let mut argv = Vec::with_capacity(self.args.len() + 1);
		argv.push(OsString::from(Self::NAME));
		argv.extend(self.args);
		session::run(host, argv)
	}
}

/// Creates the `rsync` builtin registration.
pub(crate) fn rsync_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Rsync, SE>()
}
