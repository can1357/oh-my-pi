//! Host-provided session commands for one shell run.
//!
//! JavaScript passes the names and one async handler; this module adapts the
//! handler to [`SessionCommandHandler`], which the shell calls for every
//! invocation of one of the names (see `omp_shell::commands`).
//!
//! # Bridge
//! - Every invocation is one handler round trip, awaited without blocking a
//!   thread; several may be in flight at once.
//! - A handler that throws, a promise that rejects, and a response that is not
//!   a [`ShellCommandResult`] fail the command with the reason on stderr.
//! - A call the shell abandons (a cancelled run) stops waiting; the promise's
//!   later settlement is ignored.
//! - The callback is held weakly, so an idle session never keeps the event loop
//!   alive: every call happens while a shell run's pending promise holds the
//!   loop open.

use std::sync::Arc;

use napi::{Status, bindgen_prelude::Promise, threadsafe_function::ThreadsafeFunction};
use napi_derive::napi;
use omp_shell::{
	SessionCommandFuture, SessionCommandHandler, SessionCommandRequest, SessionCommandResult,
	SessionCommands,
};

/// One invocation of a host-provided session command in the embedded shell.
#[napi(object, object_from_js = false)]
pub struct ShellCommandRequest {
	/// Command name as invoked.
	pub name:  String,
	/// Arguments after the command name.
	pub argv:  Vec<String>,
	/// Shell working directory at invocation time.
	pub cwd:   String,
	/// UTF-8 stdin read to EOF, only when `argv` contains a bare `-`; empty
	/// otherwise.
	pub stdin: String,
}

/// Shell-composable response of a session command.
#[napi(object, object_to_js = false)]
pub struct ShellCommandResult {
	pub stdout:    String,
	pub stderr:    String,
	/// 0..=255
	pub exit_code: f64,
}

/// Weak, as the speech and filesystem handlers are; unhandled by the
/// callee, so the handler takes the request alone.
type ShellCommandHandler = ThreadsafeFunction<
	ShellCommandRequest,
	Promise<ShellCommandResult>,
	ShellCommandRequest,
	Status,
	false,
	true,
>;

/// Host-provided commands installed for one `Shell.run`.
#[napi(object, object_to_js = false)]
pub struct ShellCommands {
	/// Names resolvable as commands during this run.
	pub names:   Vec<String>,
	#[napi(ts_type = "(request: ShellCommandRequest) => Promise<ShellCommandResult>")]
	pub handler: ShellCommandHandler,
}

impl ShellCommands {
	/// The [`SessionCommands`] these names and this handler provide.
	pub fn into_commands(self) -> SessionCommands {
		SessionCommands::new(self.names, Arc::new(JsCommands { handler: Arc::new(self.handler) }))
	}
}

struct JsCommands {
	handler: Arc<ShellCommandHandler>,
}

impl SessionCommandHandler for JsCommands {
	fn call(&self, request: SessionCommandRequest) -> SessionCommandFuture {
		let handler = Arc::clone(&self.handler);
		Box::pin(async move {
			let SessionCommandRequest { name, argv, cwd, stdin } = request;
			let promise = handler
				.call_async_catch(ShellCommandRequest { name, argv, cwd, stdin })
				.await
				.map_err(|err| err.reason)?;
			let ShellCommandResult { stdout, stderr, exit_code } =
				promise.await.map_err(|err| err.reason)?;
			if !exit_code.is_finite() {
				return Err(format!("handler returned exit code {exit_code}; expected 0..=255"));
			}
			Ok(SessionCommandResult { stdout, stderr, exit_code: exit_code.clamp(0.0, 255.0) as i32 })
		})
	}
}
