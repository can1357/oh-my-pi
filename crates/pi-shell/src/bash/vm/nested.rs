//! The in-engine nested shell: a command the host resolves to
//! [`Resolved::SelfShell`](crate::bash::Resolved::SelfShell) (`bash`, `sh`)
//! runs as a child vproc with a fresh shell's state instead of an OS process.
//!
//! The child's overlay hides everything its parent shell sees (variables,
//! functions, aliases, the hash table, traps, the directory stack, jobs)
//! and holds what a new bash starts with: the exported environment of the
//! command, bash's startup variables, the invocation's options
//! ([`crate::bash::invocation::ShellArgs`]), `$0`, the positional parameters,
//! its own `$$` (its vpid), `$BASH_SUBSHELL` zero and `SHLVL` one more. Signals
//! the parent ignores stay ignored. It reads its commands from `-c`, a
//! script file or its standard input, after the startup files
//! (`BASH_ENV`); the command's status is its exit status.
//!
//! A text file the OS would not execute (`ENOEXEC`, no `#!`) starts the
//! same way ([`start_script`]): bash's `shell_execve` reinitializes the
//! shell from the command's environment and reads the file as its script.

use bstr::{BString, ByteSlice};

use super::{
	Cx, Kernel, builtins,
	command::command_probe,
	exec::{self, Flow, push_script},
	imported_function, is_ident, probe,
	proc::{
		Awaited, ExecState, Frame, FrameKind, PendingWrite, Probe, ProbeResult, ScriptKind, Stage,
		Vproc,
	},
	startup_values,
	state::{self, Overlay, Var},
};
use crate::bash::{
	event::{EventData, WaitKey},
	host::EnvView,
	ids::ModeId,
	invocation::{self, Input, ShellArgs},
	store::{Attrs, Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, Table, TrapKey},
};

fn st(vp: &mut Vproc) -> &mut ExecState {
	exec::scratch(vp)
		.exec
		.as_mut()
		.expect("Exec state is created first")
}

/// Whether `vp` is a nested shell's own vproc (not one of its subshells).
fn is_nested_root(store: &mut dyn StateStore, vp: &Vproc) -> bool {
	matches!(
		state::record(store, vp, Key::Misc(MiscKey::NestedShell)),
		Ok(Some(Record::Misc(v))) if v.as_slice() == vp.vpid.0.to_string().as_bytes()
	)
}

/// Whether `vp` runs in a subshell (bash's `subshell_environment`): a child
/// vproc that is not a nested shell itself.
pub fn in_subshell(store: &mut dyn StateStore, vp: &Vproc) -> bool {
	vp.parent.is_some() && !is_nested_root(store, vp)
}

/// Finish the command with `bytes` written to its `fd` and `status`.
fn reply(vp: &mut Vproc, fd: i32, bytes: Vec<u8>, status: i32) -> Option<Flow> {
	let s = st(vp);
	s.writes
		.push_back(PendingWrite { fd, bytes: bytes.into(), off: 0 });
	s.status = status;
	s.stage = Stage::Output;
	None
}

/// `NAME: FILE: what` and a newline.
fn message(name: &[u8], file: &[u8], what: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(name.len() + file.len() + what.len() + 5);
	out.extend_from_slice(name);
	out.extend_from_slice(b": ");
	out.extend_from_slice(file);
	out.extend_from_slice(b": ");
	out.extend_from_slice(what);
	out.push(b'\n');
	out
}

