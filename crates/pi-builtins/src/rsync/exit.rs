//! Exit codes, their descriptions, and the `rsync error:` trailer.
//!
//! Every failure that ends (part of) a run is an [`RsyncError`]: an rsync exit
//! code, the diagnostic printed right before the trailer (if any), and the
//! upstream source site the trailer names. The numeric codes and their texts
//! are rsync's documented exit values.

use std::{fmt, io};

use crate::rsync::log::{Role, big_num};
use crate::rsync::usage::RSYNC_VERSION;

/// Success.
pub(crate) const RERR_OK: i32 = 0;
/// Syntax or usage error.
pub(crate) const RERR_SYNTAX: i32 = 1;
/// Protocol incompatibility.
pub(crate) const RERR_PROTOCOL: i32 = 2;
/// Errors selecting input/output files, dirs.
pub(crate) const RERR_FILESELECT: i32 = 3;
/// Requested action not supported.
pub(crate) const RERR_UNSUPPORTED: i32 = 4;
/// Error starting client-server protocol.
pub(crate) const RERR_STARTCLIENT: i32 = 5;
/// Error in socket I/O.
pub(crate) const RERR_SOCKETIO: i32 = 10;
/// Error in file I/O.
pub(crate) const RERR_FILEIO: i32 = 11;
/// Error in rsync protocol data stream.
pub(crate) const RERR_STREAMIO: i32 = 12;
/// Errors with program diagnostics.
pub(crate) const RERR_MESSAGEIO: i32 = 13;
/// Error in IPC code.
pub(crate) const RERR_IPC: i32 = 14;
/// Sibling crashed.
pub(crate) const RERR_CRASHED: i32 = 15;
/// Sibling terminated abnormally.
pub(crate) const RERR_TERMINATED: i32 = 16;
/// Status after SIGUSR1.
pub(crate) const RERR_SIGNAL1: i32 = 19;
/// Status after SIGINT, SIGTERM, SIGHUP (and cancellation).
pub(crate) const RERR_SIGNAL: i32 = 20;
/// Some error returned by waitpid().
pub(crate) const RERR_WAITCHILD: i32 = 21;
/// Error allocating core memory buffers.
pub(crate) const RERR_MALLOC: i32 = 22;
/// Partial transfer.
pub(crate) const RERR_PARTIAL: i32 = 23;
/// File(s) vanished on the sender side.
pub(crate) const RERR_VANISHED: i32 = 24;
/// Skipped some deletes due to --max-delete.
pub(crate) const RERR_DEL_LIMIT: i32 = 25;
/// Timeout in data send/receive.
pub(crate) const RERR_TIMEOUT: i32 = 30;
/// Timeout waiting for a daemon connection.
pub(crate) const RERR_CONTIMEOUT: i32 = 35;
/// The remote shell exited with status 255.
pub(crate) const RERR_CMD_FAILED: i32 = 124;
/// The remote shell was killed by a signal.
pub(crate) const RERR_CMD_KILLED: i32 = 125;
/// The remote command could not be run.
pub(crate) const RERR_CMD_RUN: i32 = 126;
/// The remote command was not found.
pub(crate) const RERR_CMD_NOTFOUND: i32 = 127;

