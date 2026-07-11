//! Core implementation of the brush shell. Implements the shell's abstraction,
//! its interpreter, and various facilities used internally by the shell.

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
pub mod terminal;
pub mod tests;
pub mod timing;
pub mod trace_categories;
pub mod traps;
pub mod variables;
mod wellknownvars;

/// Re-export parser types used in core definitions.
pub mod parser {
	pub use brush_parser::{
		BindingParseError, ParseError, ParserImpl, SourcePosition, SourcePositionOffset, SourceSpan,
		TestCommandParseError, WordParseError, ast,
	};
}

pub use commands::{CommandArg, ExecutionContext};
pub use error::{BuiltinError, Error, ErrorKind};
pub use extensions::ShellExtensions;
pub use interp::{
	ExecutionParameters, ExternalCommandInfo, ExternalCommandOutputMarker,
	ExternalCommandOutputMarkers, ProcessGroupPolicy,
};
pub use parser::{SourcePosition, SourcePositionOffset, SourceSpan};
pub use results::{ExecutionControlFlow, ExecutionExitCode, ExecutionResult, ExecutionSpawnResult};
pub use shell::{
	CreateOptions, ProfileLoadBehavior, RcLoadBehavior, Shell, ShellBuilder, ShellBuilderState,
	ShellFd, ShellState,
};
pub use sourceinfo::SourceInfo;
pub use variables::{ShellValue, ShellVariable};
