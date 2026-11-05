//! bash's call-stack arrays: `FUNCNAME`, `BASH_SOURCE`, `BASH_LINENO`,
//! `BASH_ARGC` and `BASH_ARGV`, and what `caller`, `declare -F` (under
//! `extdebug`) and the DEBUG/RETURN traps read from them.
//!
//! bash keeps them as real arrays it pushes and pops around function calls
//! and `.` files (`execute_function`, `_evalfile`). Here a vproc keeps the
//! pushes as [`Call`]s ([`Vproc::calls`]). A frame's level leaves with the
//! frame, but an argument push can outlive it; a subshell inherits both.
//! The arrays are built from the remaining pushes when read.

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
	pub kind:     CallKind,
	/// The frame count right after the frame that made the level (its index
	/// plus one). 0 for an inherited level or a bare argument push.
	pub depth:    u32,
	/// An unconditional `pop_args` registered by `execute_function`
	/// (`execute_cmd.c:5343-5347`) or an argument-less `.` (`_evalfile`,
	/// `evalfile.c:270-278`). A `.` with arguments instead tests `extdebug`
	/// at exit (`uw_maybe_pop_dollar_vars`, `source.def:102-109`), even if
	/// no arguments were pushed at entry. Each pop takes the innermost
	/// remaining push, not necessarily this level's own arguments.
	pub pop_args: bool,
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
		/// bash runs a `.` file's RETURN trap between `_evalfile`, which
		/// pops the `FUNCNAME`/`BASH_SOURCE`/`BASH_LINENO` level, and
		/// `source_builtin`, which puts the positional parameters back and
		/// pops the `BASH_ARGV` push. While the trap runs this is set: the
		/// level is out of those three arrays and still on the other two.
		ended:   bool,
		/// zsh FUNCTION_ARGZERO at the `.`: `$0` while the file runs (the
		/// file name as given).
		argzero: Option<BString>,
	},
	/// An argument push with no frame level: `init_bash_argv`'s base, or
	/// arguments left behind when a level's end did not pop them.
	Args(Vec<BString>),
}

/// The positional parameters a `.` file with arguments replaced: put back
/// when it ends (zsh `bin_dot`, bash `source` with `maybe_pop_dollar_vars`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSave {
	/// The caller's positional parameters.
	pub args: Vec<BString>,
	/// bash: outside any function the file keeps its own when the `set`
	/// builtin replaced them while it ran ([`Vproc::args_set`]). zsh's
	/// `bin_dot` always puts the caller's back.
	pub bash: bool,
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

/// Whether a push is a level of `FUNCNAME`, `BASH_SOURCE`, `BASH_LINENO`
/// and `caller`: the `BASH_ARGV` base never is, and a `.` file whose
/// RETURN trap is running has already left them ([`CallKind::Source`]'s
/// `ended`) while it is still on `BASH_ARGC`/`BASH_ARGV`.
const fn level_visible(kind: &CallKind) -> bool {
	match kind {
		CallKind::Args(_) => false,
		CallKind::Source { ended, .. } => !*ended,
		CallKind::Function { .. } => true,
	}
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
	let levels = || vp.calls.iter().rev().filter(|c| level_visible(&c.kind));
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
			let base = (!in_function(vp) && !vp.argv_init)
				.then(|| state::positional_scoped(&k.root, store, vp).map(<[BString]>::to_vec))
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
	let mut vars = Vec::with_capacity(6);
	for name in
		[&b"BASH_ARGC"[..], b"BASH_ARGV", b"BASH_LINENO", b"BASH_SOURCE", b"DIRSTACK", b"FUNCNAME"]
	{
		if let Some(var) = listed_array(k, store, vp, name)? {
			vars.push((BString::from(name), var));
		}
	}
	Ok(vars)
}

