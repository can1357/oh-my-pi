#![allow(
	clippy::style,
	clippy::complexity,
	clippy::perf,
	clippy::pedantic,
	clippy::nursery,
	reason = "ported from brush-core 0.5.0 / brush-parser 0.4.0; kept structurally close to \
	          upstream"
)]

//! Standalone Bash parser and executor.
//!
//! Ported from brush-core 0.5.0 and brush-parser 0.4.0
//! (<https://github.com/reubeno/brush>, MIT).
//!
//! Implements the shell abstraction, interpreter, and supporting facilities.
/// Static policy analysis for parsed shell programs.
pub mod analysis;
pub mod arithmetic;
mod braceexpansion;
pub mod builtins;
pub mod callstack;
pub mod commands;
pub mod completion;
pub mod env;
pub mod error;
pub mod escape;
pub mod expansion;
mod extendedtests;
pub mod extensions;
pub mod functions;
pub mod history;
pub mod int_utils;
pub mod interfaces;
mod interp;
mod ioutils;
pub mod jobs;
mod keywords;
pub mod namedoptions;
pub mod openfiles;
pub mod options;
pub mod pathcache;
pub mod pathsearch;
pub mod patterns;
pub mod processes;
mod prompt;
mod regex;
pub mod results;
mod shell;
pub mod sourceinfo;
pub mod sys;
pub mod tests;
pub mod timing;
pub mod trace_categories;
pub mod traps;
pub mod variables;
mod wellknownvars;

pub mod parser;

/// Defines a clap flag that accepts both enabling `-x` and disabling `+x`
/// forms.
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

#[cfg(test)]
mod test_result {
	use std::{error, result};

	/// Result type for tests that propagate heterogeneous errors.
	pub(crate) type TestResult<T, E = Box<dyn error::Error>> = result::Result<T, E>;
}

pub use commands::{CommandArg, ExecutionContext};
pub use error::{BuiltinError, Error, ErrorKind};
pub use extensions::ShellExtensions;
pub use interp::{
	ExecutionParameters, ExternalCommandInfo, ExternalCommandOutputMarker,
	ExternalCommandOutputMarkers, OpenRequest, PathAccess, PathDenied, PathPolicy,
	ProcessGroupPolicy, ProcessScope, SpawnObserver, SpawnWrapper,
};
pub use parser::{SourcePosition, SourcePositionOffset, SourceSpan};
pub use results::{ExecutionControlFlow, ExecutionExitCode, ExecutionResult, ExecutionSpawnResult};
pub use shell::{
	CreateOptions, ProfileLoadBehavior, RcLoadBehavior, Shell, ShellBuilder, ShellBuilderState,
	ShellFd, ShellState,
};
pub use sourceinfo::SourceInfo;
#[cfg(test)]
pub(crate) use test_result::TestResult;
pub use variables::{ShellValue, ShellVariable};
