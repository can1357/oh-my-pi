//! `builtin` (without a command), `enable`, `times`, `ulimit` and the
//! `strmatch` loadable (bash `builtins/{builtin,enable,times,ulimit}.def`,
//! `examples/loadables/strmatch.c`).

use bstr::{BString, ByteSlice};

use super::{Ctx, R, doc_table::TABLE, done, help::STRMATCH, io::invalid_number, opts};
use crate::bash::{
	diag::Diag,
	host::Rlimit,
	ids::IntrinsicId,
	pattern::PatOpts,
	store::{Key, KeyBuf, MiscKey, Record, StateStore, StoreError},
	vm::{Kernel, locale, proc::Vproc, quote, state},
};

/// A list-valued misc record (`Record::Words`).
fn words(store: &mut dyn StateStore, vp: &Vproc, key: MiscKey) -> Result<Vec<BString>, StoreError> {
	Ok(match state::record(store, vp, Key::Misc(key))? {
		Some(Record::Words(w)) => w.clone(),
		_ => Vec::new(),
	})
}

/// Store a list-valued misc record (removed when empty).
fn store_words(ctx: &mut Ctx<'_, '_>, key: MiscKey, list: Vec<BString>) {
	let rec = (!list.is_empty()).then_some(Record::Words(list));
	ctx.store_record(KeyBuf::Misc(key), rec);
}

