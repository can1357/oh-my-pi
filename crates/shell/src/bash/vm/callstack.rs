//! bash's call-stack arrays: `FUNCNAME`, `BASH_SOURCE`, `BASH_LINENO`,
//! `BASH_ARGC` and `BASH_ARGV`, and what `caller`, `declare -F` (under
//! `extdebug`) and the DEBUG/RETURN traps read from them.
//!
//! bash keeps them as real arrays it pushes and pops around function calls
//! and `.` files (`execute_function`, `_evalfile`). Here a vproc keeps the
//! pushes as [`Call`]s ([`Vproc::calls`]): each is tied to the frame that
//! made it and leaves with that frame, a subshell starts with a copy of its
//! parent's, and the arrays are built from them when read.

use bstr::BString;
use serde::{Deserialize, Serialize};

use super::{
	Kernel,
	proc::Vproc,
	state::{self, Var},
};
use crate::bash::{
	ir::Unit,
	store::{Attrs, Key, MiscKey, OptId, Record, StateStore, StoreError, VarValue},
};

/// One push onto bash's call-stack arrays.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Call {
	/// What was pushed.
	pub kind:  CallKind,
	/// The frame count right after the frame that made the push (its index
	/// plus one): the push ends when that frame pops. 0 for a push this
	/// vproc's frames never pop (one inherited from a parent shell, the
	/// `BASH_ARGV` base).
	pub depth: u32,
}

/// The arrays a [`Call`] pushed onto.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallKind {
	/// A function call: a `FUNCNAME`/`BASH_SOURCE`/`BASH_LINENO` level, and
	/// under `extdebug` its arguments on `BASH_ARGV`/`BASH_ARGC`.
	Function {
		/// `FUNCNAME` entry.
		name: BString,
		/// `BASH_SOURCE` entry: the file the function was defined in.
		file: BString,
		/// `BASH_LINENO` entry: the line it was called from.
		line: u32,
		/// The arguments pushed onto `BASH_ARGV` (`extdebug` at the call).
		argv: Option<Vec<BString>>,
	},
	/// A `.` file: a `source` level, and on `BASH_ARGV`/`BASH_ARGC` the file
	/// name (no arguments) or, under `extdebug`, its arguments.
	Source {
		/// `BASH_SOURCE` entry: the file name as given.
		file:    BString,
		/// `BASH_LINENO` entry: the line of the `.` command.
		line:    u32,
		/// What was pushed onto `BASH_ARGV`.
		argv:    Option<Vec<BString>>,
		/// What the end of the file puts back (`. file args`).
		restore: Option<Box<SourceSave>>,
		/// zsh `FUNCTION_ARGZERO` at the `.`: `$0` while the file runs (the
		/// file name as given).
		argzero: Option<BString>,
	},
	/// bash's `init_bash_argv`: the positional parameters pushed onto
	/// `BASH_ARGV` once, before the first function call (or `.` with
	/// arguments) under `extdebug`.
	Args(Vec<BString>),
}

/// The positional parameters a `.` file with arguments replaced: put back
/// when it ends (zsh `bin_dot`, bash `source` with `maybe_pop_dollar_vars`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSave {
	/// The caller's positional parameters.
	pub args:      Vec<BString>,
	/// bash outside any function: the arguments the file got. A file that
	/// changed them keeps its own (bash keeps a top-level `set --`).
	pub installed: Option<Vec<BString>>,
}

impl CallKind {
	/// The `BASH_ARGV` push, in argument order.
	fn argv(&self) -> Option<&[BString]> {
		match self {
			Self::Function { argv, .. } | Self::Source { argv, .. } => argv.as_deref(),
			Self::Args(args) => Some(args),
		}
	}
}

/// Whether the running top-level script is a file: bash pushes the `main`
/// level (`open_shell_script`) only then, not for a `-c` string or a script
/// read from standard input.
fn has_main(store: &mut dyn StateStore, vp: &Vproc) -> Result<bool, StoreError> {
	Ok(!matches!(
		state::record(store, vp, Key::Misc(MiscKey::RunOrigin))?,
		Some(Record::Misc(origin)) if matches!(origin.as_slice(), b"c" | b"s")
	))
}