/// Start the nested shell for the command in `vp` (its argv parsed as
/// bash's command line, `env` its environment) and wait for it. Invocation
/// errors, `--help` and `--version` answer at once, as bash does.
pub fn start(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
	env: &EnvView,
) -> Option<Flow> {
	let argv = st(vp).argv.clone();
	let args = match ShellArgs::parse(&argv) {
		Ok(args) => args,
		Err(err) => return reply(vp, 2, err.render(&argv[0]), err.status()),
	};
	if args.help {
		return reply(vp, 1, invocation::help_text(&args.shell_name), 0);
	}
	if args.version {
		return reply(vp, 1, invocation::version_text(), 0);
	}
	if args.pretty_print {
		let diag = crate::bash::diag::Diag::Unsupported {
			what: std::borrow::Cow::Borrowed("--pretty-print in a nested shell"),
		};
		k.diag(cx, vp, line, diag);
		let s = st(vp);
		s.status = 2;
		s.stage = Stage::Output;
		return None;
	}
	let pairs = env_pairs(env);
	let dollar0 = args.dollar0_in(&pairs);
	// What the shell reads: `-c`, the script (bash's `open_shell_script`
	// messages and statuses) or its standard input.
	let (src, stdin, origin) = match &args.input {
		Input::Command(cmd) => (cmd.clone(), false, "c"),
		Input::Stdin => (BString::default(), true, "s"),
		Input::Script(name) => {
			let path = probe::absolute(&vp.cwd, name);
			match command_probe(k, cx, vp, &Probe::Read { path }) {
				Err(key) => return Some(Flow::Block(key)),
				Ok(ProbeResult::Bytes(Ok(text))) => {
					let head = &text[..text.len().min(80)];
					let first = head.split(|&c| c == b'\n').next().unwrap_or(head);
					if first.contains(&0) {
						let text = message(&dollar0, name, b"cannot execute binary file");
						return reply(vp, 2, text, 126);
					}
					(text, false, "")
				},
				Ok(ProbeResult::Bytes(Err(msg))) if msg.as_slice() == b"Is a directory" => {
					return reply(vp, 2, message(&dollar0, name, &msg), 126);
				},
				Ok(ProbeResult::Bytes(Err(msg))) => {
					let status = if msg.as_slice() == b"No such file or directory" {
						127
					} else {
						126
					};
					return reply(vp, 2, message(&args.shell_name, name, &msg), status);
				},
				Ok(_) => (BString::default(), false, ""),
			}
		},
	};
	let new = New { args: &args, env, pairs: &pairs, dollar0: &dollar0, origin };
	launch(k, vp, cx, &new, &src, stdin)
}

/// Run `text`, the file at `path` the OS would not execute (`ENOEXEC`), as
/// bash's `shell_execve` does: the shell starts over as a new one (see the
/// module docs) from the command's environment `env` and reads the file as
/// its script, `$0` the path, the command's arguments its positional
/// parameters. An `sh` starts an `sh`, as does zsh, which runs `/bin/sh`.
pub fn start_script(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	env: &EnvView,
	path: &[u8],
	text: &[u8],
) -> Option<Flow> {
	let shell = if vp.mode == ModeId::Bash {
		"bash"
	} else {
		"sh"
	};
	let mut argv = vec![BString::from(shell), BString::from("--"), BString::from(path)];
	argv.extend_from_slice(st(vp).argv.get(1..).unwrap_or_default());
	let args = match ShellArgs::parse(&argv) {
		Ok(args) => args,
		Err(err) => return reply(vp, 2, err.render(&argv[0]), err.status()),
	};
	let pairs = env_pairs(env);
	let dollar0 = args.dollar0_in(&pairs);
	let new = New { args: &args, env, pairs: &pairs, dollar0: &dollar0, origin: "" };
	launch(k, vp, cx, &new, text, false)
}

/// The environment as name/value pairs.
fn env_pairs(env: &EnvView) -> Vec<(BString, BString)> {
	env.iter()
		.map(|(n, v)| (BString::from(n.as_bytes()), BString::from(v.as_bytes())))
		.collect()
}

/// What a new shell starts from.
struct New<'a> {
	args:    &'a ShellArgs,
	env:     &'a EnvView,
	/// [`Self::env`] as pairs.
	pairs:   &'a [(BString, BString)],
	dollar0: &'a [u8],
	/// `$-`'s `c` or `s` (`MiscKey::RunOrigin`), empty for a script.
	origin:  &'static str,
}