/// Whether the loadable builtin `name` was loaded by `enable -f`.
pub fn loaded(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<bool, StoreError> {
	Ok(words(ctx.cx.store, ctx.vp, MiscKey::LoadedBuiltins)?
		.iter()
		.any(|w| w == name))
}

/// Whether the builtin `name` is enabled (not `enable -n`'d).
pub fn enabled(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<bool, StoreError> {
	Ok(!words(ctx.cx.store, ctx.vp, MiscKey::DisabledBuiltins)?
		.iter()
		.any(|w| w == name))
}

/// The builtin command `name` resolves to, given what the host resolved
/// it to: `None` when `enable -n` disabled it, `strmatch` only once
/// `enable -f` loaded it. Command lookup, `type` and `command -v` call
/// this after `Host::resolve`.
pub fn usable(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
	resolved: Option<IntrinsicId>,
) -> Result<Option<IntrinsicId>, StoreError> {
	// Runs for every builtin command: nothing disabled (the root's flag,
	// unless a subshell changed the list) skips the list.
	let disabled = match vp
		.overlay
		.as_ref()
		.and_then(|ov| ov.records.get(&KeyBuf::Misc(MiscKey::DisabledBuiltins)))
	{
		Some(Some(Record::Words(w))) => w.iter().any(|w| w == name),
		Some(_) => false,
		None => {
			k.root.builtins_disabled(store)?
				&& matches!(
					store.get(Key::Misc(MiscKey::DisabledBuiltins))?,
					Some(Record::Words(w)) if w.iter().any(|w| w == name)
				)
		},
	};
	if disabled {
		return Ok(None);
	}
	// A program's shell is a bash without readline
	// ([`crate::bash::Profile::Tool`]): no programmable completion, no key
	// bindings.
	if matches!(
		resolved,
		Some(IntrinsicId::Compgen | IntrinsicId::Complete | IntrinsicId::Compopt | IntrinsicId::Bind)
	) && crate::bash::vm::is_tool(store, vp)?
	{
		return Ok(None);
	}
	if name == b"strmatch" {
		let on = words(store, vp, MiscKey::LoadedBuiltins)?
			.iter()
			.any(|w| w == name);
		return Ok(on.then_some(IntrinsicId::Strmatch));
	}
	let resolved = resolved.filter(|&id| id != IntrinsicId::Strmatch);
	// A zsh module's builtin exists while the module provides it or an
	// autoload stub names it.
	if let Some(id) = resolved
		&& super::zsh_module::module_of(id).is_some()
		&& !super::zsh_module::builtin_present(store, vp, id, name)?
	{
		return Ok(None);
	}
	// zsh: an autoload stub of a builtin no module of the engine defines
	// (`zmodload -ab M NAME`) is a builtin, found before the path.
	if resolved.is_none()
		&& vp.mode.dialect() == crate::bash::ids::Dialect::Zsh
		&& super::zsh_module::builtin_stub(store, vp, name)?
	{
		return Ok(Some(IntrinsicId::ModuleStub));
	}
	Ok(resolved)
}

/// The builtin names `enable` knows, sorted as bash's table: bash's
/// builtins plus loaded ones, with whether each is a special builtin.
fn builtin_names(ctx: &mut Ctx<'_, '_>) -> Result<Vec<(&'static str, bool)>, StoreError> {
	let mut names: Vec<(&'static str, bool)> = TABLE
		.iter()
		.filter(|e| e.command)
		.map(|e| (e.name, e.special))
		.collect();
	if loaded(ctx, STRMATCH.name.as_bytes())? {
		names.push((STRMATCH.name, false));
		names.sort_by_key(|&(n, _)| n.as_bytes());
	}
	Ok(names)
}

/// `enable [-a] [-dnps] [-f filename] [name ...]`.
pub fn enable(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"adnps", b"f", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let (all, disable, special) = (o.has(b'a'), o.has(b'n'), o.has(b's'));
	let names = builtin_names(ctx)?;
	let mut disabled = words(ctx.cx.store, ctx.vp, MiscKey::DisabledBuiltins)?;
	if o.rest.is_empty() || o.has(b'p') {
		let mut out = Vec::new();
		for (name, is_special) in names {
			if special && !is_special {
				continue;
			}
			let on = !disabled.iter().any(|d| d == name);
			if on && (all || !disable) {
				out.extend_from_slice(format!("enable {name}\n").as_bytes());
			} else if !on && (all || disable) {
				out.extend_from_slice(format!("enable -n {name}\n").as_bytes());
			}
		}
		ctx.out(&out);
		return done(0);
	}
	if let Some(file) = o.arg(b'f') {
		return load(ctx, file, o.rest, disable);
	}
	let mut status = 0;
	if o.has(b'd') {
		let mut loaded_list = words(ctx.cx.store, ctx.vp, MiscKey::LoadedBuiltins)?;
		for name in o.rest {
			if let Some(i) = loaded_list.iter().position(|l| l == name) {
				loaded_list.remove(i);
				disabled.retain(|d| d != name);
			} else if names.iter().any(|&(n, _)| n.as_bytes() == name.as_slice()) {
				ctx.usage(format!("{}: not dynamically loaded", name.as_bstr()));
				status = 1;
			} else {
				ctx.err(Diag::NotABuiltin { name: name.clone() });
				status = 1;
			}
		}
		store_words(ctx, MiscKey::LoadedBuiltins, loaded_list);
		store_words(ctx, MiscKey::DisabledBuiltins, disabled);
		return done(status);
	}
	for name in o.rest {
		if !names.iter().any(|&(n, _)| n.as_bytes() == name.as_slice()) {
			ctx.err(Diag::NotABuiltin { name: name.clone() });
			status = 1;
			continue;
		}
		disabled.retain(|d| d != name);
		if disable {
			disabled.push(name.clone());
		}
	}
	store_words(ctx, MiscKey::DisabledBuiltins, disabled);
	done(status)
}

/// `enable -f FILE name …`: the loadables the engine implements natively
/// (`strmatch`) load without opening FILE; any other one fails loudly,
/// since the engine loads no shared objects.
fn load(ctx: &mut Ctx<'_, '_>, file: &[u8], names: &[BString], disable: bool) -> R {
	let mut loaded_list = words(ctx.cx.store, ctx.vp, MiscKey::LoadedBuiltins)?;
	let mut disabled = words(ctx.cx.store, ctx.vp, MiscKey::DisabledBuiltins)?;
	let mut any = false;
	for name in names {
		if name.contains(&b'/') {
			ctx.usage(format!("{}: builtin names may not contain slashes", name.as_bstr()));
			continue;
		}
		if name.as_slice() != STRMATCH.name.as_bytes() {
			let utf8 = locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
			ctx.err(Diag::Unsupported {
				what: format!(
					"cannot open shared object {}: dynamic loading of `{}'",
					quote::printable_filename(file, utf8, false).as_bstr(),
					name.as_bstr()
				)
				.into(),
			});
			continue;
		}
		if !loaded_list.contains(name) {
			loaded_list.push(name.clone());
		}
		disabled.retain(|d| d != name);
		if disable {
			disabled.push(name.clone());
		}
		any = true;
	}
	store_words(ctx, MiscKey::LoadedBuiltins, loaded_list);
	store_words(ctx, MiscKey::DisabledBuiltins, disabled);
	done(i32::from(!any))
}

/// `bind …`: readline key bindings and settings. A shell without line
/// editing has none, so as non-interactive bash does it warns and succeeds,
/// whatever the arguments.
pub fn bind(ctx: &mut Ctx<'_, '_>, _args: &[BString]) -> R {
	ctx.err(Diag::Warning { msg: "warning: line editing not enabled".into() });
	done(0)
}

/// `strmatch STRING PATTERN`: 0 when PATTERN (bash `strmatch` with
/// `FNM_PATHNAME | FNM_PERIOD | FNM_EXTMATCH`) matches STRING, 1 when not,
/// 2 without both operands.
pub fn strmatch(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let [string, pattern, ..] = args else {
		return done(2);
	};
	let utf8 = locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
	let matched = ctx
		.k
		.engine
		.patterns()
		.get(pattern, PatOpts::strmatch(utf8))
		.matches(string);
	done(i32::from(!matched))
}

/// bash `no_options`: `--` is skipped, any other option word is an error
/// (with `usage`); `Err(status)`.
fn no_options<'a>(
	ctx: &mut Ctx<'_, '_>,
	args: &'a [BString],
	usage: &[u8],
) -> Result<&'a [BString], i32> {
	match args.first() {
		Some(a) if a.as_slice() == b"--" => Ok(&args[1..]),
		Some(a) if a.len() > 1 && a[0] == b'-' => {
			ctx.usage(format!("-{}: invalid option", char::from(a[1])));
			ctx.out_fd(2, usage);
			Err(2)
		},
		_ => Ok(args),
	}
}

/// bash `print_timeval`: `MmS.FFFs`, the fraction in milliseconds.
fn timeval(ns: u64) -> String {
	let secs = ns / 1_000_000_000;
	let ms = ns % 1_000_000_000 / 1_000_000;
	format!("{}m{}.{ms:03}s", secs / 60, secs % 60)
}

/// `times`: user and system CPU time of the shell, then of its children.
/// A host that cannot measure them (Windows, sandboxed hosts) makes it
/// fail.
pub fn times(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	if let Err(st) = no_options(ctx, args, b"times: usage: times\n") {
		return done(st);
	}
	let Ok(t) = ctx.cx.host.cpu_times() else {
		ctx.diag(Diag::Unsupported { what: "`times' on this host (no CPU time)".into() });
		return done(1);
	};
	let text = format!(
		"{} {}\n{} {}\n",
		timeval(t.user_ns),
		timeval(t.sys_ns),
		timeval(t.child_user_ns),
		timeval(t.child_sys_ns)
	);
	ctx.out(text.as_bytes());
	done(0)
}

/// One `ulimit` resource (bash's `limits[]`).
struct Limit {
	opt:    u8,
	/// `None`: the pipe size, a constant.
	res:    Option<Rlimit>,
	/// Bytes per displayed unit.
	factor: u64,
	desc:   &'static str,
	units:  Option<&'static str>,
}

const fn lim(
	opt: u8,
	res: Option<Rlimit>,
	factor: u64,
	desc: &'static str,
	units: Option<&'static str>,
) -> Limit {
	Limit { opt, res, factor, desc, units }
}

/// bash's `limits[]`, in its order.
const LIMITS: &[Limit] = &[
	lim(b'P', Some(Rlimit::Npts), 1, "number of pseudoterminals", None),
	lim(b'R', Some(Rlimit::Rttime), 1, "real-time non-blocking time", Some("microseconds")),
	lim(b'T', Some(Rlimit::Threads), 1, "number of threads", None),
	lim(b'b', Some(Rlimit::Sbsize), 1, "socket buffer size", Some("bytes")),
	lim(b'c', Some(Rlimit::Core), 512, "core file size", Some("blocks")),
	lim(b'd', Some(Rlimit::Data), 1024, "data seg size", Some("kbytes")),
	lim(b'e', Some(Rlimit::Nice), 1, "scheduling priority", None),
	lim(b'f', Some(Rlimit::Fsize), 512, "file size", Some("blocks")),
	lim(b'i', Some(Rlimit::Sigpending), 1, "pending signals", None),
	lim(b'k', Some(Rlimit::Kqueues), 1, "max kqueues", None),
	lim(b'l', Some(Rlimit::Memlock), 1024, "max locked memory", Some("kbytes")),
	lim(b'm', Some(Rlimit::Rss), 1024, "max memory size", Some("kbytes")),
	lim(b'n', Some(Rlimit::Nofile), 1, "open files", None),
	lim(b'p', None, 512, "pipe size", Some("512 bytes")),
	lim(b'q', Some(Rlimit::Msgqueue), 1, "POSIX message queues", Some("bytes")),
	lim(b'r', Some(Rlimit::Rtprio), 1, "real-time priority", None),
	lim(b's', Some(Rlimit::Stack), 1024, "stack size", Some("kbytes")),
	lim(b't', Some(Rlimit::Cpu), 1, "cpu time", Some("seconds")),
	lim(b'u', Some(Rlimit::Nproc), 1, "max user processes", None),
	lim(b'v', Some(Rlimit::Vmem), 1024, "virtual memory", Some("kbytes")),
	lim(b'w', Some(Rlimit::Swap), 1024, "swap size", Some("kbytes")),
	lim(b'x', Some(Rlimit::Locks), 1, "file locks", None),
];

/// The pipe buffer size bash reports (`PIPESIZE`, built in at configure
/// time): one page on Linux, 512 bytes on macOS.
const PIPE_SIZE: u64 = if cfg!(target_os = "macos") { 512 } else { 4096 };

/// A limit value: `None` is unlimited.
type Value = Option<u64>;

/// `a <= b` with `None` as infinity.
const fn le(a: Value, b: Value) -> bool {
	match (a, b) {
		(_, None) => true,
		(None, Some(_)) => false,
		(Some(x), Some(y)) => x <= y,
	}
}

/// The current (soft, hard) values of `l` in this vproc: its `ulimit`
/// changes, else the host's.
fn current(ctx: &Ctx<'_, '_>, l: &Limit) -> std::io::Result<(Value, Value)> {
	let Some(res) = l.res else {
		return Ok((Some(PIPE_SIZE), Some(PIPE_SIZE)));
	};
	if let Some(&(_, soft, hard)) = ctx.vp.rlimits.iter().find(|(r, ..)| *r == res) {
		return Ok((soft, hard));
	}
	ctx.cx.host.rlimit(res)
}

/// Whether this platform has `l` (bash builds its option string from the
/// limits its platform defines).
fn supported(ctx: &Ctx<'_, '_>, l: &Limit) -> bool {
	!matches!(current(ctx, l), Err(e) if e.kind() == std::io::ErrorKind::Unsupported)
}

/// bash `printone`.
fn print_one(out: &mut Vec<u8>, l: &Limit, value: Value, describe: bool) {
	if describe {
		let unit = match l.units {
			Some(u) => format!("({u}, -{}) ", char::from(l.opt)),
			None => format!("(-{}) ", char::from(l.opt)),
		};
		out.extend_from_slice(format!("{:<20} {unit:>20}", l.desc).as_bytes());
	}
	match value {
		None => out.extend_from_slice(b"unlimited\n"),
		Some(v) => out.extend_from_slice(format!("{}\n", v / l.factor).as_bytes()),
	}
}

/// `ulimit [-SHa…] [limit]`: limits apply to this shell's vproc (and the
/// subshells and externals it starts), never to the engine's process.
pub fn ulimit(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let (mut all, mut soft, mut hard) = (false, false, false);
	let mut cmds: Vec<(&'static Limit, Option<&[u8]>)> = Vec::new();
	let mut i = 0;
	while let Some(word) = args.get(i) {
		if word.as_slice() == b"--" {
			i += 1;
			break;
		}
		if word.len() < 2 || word[0] != b'-' {
			break;
		}
		i += 1;
		for (j, &c) in word.iter().enumerate().skip(1) {
			match c {
				b'a' => all = true,
				b'S' => soft = true,
				b'H' => hard = true,
				_ => {
					let Some(l) = LIMITS
						.iter()
						.find(|l| l.opt == c)
						.filter(|l| supported(ctx, l))
					else {
						ctx.usage(format!("-{}: invalid option", char::from(c)));
						ctx.builtin_usage();
						return done(2);
					};
					// The argument is optional: attached, or the next word
					// unless that looks like an option.
					let arg = if j + 1 < word.len() {
						Some(&word[j + 1..])
					} else if let Some(next) = args
						.get(i)
						.filter(|n| n.first() != Some(&b'-') || n.len() == 1)
					{
						i += 1;
						Some(next.as_slice())
					} else {
						None
					};
					cmds.push((l, arg));
					break;
				},
			}
		}
	}
	let mut rest = &args[i..];
	let mut out = Vec::new();
	if all {
		let mode_soft = soft || !hard;
		for l in LIMITS {
			if let Ok((s, h)) = current(ctx, l) {
				print_one(&mut out, l, if mode_soft { s } else { h }, true);
			}
		}
		ctx.out(&out);
		return done(0);
	}
	if cmds.is_empty() {
		let f = LIMITS
			.iter()
			.find(|l| l.opt == b'f')
			.expect("file size is in the table");
		cmds.push((f, rest.first().map(|r| r.as_slice())));
		rest = rest.get(1..).unwrap_or_default();
	}
	if let (Some(word), Some(last)) = (rest.first(), cmds.last_mut())
		&& last.1.is_none()
	{
		last.1 = Some(word.as_slice());
	}
	let multiple = cmds.len() > 1;
	let mut status = 0;
	for (l, arg) in cmds {
		if !limit_one(ctx, &mut out, l, arg, (soft, hard), multiple) {
			status = 1;
			break;
		}
	}
	ctx.out(&out);
	done(status)
}

/// bash `ulimit_internal`: print or set one limit; `false` after an error.
fn limit_one(
	ctx: &mut Ctx<'_, '_>,
	out: &mut Vec<u8>,
	l: &Limit,
	arg: Option<&[u8]>,
	(soft, hard): (bool, bool),
	multiple: bool,
) -> bool {
	let (want_soft, want_hard) = match (soft, hard, arg.is_some()) {
		(false, false, true) => (true, true),
		(false, false, false) => (true, false),
		other => (other.0, other.1),
	};
	let (cur_soft, cur_hard) = match current(ctx, l) {
		Ok(v) => v,
		Err(e) => {
			ctx.usage(format!("{}: cannot get limit: {}", l.desc, crate::bash::diag::strerror(&e)));
			return false;
		},
	};
	let Some(arg) = arg else {
		print_one(out, l, if want_soft { cur_soft } else { cur_hard }, multiple);
		return true;
	};
	let new = match arg {
		b"hard" => cur_hard,
		b"soft" => cur_soft,
		b"unlimited" => None,
		[d, ..] if d.is_ascii_digit() && (arg.len() == 1 || arg[1].is_ascii_digit()) => {
			if !arg.iter().all(u8::is_ascii_digit) {
				ctx.usage(invalid_number(arg));
				return false;
			}
			let value = std::str::from_utf8(arg)
				.ok()
				.and_then(|s| s.parse::<u64>().ok())
				.and_then(|v| v.checked_mul(l.factor));
			let Some(value) = value else {
				ctx.usage(format!("{}: limit out of range", arg.as_bstr()));
				return false;
			};
			Some(value)
		},
		_ => {
			ctx.usage(invalid_number(arg));
			return false;
		},
	};
	let Some(res) = l.res else {
		ctx.usage(format!("{}: cannot modify limit: Invalid argument", l.desc));
		return false;
	};
	let root = ctx.cx.host.user().euid == 0;
	// bash: an unprivileged `ulimit -S x unlimited` means "up to the hard
	// limit".
	let value = if !root && new.is_none() && !want_hard && le(cur_soft, cur_hard) {
		cur_hard
	} else {
		new
	};
	let new_soft = if want_soft { value } else { cur_soft };
	let new_hard = if want_hard { value } else { cur_hard };
	let err = if !le(new_soft, new_hard) {
		Some("Invalid argument")
	} else if !root && !le(new_hard, cur_hard) {
		Some("Operation not permitted")
	} else {
		None
	};
	if let Some(err) = err {
		ctx.usage(format!("{}: cannot modify limit: {err}", l.desc));
		return false;
	}
	let limits = &mut ctx.vp.rlimits;
	limits.retain(|(r, ..)| *r != res);
	limits.push((res, new_soft, new_hard));
	true
}

#[cfg(test)]
mod tests {
	use super::*;

	// Golden: bash 5.3.20 `times` formatting (`0m0.004s`).
	#[test]
	fn cpu_times_print_minutes_seconds_and_milliseconds() {
		assert_eq!(timeval(4_000_000), "0m0.004s");
		assert_eq!(timeval(61_234_999_999), "1m1.234s");
	}

	// Golden: bash 5.3.20 `ulimit -a` on macOS.
	#[test]
	fn limits_print_like_printone() {
		let core = LIMITS.iter().find(|l| l.opt == b'c').unwrap();
		let mut out = Vec::new();
		print_one(&mut out, core, Some(0), true);
		assert_eq!(out, b"core file size              (blocks, -c) 0\n");
		let files = LIMITS.iter().find(|l| l.opt == b'n').unwrap();
		let mut out = Vec::new();
		print_one(&mut out, files, Some(1_048_576), true);
		assert_eq!(out, b"open files                          (-n) 1048576\n");
		let mut out = Vec::new();
		print_one(&mut out, core, None, false);
		assert_eq!(out, b"unlimited\n");
	}

	#[test]
	fn unlimited_is_the_largest_value() {
		assert!(le(Some(5), None));
		assert!(!le(None, Some(5)));
		assert!(le(None, None));
		assert!(le(Some(3), Some(3)));
	}
}