/// One call-stack array as `declare`/`set` list it, without invoking
/// `get_bashargcv`. A named `declare -p` invokes that getter separately.
/// `None` for a name this module does not list.
///
/// # Errors
///
/// A store failure reading the run origin.
pub fn listed_array(
	k: &Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<Option<Var>, StoreError> {
	let items = match name {
		// bash's listing path reads the stored arrays, not the dynamic
		// getter: a listing alone does not initialize the base.
		b"BASH_ARGC" | b"BASH_ARGV" => Some(argcv(vp, name, None)),
		b"DIRSTACK" => Some(Vec::new()),
		b"BASH_LINENO" | b"BASH_SOURCE" | b"FUNCNAME" => array(k, store, vp, name)?,
		_ => return Ok(None),
	};
	let attrs = if items.is_none() {
		Attrs::INDEXED.with(Attrs::INVISIBLE)
	} else {
		Attrs::NONE
	};
	Ok(Some(Var {
		attrs,
		value: VarValue::Indexed(
			items
				.unwrap_or_default()
				.into_iter()
				.zip(0i64..)
				.map(|(v, i)| (i, v))
				.collect(),
		),
	}))
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
	let innermost = vp
		.calls
		.iter()
		.rev()
		.filter(|c| level_visible(&c.kind))
		.find_map(|c| match &c.kind {
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
	if !in_function(vp) {
		init_argv(k, store, vp)?;
	}
	Ok(())
}

/// bash's `init_bash_argv`: push the current positional parameters once
/// per shell. The initialized flag stays set even if a later `pop_args`
/// removes the base. `shopt_set_debug_mode` calls this inside functions too.
///
/// The base goes at the bottom, below any filename or function pushes.
///
/// # Errors
///
/// A store failure reading the positional parameters.
pub fn init_argv(k: &Kernel, store: &mut dyn StateStore, vp: &mut Vproc) -> Result<(), StoreError> {
	if !vp.argv_init {
		let args = state::positional_scoped(&k.root, store, vp)?.to_vec();
		vp.calls
			.insert(0, Call { kind: CallKind::Args(args), depth: 0, pop_args: false });
		vp.argv_init = true;
	}
	Ok(())
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
	// bash's `execute_function` gives the function its own parameters, which
	// ends the enclosing `.` file's record of a `set` of its own: a file that
	// calls a function, with or without arguments, puts the caller's
	// parameters back. Measured on Bash 5.2.21 and 5.3.0.
	vp.args_set = false;
	let argv = if state::option(&mut k.root, store, vp, OptId::Extdebug)? {
		// The caller's parameters: the frame is pushed, its scope not yet.
		init_argv(k, store, vp)?;
		Some(args.to_vec())
	} else {
		None
	};
	let depth = vp.frames.len() as u32;
	vp.calls.push(Call {
		pop_args: argv.is_some(),
		kind: CallKind::Function { name, file, line, argv },
		depth,
	});
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
	let extdebug = state::option(&mut k.root, store, vp, OptId::Extdebug)?;
	if !extdebug && !in_function(vp) && vp.mode.dialect() == crate::bash::ids::Dialect::Bash {
		// `_evalfile` looks up both arrays through `get_bashargcv` after
		// `source_builtin` installed the file's arguments. A failed open
		// never reaches this lookup (Bash 5.3).
		init_argv(k, store, vp)?;
	}
	let argv = if args.is_empty() {
		Some(vec![file.clone()])
	} else if extdebug {
		Some(args.to_vec())
	} else {
		None
	};
	let depth = vp.frames.len() as u32;
	vp.calls.push(Call {
		kind: CallKind::Source { file, line, argv, restore, argzero, ended: false },
		depth,
		pop_args: args.is_empty(),
	});
	Ok(())
}

/// End the pushes of frames beyond the first `frames` (popped, or a `.`
/// file whose RETURN trap runs in its caller's context), putting back the
/// positional parameters a `.` file with arguments replaced. Called by
/// `pop_frame`.
///
/// bash's `maybe_pop_dollar_vars`: the caller's parameters come back unless
/// the shell is outside any function and the `set` builtin replaced them
/// while the file ran ([`Vproc::args_set`], which the file's end clears
/// either way). zsh's `bin_dot` always puts them back.
pub fn truncate(root: &mut state::Root, store: &mut dyn StateStore, vp: &mut Vproc, frames: usize) {
	// `pop_args` can leave detached pushes above a level that is ending.
	// Find that level rather than assuming the last push belongs to it.
	while let Some(mut index) = vp.calls.iter().rposition(|c| c.depth as usize > frames) {
		let pop_args = match &vp.calls[index].kind {
			CallKind::Source { restore: Some(save), .. } if save.bash => {
				// `uw_maybe_pop_dollar_vars`: only a source with arguments
				// tests debugging_mode at exit, not when its push was made.
				match state::option(root, store, vp, OptId::Extdebug) {
					Ok(on) => on,
					Err(err) => {
						root.fail(err);
						false
					},
				}
			},
			_ => vp.calls[index].pop_args,
		};
		if pop_args {
			index = pop_argv(vp, index);
		}
		let (argv, restore) = match vp.calls.remove(index).kind {
			CallKind::Source { argv, restore, .. } => (argv, restore),
			CallKind::Function { argv, .. } => (argv, None),
			CallKind::Args(_) => continue,
		};
		if let Some(argv) = argv {
			// bash's argument arrays are separate from the frame arrays:
			// a push not consumed by `pop_args` survives the level's end,
			// in its original position relative to every other push.
			vp.calls.insert(index, Call {
				kind:     CallKind::Args(argv),
				depth:    0,
				pop_args: false,
			});
		}
		let Some(save) = restore else { continue };
		let SourceSave { args, bash } = *save;
		if bash {
			let kept = vp.args_set
				&& match state::func_scope(root, store, vp) {
					Ok(scope) => scope.is_none(),
					Err(err) => {
						root.fail(err);
						false
					},
				};
			vp.args_set = false;
			if kept {
				continue;
			}
		}
		state::set_positional(root, store, vp, args);
	}
}

/// bash's `pop_args`: consume one innermost argument push, independently
/// of its owner. Return the ending level's index after removing a bare push.
fn pop_argv(vp: &mut Vproc, owner: usize) -> usize {
	let Some(index) = vp.calls.iter().rposition(|c| c.kind.argv().is_some()) else {
		return owner;
	};
	match &mut vp.calls[index].kind {
		CallKind::Function { argv, .. } | CallKind::Source { argv, .. } => *argv = None,
		CallKind::Args(_) => {
			vp.calls.remove(index);
			if index < owner {
				return owner - 1;
			}
		},
	}
	owner
}

pub fn source_argzero(vp: &Vproc) -> Option<&BString> {
	vp.calls
		.iter()
		.rev()
		.filter(|c| level_visible(&c.kind))
		.find_map(|c| match &c.kind {
			CallKind::Source { argzero, .. } => Some(argzero.as_ref()),
			CallKind::Function { .. } => Some(None),
			CallKind::Args(_) => None,
		})?
}

/// Take the `.` file read by frame `frames - 1` out of `FUNCNAME`,
/// `BASH_SOURCE`, `BASH_LINENO` and `caller`, leaving its `BASH_ARGV` push
/// and the positional parameters it saved: bash runs the file's RETURN
/// trap between the two (`_evalfile` pops the level, `source_builtin`
/// puts the parameters back afterwards).
pub fn end_source(vp: &mut Vproc, frames: usize) {
	if let Some(Call { kind: CallKind::Source { ended, .. }, .. }) = vp
		.calls
		.iter_mut()
		.rev()
		.find(|c| c.depth as usize == frames)
	{
		*ended = true;
	}
}

/// Push bash's `init_bash_argv` base for a host callout about to replace
/// `vp`'s positional parameters with its operand's: the subshell inherits
/// the push, so the operand reads the caller's arguments on `BASH_ARGV`
/// rather than the command the callout runs its operand from. Only under
/// `extdebug`, which is the only state in which bash pushes a base when a
/// level is entered.
///
/// # Errors
///
/// A store failure reading `extdebug` or the positional parameters.
pub fn push_callout_base(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
) -> Result<(), StoreError> {
	if state::option(&mut k.root, store, vp, OptId::Extdebug)? {
		init_argv(k, store, vp)?;
	}
	Ok(())
}

/// The calls a subshell of `vp` starts with: all of them, none tied to its
/// own frames.
pub fn inherited(vp: &Vproc) -> Vec<Call> {
	vp.calls
		.iter()
		.map(|c| Call { kind: c.kind.clone(), depth: 0, pop_args: false })
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
			pop_args: argv.is_some(),
		}
	}

	// Golden: bash 5.3.20 under `extdebug`, `f1 1 x` → `f2 2 y`: BASH_ARGV
	// is `y 2 x 1` then the script's arguments, BASH_ARGC `2 2 0`.
	#[test]
	fn argv_pushes_read_innermost_first_with_arguments_reversed() {
		let calls = [
			Call { kind: CallKind::Args(Vec::new()), depth: 0, pop_args: false },
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