/// One of bash's call-stack arrays as `vp` sees it, innermost level first
/// (`FUNCNAME`, `BASH_SOURCE`, `BASH_LINENO`, `BASH_ARGC`, `BASH_ARGV`).
/// `None` for another name, and for `FUNCNAME` outside any function (bash
/// keeps it invisible there). Read by the expander's dynamic variables,
/// `caller` and the variable listings.
///
/// # Errors
///
/// A store failure reading the run origin.
pub fn array(
	k: &Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<Option<Vec<BString>>, StoreError> {
	let levels = || {
		vp.calls
			.iter()
			.rev()
			.filter(|c| !matches!(c.kind, CallKind::Args(_)))
	};
	Ok(Some(match name {
		b"FUNCNAME" => {
			if !in_function(vp) {
				return Ok(None);
			}
			let mut names: Vec<BString> = levels()
				.map(|c| match &c.kind {
					CallKind::Function { name, .. } => name.clone(),
					_ => BString::from("source"),
				})
				.collect();
			if has_main(store, vp)? {
				names.push(BString::from("main"));
			}
			names
		},
		b"BASH_SOURCE" => {
			let mut files: Vec<BString> = levels()
				.map(|c| match &c.kind {
					CallKind::Function { file, .. } | CallKind::Source { file, .. } => file.clone(),
					CallKind::Args(_) => BString::default(),
				})
				.collect();
			if has_main(store, vp)? {
				files.push(k.argv0.clone());
			}
			files
		},
		b"BASH_LINENO" => {
			let mut lines: Vec<BString> = levels()
				.map(|c| match c.kind {
					CallKind::Function { line, .. } | CallKind::Source { line, .. } => {
						BString::from(line.to_string())
					},
					CallKind::Args(_) => BString::default(),
				})
				.collect();
			if has_main(store, vp)? {
				lines.push(BString::from("0"));
			}
			lines
		},
		b"BASH_ARGC" | b"BASH_ARGV" => {
			// bash's `get_bashargcv`: read at the top level before any base
			// was pushed, the arrays show the positional parameters.
			let base = (!in_function(vp)
				&& !vp.calls.iter().any(|c| matches!(c.kind, CallKind::Args(_))))
			.then(|| state::positional(&k.root, store, vp))
			.transpose()?;
			argcv(vp, name, base.as_deref())
		},
		_ => return Ok(None),
	}))
}

/// `BASH_ARGC` (when `name` is it) or `BASH_ARGV` from the pushes in
/// `vp.calls`, innermost first, then `base` (the positional parameters a
/// top-level read shows before any base was pushed).
fn argcv(vp: &Vproc, name: &[u8], base: Option<&[BString]>) -> Vec<BString> {
	let pushes = vp
		.calls
		.iter()
		.rev()
		.filter_map(|c| c.kind.argv())
		.chain(base);
	if name == b"BASH_ARGC" {
		pushes
			.map(|argv| BString::from(argv.len().to_string()))
			.collect()
	} else {
		pushes.flat_map(|argv| argv.iter().rev().cloned()).collect()
	}
}

/// Whether `vp` runs inside a function call (bash's `variable_context`):
/// `FUNCNAME` is visible only then.
pub fn in_function(vp: &Vproc) -> bool {
	vp.calls
		.iter()
		.any(|c| matches!(c.kind, CallKind::Function { .. }))
}

/// The call-stack arrays as `declare`/`set` list them (bash's real arrays):
/// `(name, variable)` pairs, `FUNCNAME` invisible (`declare -a FUNCNAME`)
/// outside functions. bash's `DIRSTACK` shows the value its last read left,
/// which is empty until a script reads it: listed empty.
///
/// # Errors
///
/// A store failure reading the run origin.
pub fn listed(
	k: &Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Vec<(BString, Var)>, StoreError> {
	let indexed = |items: Vec<BString>| Var {
		attrs: Attrs::NONE,
		value: VarValue::Indexed(items.into_iter().zip(0i64..).map(|(v, i)| (i, v)).collect()),
	};
	let mut vars = Vec::with_capacity(6);
	// bash lists `BASH_ARGC`/`BASH_ARGV` as stored: the top-level base
	// `get_bashargcv` adds only on a read (`declare -a BASH_ARGC=()`).
	for name in [&b"BASH_ARGC"[..], b"BASH_ARGV"] {
		vars.push((BString::from(name), indexed(argcv(vp, name, None))));
	}
	for name in [&b"BASH_LINENO"[..], b"BASH_SOURCE"] {
		let items = array(k, store, vp, name)?.unwrap_or_default();
		vars.push((BString::from(name), indexed(items)));
	}
	vars.push((BString::from("DIRSTACK"), indexed(Vec::new())));
	let funcname = array(k, store, vp, b"FUNCNAME")?.map_or_else(
		|| Var { attrs: Attrs::INDEXED.with(Attrs::INVISIBLE), value: VarValue::Indexed(Vec::new()) },
		indexed,
	);
	vars.push((BString::from("FUNCNAME"), funcname));
	Ok(vars)
}

/// The file a function defined now records as its source (bash's
/// `make_function_def`): `BASH_SOURCE[0]`, else `$0` (a `-c` string or a
/// script on standard input).
///
/// # Errors
///
/// A store failure reading the run origin or `$0`.
pub fn definition_file(
	k: &Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<BString, StoreError> {
	let innermost = vp.calls.iter().rev().find_map(|c| match &c.kind {
		CallKind::Function { file, .. } | CallKind::Source { file, .. } => Some(file),
		CallKind::Args(_) => None,
	});
	if let Some(file) = innermost {
		return Ok(file.clone());
	}
	if has_main(store, vp)? {
		return Ok(k.argv0.clone());
	}
	state::dollar0(store, vp, &k.argv0)
}

/// bash's `get_bashargcv`: reading `BASH_ARGC`/`BASH_ARGV` outside any
/// function pushes the base (the positional parameters) once, so later
/// listings show it. Called by the expander's dynamic-variable read.
///
/// # Errors
///
/// A store failure reading the positional parameters.
pub fn read_base(k: &Kernel, store: &mut dyn StateStore, vp: &mut Vproc) -> Result<(), StoreError> {
	if in_function(vp) || vp.calls.iter().any(|c| matches!(c.kind, CallKind::Args(_))) {
		return Ok(());
	}
	let base = state::positional(&k.root, store, vp)?;
	init_argv(vp, || base);
	Ok(())
}

/// Push bash's `init_bash_argv` base (the positional parameters `args`)
/// unless it was pushed already in this shell.
fn init_argv(vp: &mut Vproc, args: impl FnOnce() -> Vec<BString>) {
	if !vp.calls.iter().any(|c| matches!(c.kind, CallKind::Args(_))) {
		vp.calls
			.push(Call { kind: CallKind::Args(args()), depth: 0 });
	}
}

/// Record a function call the frame just pushed made: `name` defined in
/// `file`, called from `line` with `args`, which `BASH_ARGV` gets under
/// `extdebug` (after the caller's positional parameters, once).
///
/// # Errors
///
/// A store failure reading `extdebug` or the positional parameters.
pub fn push_function(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	name: BString,
	file: BString,
	line: u32,
	args: &[BString],
) -> Result<(), StoreError> {
	let argv = if state::option(&mut k.root, store, vp, OptId::Extdebug)? {
		// The caller's parameters: the frame is pushed, its scope not yet.
		let base = state::positional(&k.root, store, vp)?;
		init_argv(vp, || base);
		Some(args.to_vec())
	} else {
		None
	};
	let depth = vp.frames.len() as u32;
	vp.calls
		.push(Call { kind: CallKind::Function { name, file, line, argv }, depth });
	Ok(())
}

/// Record a `.` file the frame just pushed reads: `file` as given, from
/// `line`, with arguments `args` (bash pushes the file name onto
/// `BASH_ARGV` without arguments, the arguments under `extdebug`).
///
/// # Errors
///
/// A store failure reading `extdebug` or the positional parameters.
pub fn push_source(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	file: BString,
	line: u32,
	args: &[BString],
	restore: Option<Box<SourceSave>>,
	argzero: Option<BString>,
) -> Result<(), StoreError> {
	let argv = if args.is_empty() {
		Some(vec![file.clone()])
	} else if state::option(&mut k.root, store, vp, OptId::Extdebug)? {
		let base = state::positional(&k.root, store, vp)?;
		init_argv(vp, || base);
		Some(args.to_vec())
	} else {
		None
	};
	let depth = vp.frames.len() as u32;
	vp.calls
		.push(Call { kind: CallKind::Source { file, line, argv, restore, argzero }, depth });
	Ok(())
}

/// End the pushes of frames beyond the first `frames` (popped, or a `.`
/// file whose RETURN trap runs in its caller's context), putting back the
/// positional parameters a `.` file with arguments replaced. Called by
/// `pop_frame`.
pub fn truncate(root: &mut state::Root, store: &mut dyn StateStore, vp: &mut Vproc, frames: usize) {
	while vp.calls.last().is_some_and(|c| c.depth as usize > frames) {
		let Some(Call { kind: CallKind::Source { restore: Some(save), .. }, .. }) = vp.calls.pop()
		else {
			continue;
		};
		let SourceSave { args, installed } = *save;
		if let Some(installed) = installed {
			match state::positional_ref(root, store, vp) {
				Ok(now) if now != installed.as_slice() => continue,
				Ok(_) => {},
				Err(err) => {
					root.fail(err);
					continue;
				},
			}
		}
		state::set_positional(root, store, vp, args);
	}
	vp.calls.retain(|c| c.depth as usize <= frames);
}

/// zsh `$0` inside a `.` file run under `FUNCTION_ARGZERO`, when no function
/// call is nearer: the file name as given. `None` when a function call
/// (or nothing) is the innermost level.
pub fn source_argzero(vp: &Vproc) -> Option<&BString> {
	vp.calls.iter().rev().find_map(|c| match &c.kind {
		CallKind::Source { argzero, .. } => Some(argzero.as_ref()),
		CallKind::Function { .. } => Some(None),
		CallKind::Args(_) => None,
	})?
}

/// The calls a subshell of `vp` starts with: all of them, none tied to its
/// own frames.
pub fn inherited(vp: &Vproc) -> Vec<Call> {
	vp.calls
		.iter()
		.map(|c| Call { kind: c.kind.clone(), depth: 0 })
		.collect()
}

/// The line the `.` file read by frame `frames - 1` was sourced from (its
/// RETURN trap's `$LINENO`).
pub fn source_line(vp: &Vproc, frames: usize) -> Option<u32> {
	vp.calls.iter().rev().find_map(|c| match c.kind {
		CallKind::Source { line, .. } if c.depth as usize == frames => Some(line),
		_ => None,
	})
}

/// Script line of a function body (its `{`): where bash's DEBUG trap at the
/// function's entry and its RETURN trap report (`function_line_number`).
pub fn body_line(u: &Unit) -> u32 {
	u.ops
		.first()
		.and_then(|op| u.nodes.get(op.node as usize))
		.map_or(u.line, |n| u.line + n.line)
}

/// Script line of a function's definition (`declare -F` under `extdebug`).
pub fn definition_line(u: &Unit) -> u32 {
	u.root
		.and_then(|r| u.nodes.get(r as usize))
		.map_or(u.line, |n| u.line + n.line)
}

#[cfg(test)]
mod tests {
	use bstr::BString;

	use super::{Call, CallKind};

	fn function(name: &str, argv: Option<&[&str]>, depth: u32) -> Call {
		Call {
			kind: CallKind::Function {
				name: BString::from(name),
				file: BString::from("f.sh"),
				line: 3,
				argv: argv.map(|a| a.iter().map(|s| BString::from(*s)).collect()),
			},
			depth,
		}
	}

	// Golden: bash 5.3.20 under `extdebug`, `f1 1 x` → `f2 2 y`: BASH_ARGV
	// is `y 2 x 1` then the script's arguments, BASH_ARGC `2 2 0`.
	#[test]
	fn argv_pushes_read_innermost_first_with_arguments_reversed() {
		let calls = [
			Call { kind: CallKind::Args(Vec::new()), depth: 0 },
			function("f1", Some(&["1", "x"]), 1),
			function("f2", Some(&["2", "y"]), 2),
		];
		let argv: Vec<BString> = calls
			.iter()
			.rev()
			.filter_map(|c| c.kind.argv())
			.flat_map(|a| a.iter().rev().cloned())
			.collect();
		assert_eq!(argv, ["y", "2", "x", "1"]);
		let argc: Vec<usize> = calls
			.iter()
			.rev()
			.filter_map(|c| c.kind.argv())
			.map(<[BString]>::len)
			.collect();
		assert_eq!(argc, [2, 2, 0]);
	}

	#[test]
	fn a_function_without_extdebug_pushes_no_arguments() {
		assert_eq!(function("f", None, 1).kind.argv(), None);
	}
}