/// Upstream rerr_names text for a code ("some files/attrs were not transferred (see previous
/// errors)"); "unexplained error" for codes without a name (including 0).
pub(crate) fn rerr_name(code: i32) -> &'static str {
	match code {
		RERR_SYNTAX => "syntax or usage error",
		RERR_PROTOCOL => "protocol incompatibility",
		RERR_FILESELECT => "errors selecting input/output files, dirs",
		RERR_UNSUPPORTED => "requested action not supported",
		RERR_STARTCLIENT => "error starting client-server protocol",
		RERR_SOCKETIO => "error in socket IO",
		RERR_FILEIO => "error in file IO",
		RERR_STREAMIO => "error in rsync protocol data stream",
		RERR_MESSAGEIO => "errors with program diagnostics",
		RERR_IPC => "error in IPC code",
		RERR_CRASHED => "sibling process crashed",
		RERR_TERMINATED => "sibling process terminated abnormally",
		RERR_SIGNAL1 => "received SIGUSR1",
		RERR_SIGNAL => "received SIGINT, SIGTERM, or SIGHUP",
		RERR_WAITCHILD => "waitpid() failed",
		RERR_MALLOC => "error allocating core memory buffers",
		RERR_PARTIAL => "some files/attrs were not transferred (see previous errors)",
		RERR_VANISHED => "some files vanished before they could be transferred",
		RERR_DEL_LIMIT => "the --max-delete limit stopped deletions",
		RERR_TIMEOUT => "timeout in data send/receive",
		RERR_CONTIMEOUT => "timeout waiting for daemon connection",
		RERR_CMD_FAILED => "remote shell failed",
		RERR_CMD_KILLED => "remote shell killed",
		RERR_CMD_RUN => "remote command could not be run",
		RERR_CMD_NOTFOUND => "remote command not found",
		_ => "unexplained error",
	}
}

/// Upstream site of the EOF exit (connection unexpectedly closed).
const EOF_SITE: (&str, u32) = ("io.c", 303);
/// Upstream site of the `--timeout` exit.
const TIMEOUT_SITE: (&str, u32) = ("io.c", 266);
/// Upstream site of the signal-handler exit.
const SIGNAL_SITE: (&str, u32) = ("rsync.c", 874);

/// A failure that ends (part of) a run with an rsync exit code.
///
/// `message` is the exact text upstream prints at FERROR right before that exit, without the
/// trailing newline (the reporter adds it, then the `rsync error:` trailer). `site` is the
/// upstream `file.c` name and line the trailer names.
#[derive(Clone, Debug)]
pub(crate) struct RsyncError {
	pub code: i32,
	pub message: Option<String>,
	pub site: Option<(&'static str, u32)>,
}

impl RsyncError {
	/// An error with a diagnostic; an empty `message` means "trailer only".
	pub(crate) fn new(code: i32, message: impl Into<String>) -> Self {
		let message = message.into();
		Self { code, message: (!message.is_empty()).then_some(message), site: None }
	}

	/// An error that prints only the trailer.
	pub(crate) const fn bare(code: i32) -> Self {
		Self { code, message: None, site: None }
	}

	/// Sets the upstream site (`"main.c"`, 1913) the trailer reports.
	pub(crate) fn at(mut self, file: &'static str, line: u32) -> Self {
		self.site = Some((file, line));
		self
	}

	/// The failure a cancelled run ends with (as upstream's SIGINT exit).
	pub(crate) fn cancelled() -> Self {
		Self::bare(RERR_SIGNAL).at(SIGNAL_SITE.0, SIGNAL_SITE.1)
	}

	/// Cancellation as an io::Error for wire/file loops: kind Other carrying
	/// [`Self::cancelled`] (never `Interrupted`, which std retries).
	pub(crate) fn cancelled_io() -> io::Error {
		io::Error::other(Self::cancelled())
	}

	/// Maps an io::Error from the wire layers (timeouts → RERR_TIMEOUT, EOF → RERR_STREAMIO,
	/// else `code`). A [`crate::rsync::wire::WireError`] or `RsyncError` carried inside the
	/// io::Error (cancellation, peer-data errors) is used verbatim.
	pub(crate) fn from_io(err: &io::Error, code: i32) -> Self {
		if let Some(inner) = err.get_ref() {
			if let Some(wire) = inner.downcast_ref::<crate::rsync::wire::WireError>() {
				return Self {
					code: wire.code,
					message: (!wire.message.is_empty()).then(|| wire.message.clone()),
					site: wire.site,
				};
			}
			if let Some(rsync) = inner.downcast_ref::<Self>() {
				return rsync.clone();
			}
		}
		let custom = err.get_ref().map(|inner| inner.to_string()).filter(|text| !text.is_empty());
		match err.kind() {
			io::ErrorKind::TimedOut => {
				Self { code: RERR_TIMEOUT, message: custom, site: Some(TIMEOUT_SITE) }
			}
			io::ErrorKind::UnexpectedEof => {
				Self { code: RERR_STREAMIO, message: custom, site: Some(EOF_SITE) }
			}
			io::ErrorKind::InvalidData => Self { code, message: custom, site: None },
			_ => Self { code, message: None, site: None },
		}
	}