/// Start the new shell `new` describes, reading `src` (standard input when
/// `stdin`) after its startup files, and wait for it.
#[expect(
	clippy::unnecessary_wraps,
	reason = "`start` and `start_script` both return `Option<Flow>` (the nested-shell entry \
	          protocol), so the wrap is shared by every caller"
)]
fn launch(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	new: &New<'_>,
	src: &[u8],
	stdin: bool,
) -> Option<Flow> {
	let New { args, env, pairs, dollar0, origin } = *new;
	// The startup files (`BASH_ENV` for a non-interactive bash): the first
	// readable candidate of each.
	let home = env
		.get(b"HOME")
		.map_or_else(|| cx.host.user().home, |h| BString::from(h.as_bytes()));
	let mut startup = Vec::new();
	let mut notes = Vec::new();
	// A program's shell sets up no user completion or history: an
	// interactive nested shell skips its rc files
	// ([`crate::bash::Profile::Tool`]).
	let rc = match super::is_tool(cx.store, vp) {
		Ok(tool) => !tool,
		Err(err) => {
			k.fail(err);
			return Some(Flow::Discard(1));
		},
	};
	match args.startup_files_with(pairs, &home, args.interactive, rc) {
		Ok(files) => {
			for candidates in files {
				for path in candidates {
					let path = probe::absolute(&vp.cwd, &path);
					match command_probe(k, cx, vp, &Probe::Read { path }) {
						Err(key) => return Some(Flow::Block(key)),
						Ok(ProbeResult::Bytes(Ok(text))) => {
							startup.push(text);
							break;
						},
						Ok(_) => {},
					}
				}
			}
		},
		Err(err) => {
			notes.extend_from_slice(&args.shell_name);
			notes.extend_from_slice(b": ");
			notes.extend_from_slice(err.to_string().as_bytes());
			notes.push(b'\n');
		},
	}
	let mut child = match fresh_shell(k, cx, vp, args, pairs, dollar0, origin) {
		Ok(child) => child,
		Err(err) => {
			k.fail(err);
			return Some(Flow::Discard(1));
		},
	};
	if let Some(text) = args.listing_text() {
		child
			.out
			.push_back(PendingWrite { fd: 1, bytes: text.into(), off: 0 });
	}
	if !notes.is_empty() {
		child
			.out
			.push_back(PendingWrite { fd: 2, bytes: notes.into(), off: 0 });
	}
	let mut kind = FrameKind::script(src, crate::bash::syntax::Pos::START, ScriptKind::Run);
	if let FrameKind::Script { stdin: s, .. } = &mut kind {
		*s = stdin;
	}
	child.frames.push(Frame::new(None, 0, kind));
	if k.mask.contains(crate::bash::event::EventKind::UnitCompiled)
		&& !stdin
		&& k.trace_sources.len() < crate::bash::trace::history::HISTORY_EVENTS
		&& let Some(origin) = exec::literal_script_origin(vp, src, true)
	{
		k.trace_sources
			.entry(child.vpid)
			.or_default()
			.insert(child.frames.len(), origin);
	}
	for text in startup.iter().rev() {
		push_script(&mut child, text, 1, ScriptKind::Source);
	}
	let vpid = child.vpid;
	k.emit_op(cx, vp, 0, EventData::Subshell { child: vpid });
	k.spawned.push(Box::new(child));
	let s = st(vp);
	s.wait_for = vec![vpid];
	s.waiting = Some(Awaited::Jobs { force: true });
	s.stage = Stage::Await;
	Some(Flow::Block(WaitKey::Proc(vpid)))
}