	/// [`Self::from_io`] with `RERR_STREAMIO`: a failed read or write of the protocol stream.
	pub(crate) fn from_stream(err: io::Error) -> Self {
		Self::from_io(&err, RERR_STREAMIO)
	}

	/// [`Self::from_io`], filling in upstream's role-dependent texts that need context the
	/// wire layer may not have: a bare EOF becomes `rsync: connection unexpectedly closed
	/// (N bytes received so far) [role]`.
	pub(crate) fn from_io_as(err: &io::Error, code: i32, role: Role, bytes_read: u64) -> Self {
		let mut mapped = Self::from_io(err, code);
		if mapped.message.is_none() && err.kind() == io::ErrorKind::UnexpectedEof {
			mapped.message = Some(eof_message(bytes_read, role));
		}
		mapped
	}
}

/// `rsync: connection unexpectedly closed (N bytes received so far) [role]`.
pub(crate) fn eof_message(bytes_read: u64, role: Role) -> String {
	format!(
		"rsync: connection unexpectedly closed ({} bytes received so far) [{}]",
		big_num(i64::try_from(bytes_read).unwrap_or(i64::MAX), 0),
		role.name()
	)
}

/// `[role] io timeout after N seconds -- exiting`.
pub(crate) fn timeout_message(secs: u64, role: Role) -> String {
	format!("[{}] io timeout after {secs} seconds -- exiting", role.name())
}

impl fmt::Display for RsyncError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match &self.message {
			Some(message) => f.write_str(message),
			None => write!(f, "{} (code {})", rerr_name(self.code), self.code),
		}
	}
}

impl std::error::Error for RsyncError {}

/// "rsync error: <text> (code N) at <file>.c(<line>) [<role>=3.5.1]\n"; code 24 uses the
/// `rsync warning:` form; code 0 prints nothing. The site file is printed verbatim (".c" is
/// appended only when the name has no extension); without a site the ` at …` part is omitted.
pub(crate) fn exit_trailer(code: i32, site: Option<(&'static str, u32)>, role: Role) -> String {
	if code == RERR_OK {
		return String::new();
	}
	let kind = if code == RERR_VANISHED { "warning" } else { "error" };
	let at = match site {
		Some((file, line)) => {
			let ext = if file.contains('.') { "" } else { ".c" };
			format!(" at {file}{ext}({line})")
		}
		None => String::new(),
	};
	format!(
		"rsync {kind}: {} (code {code}){at} [{}={RSYNC_VERSION}]\n",
		rerr_name(code),
		role.name()
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn trailers_match_reference() {
		// Captured from /opt/homebrew/bin/rsync 3.5.1.
		assert_eq!(
			exit_trailer(RERR_SYNTAX, Some(("main.c", 1913)), Role::Client),
			"rsync error: syntax or usage error (code 1) at main.c(1913) [client=3.5.1]\n"
		);
		assert_eq!(
			exit_trailer(RERR_PARTIAL, Some(("main.c", 1412)), Role::Sender),
			"rsync error: some files/attrs were not transferred (see previous errors) (code 23) at \
			 main.c(1412) [sender=3.5.1]\n"
		);
		assert_eq!(
			exit_trailer(RERR_VANISHED, Some(("main.c", 1338)), Role::Sender),
			"rsync warning: some files vanished before they could be transferred (code 24) at \
			 main.c(1338) [sender=3.5.1]\n"
		);
		assert_eq!(
			exit_trailer(RERR_TIMEOUT, Some(("io.c", 266)), Role::Receiver),
			"rsync error: timeout in data send/receive (code 30) at io.c(266) [receiver=3.5.1]\n"
		);
		assert_eq!(
			exit_trailer(RERR_CONTIMEOUT, Some(("socket.c", 437)), Role::PreReceiver),
			"rsync error: timeout waiting for daemon connection (code 35) at socket.c(437) \
			 [Receiver=3.5.1]\n"
		);
		assert_eq!(exit_trailer(RERR_OK, Some(("main.c", 1)), Role::Client), "");
	}

	#[test]
	fn site_without_extension_gets_dot_c() {
		assert_eq!(
			exit_trailer(RERR_FILEIO, Some(("main", 821)), Role::PreReceiver),
			"rsync error: error in file IO (code 11) at main.c(821) [Receiver=3.5.1]\n"
		);
		assert_eq!(
			exit_trailer(RERR_FILEIO, None, Role::Generator),
			"rsync error: error in file IO (code 11) [generator=3.5.1]\n"
		);
	}

	#[test]
	fn unknown_code_is_unexplained() {
		assert_eq!(rerr_name(99), "unexplained error");
		assert_eq!(rerr_name(RERR_CMD_NOTFOUND), "remote command not found");
	}

	#[test]
	fn io_errors_map_to_codes() {
		let timeout = RsyncError::from_io(&io::Error::from(io::ErrorKind::TimedOut), RERR_FILEIO);
		assert_eq!(timeout.code, RERR_TIMEOUT);
		let cancel = RsyncError::from_io(&RsyncError::cancelled_io(), RERR_FILEIO);
		assert_eq!(cancel.code, RERR_SIGNAL);
		assert_eq!(cancel.message, None);
		assert_eq!(cancel.site, Some(("rsync.c", 874)));
		assert_eq!(
			exit_trailer(cancel.code, cancel.site, Role::Sender),
			"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) \
			 [sender=3.5.1]\n"
		);
		let eof = RsyncError::from_io_as(
			&io::Error::from(io::ErrorKind::UnexpectedEof),
			RERR_FILEIO,
			Role::Receiver,
			1234,
		);
		assert_eq!(eof.code, RERR_STREAMIO);
		assert_eq!(
			eof.message.as_deref(),
			Some("rsync: connection unexpectedly closed (1234 bytes received so far) [receiver]")
		);
		assert_eq!(eof.site, Some(("io.c", 303)));
		let bad = RsyncError::from_io(
			&io::Error::new(io::ErrorKind::InvalidData, "over-long vstring received"),
			RERR_PROTOCOL,
		);
		assert_eq!(bad.code, RERR_PROTOCOL);
		assert_eq!(bad.message.as_deref(), Some("over-long vstring received"));
		let other = RsyncError::from_io(&io::Error::from_raw_os_error(libc::EIO), RERR_FILEIO);
		assert_eq!((other.code, other.message), (RERR_FILEIO, None));
	}

	#[test]
	fn embedded_rsync_error_is_used_verbatim() {
		let inner = RsyncError::new(RERR_PROTOCOL, "invalid stuff [sender]").at("io.c", 1);
		let wrapped = io::Error::new(io::ErrorKind::InvalidData, inner);
		let mapped = RsyncError::from_io(&wrapped, RERR_STREAMIO);
		assert_eq!(mapped.code, RERR_PROTOCOL);
		assert_eq!(mapped.message.as_deref(), Some("invalid stuff [sender]"));
		assert_eq!(mapped.site, Some(("io.c", 1)));
	}

	#[test]
	fn timeout_text() {
		assert_eq!(
			timeout_message(30, Role::Sender),
			"[sender] io timeout after 30 seconds -- exiting"
		);
	}
}