/// A child of `vp` holding a new shell's state (see the module docs).
fn fresh_shell(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	args: &ShellArgs,
	env: &[(BString, BString)],
	dollar0: &[u8],
	origin: &str,
) -> Result<Vproc, StoreError> {
	let vpid = k.vpid(cx.store);
	let mut ov = Overlay::default();
	// Nothing of the parent shell shows through.
	for (key, _) in state::scan(&k.root, cx.store, vp, Table::Var)? {
		if let KeyBuf::Var(name) = key {
			ov.vars.insert(name, None);
		}
	}
	for table in [Table::Func, Table::Alias, Table::CmdHash, Table::DirStack, Table::Job] {
		for (key, _) in state::scan(&k.root, cx.store, vp, table)? {
			ov.records.insert(key, None);
		}
	}
	// Signals ignored by the parent stay ignored (a new process inherits
	// them); every other trap is reset.
	for (key, rec) in state::scan(&k.root, cx.store, vp, Table::Trap)? {
		let ignored = matches!(
			(&key, &rec),
			(KeyBuf::Trap(TrapKey::Signal(_)), Record::Trap { action, .. }) if action.is_empty()
		);
		if !ignored {
			ov.records.insert(key, None);
		}
	}
	for key in [
		MiscKey::LastBg,
		MiscKey::LastArg,
		MiscKey::History,
		MiscKey::HistoryCounts,
		MiscKey::HistoryTimes,
		MiscKey::ZshHistory,
		MiscKey::ZshHistoryState,
		MiscKey::ZshHistoryLine,
		MiscKey::ZshHistoryStack,
		MiscKey::DisabledBuiltins,
		MiscKey::LoadedBuiltins,
		MiscKey::ForeignEnv,
		MiscKey::HardIgnored,
	] {
		ov.records.insert(KeyBuf::Misc(key), None);
	}
	let vpid_text = BString::from(vpid.0.to_string());
	let interactive = if args.interactive { "1" } else { "0" };
	for (key, value) in [
		(MiscKey::Argv0, BString::from(dollar0)),
		(MiscKey::Dollar0, BString::from(dollar0)),
		(MiscKey::ShellPid, vpid_text.clone()),
		(MiscKey::NestedShell, vpid_text),
		(MiscKey::Status, BString::from("0")),
		(MiscKey::RunOrigin, BString::from(origin)),
		(MiscKey::Interactive, BString::from(interactive)),
	] {
		ov.records
			.insert(KeyBuf::Misc(key), Some(Record::Misc(value)));
	}
	ov.positional = Some(args.args.clone());
	// The environment, as `Shell::create` imports it.
	let mut foreign = Vec::new();
	for (name, value) in env {
		if let Some(func) = name
			.strip_prefix(b"BASH_FUNC_")
			.and_then(|n| n.strip_suffix(b"%%"))
		{
			if let Some(rec) = imported_function(k, func, value) {
				if let Record::Func { unit, .. } = &rec
					&& let Some(unit) = k.engine.cached(unit)
				{
					exec::announce(k, cx, vp.vpid, vp.runs.front(), &unit, unit.line);
				}
				ov.records
					.insert(KeyBuf::Func(BString::from(func)), Some(rec));
			}
		} else if is_ident(name) {
			ov.vars
				.insert(name.clone(), Some(Var::scalar(value.clone(), Attrs::EXPORT)));
		} else {
			let mut entry = name.clone();
			entry.push(b'=');
			entry.extend_from_slice(value);
			foreign.push(entry);
		}
	}
	if !foreign.is_empty() {
		ov.records
			.insert(KeyBuf::Misc(MiscKey::ForeignEnv), Some(Record::Words(foreign)));
	}
	if !matches!(ov.vars.get(&b"PWD"[..]), Some(Some(_))) {
		ov.vars
			.insert(BString::from("PWD"), Some(Var::scalar(vp.cwd.clone(), Attrs::EXPORT)));
	}
	let zsh = args.mode.dialect() == crate::bash::ids::Dialect::Zsh;
	let shlvl = env
		.iter()
		.find(|(n, _)| n.as_slice() == b"SHLVL")
		.map_or(0, |(_, v)| super::imported_shlvl(v, zsh));
	ov.vars
		.insert(BString::from("SHLVL"), Some(Var::scalar((shlvl + 1).to_string(), Attrs::EXPORT)));
	// `$PPID` is the parent shell's `$$`.
	let ppid = match state::record(cx.store, vp, Key::Misc(MiscKey::ShellPid))? {
		Some(Record::Misc(v)) => std::str::from_utf8(v)
			.ok()
			.and_then(|v| v.parse().ok())
			.unwrap_or(k.shell_pid),
		_ => k.shell_pid,
	};
	let need_shell = !matches!(ov.vars.get(&b"SHELL"[..]), Some(Some(_)));
	let values = if args.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		super::zsh_startup_values(cx, k.engine.config().platform)
	} else {
		startup_values(cx, &args.shell_name, ppid, k.engine.config().platform, super::StartupVars {
			lookup_shell: need_shell,
			interactive:  args.interactive,
		})
	};
	for (name, var, forced) in values {
		if forced || !matches!(ov.vars.get(name), Some(Some(_))) {
			ov.vars.insert(BString::from(name), Some(var));
		}
	}
	let mut child = Vproc::new(vpid, Some(vp.vpid), vp.fds.clone(), vp.cwd.clone(), Some(ov), true);
	child.rlimits.clone_from(&vp.rlimits);
	child.lineage = vp.lineage;
	// A new shell's options, then the invocation's.
	state::reset_options(&mut k.root, cx.store, &mut child);
	for opt in [OptId::LoginShell, OptId::RestrictedShell] {
		let rec = Some(Record::Opt(false));
		state::store_record(&mut k.root, cx.store, &mut child, KeyBuf::Opt(opt), rec);
	}
	for (opt, on) in args.startup_options(env, args.interactive) {
		if opt == OptId::Posix {
			state::set_posix(&mut k.root, cx.store, &mut child, on)?;
		} else {
			let rec = Some(Record::Opt(on));
			state::store_record(&mut k.root, cx.store, &mut child, KeyBuf::Opt(opt), rec);
		}
	}
	state::sync_option_vars(&mut k.root, cx.store, &mut child)?;
	child.mode = args.mode;
	child.zsh = None;
	if args.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		let start = super::mode::ZshStart {
			mode:        args.mode,
			options:     &args.zsh_options,
			interactive: args.interactive,
			login:       args.login_flag || args.login_name,
			stdin:       matches!(args.input, Input::Stdin),
		};
		super::mode::init_zsh_options(&mut k.root, cx.store, &mut child, &start)?;
	}
	builtins::hard_ignore(k, cx.store, vp, &mut child)?;
	Ok(child)
}
