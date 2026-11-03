//! zsh's name-table builtins: `alias`, `unalias`/`unhash`/`unfunction`,
//! `hash`/`rehash`, `whence`/`which`/`where`/`type`, `functions`/
//! `autoload`, `enable`/`disable` and `zmodload`. Ports of zsh 5.9
//! `builtin.c` `bin_alias`, `bin_unhash`, `bin_hash`, `bin_whence`,
//! `bin_functions`, `bin_enable`, `pattern.c` `pat_enables`, `module.c`
//! `bin_zmodload` (built-in features only) and `hashtable.c`
//! `printaliasnode`, `printreswdnode`, `printshfuncnode`,
//! `printbuiltinnode`, `printcmdnamnode`, over the engine's records:
//! regular aliases are [`Table::Alias`], global and suffix ones
//! [`Key::ZshAlias`], functions [`Record::Func`] (autoload stubs carry
//! [`Attrs::ZSH_UNDEFINED`]), the command hash [`Table::CmdHash`].
//!
//! Not provided: named directories (`hash -d`, `unhash -d`), math
//! functions (`functions -M`), `functions -c`/`-w`, and every module
//! other than the built-in `zsh/parameter`, `zsh/main` and `zsh/zutil`
//! names `zmodload` reports (`zmodload` of another one fails with
//! [`Diag::ModuleUnavailable`]).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BStr, BString, ByteSlice};
use strum::IntoEnumIterator;

use super::{
	Ctx, Need, R, done,
	zsh_args::{Func, Ops, isset, pattern_arg},
	zsh_print::charset,
	zsh_quote::{niceformat, quotedzputs},
};
use crate::bash::{
	diag::Diag,
	ids::{Dialect, IntrinsicId, UnitId},
	store::{Attrs, Key, KeyBuf, MiscKey, Record, Table},
	syntax::zsh::tok::{head, tail},
	vm::{
		proc::{Probe, ProbeResult},
		state,
		zsh::text::word_list,
	},
	zshopt::ZshOpt,
};

/// `PRINT_NAMEONLY`.
const NAMEONLY: u32 = 1 << 0;
/// `PRINT_LIST`.
const LIST: u32 = 1 << 2;
/// `PRINT_WHENCE_CSH`.
const WHENCE_CSH: u32 = 1 << 7;
/// `PRINT_WHENCE_VERBOSE`.
const WHENCE_VERBOSE: u32 = 1 << 8;
/// `PRINT_WHENCE_SIMPLE`.
const WHENCE_SIMPLE: u32 = 1 << 9;
/// `PRINT_WHENCE_FUNCDEF`.
const WHENCE_FUNCDEF: u32 = 1 << 10;
/// `PRINT_WHENCE_WORD`.
const WHENCE_WORD: u32 = 1 << 11;

/// zsh's reserved words (`hashtable.c` `reswds`), space separated (see
/// [`word_list`]).
const RESWDS: &[u8] = b"! [[ { } case coproc declare do done elif else end esac export fi \
	float for foreach function if integer local nocorrect readonly repeat select then time typeset \
	until while";

/// zsh's precommand modifiers in its builtin table (`BIN_PREFIX`), space
/// separated.
const PREFIXES: &[u8] = b"- builtin command exec noglob";

/// The modules whose features this engine provides (`zmodload` accepts
/// them; `zmodload` alone lists them), space separated.
const MODULES: &[u8] = b"zsh/main zsh/parameter";

/// One alias: name, text, and kind (`'g'` global, `'s'` suffix, 0
/// regular).
struct Alias {
	name: BString,
	text: BString,
	kind: u8,
}

/// Every alias of `table` kind (regular and global ones share zsh's
/// `aliastab`; suffix aliases are `sufaliastab`), sorted by name.
fn aliases(ctx: &mut Ctx<'_, '_>, suffix: bool) -> Result<Vec<Alias>, Need> {
	let mut out: Vec<Alias> = Vec::new();
	if !suffix {
		for (k, r) in state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::Alias)? {
			if let (KeyBuf::Alias(name), Record::Alias(text)) = (k, r) {
				out.push(Alias { name, text, kind: 0 });
			}
		}
	}
	for (k, r) in state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::ZshAlias)? {
		if let (KeyBuf::ZshAlias { suffix: s, name }, Record::Alias(text)) = (k, r)
			&& s == suffix
		{
			out.push(Alias { name, text, kind: if s { b's' } else { b'g' } });
		}
	}
	out.sort_by(|a, b| a.name.cmp(&b.name));
	Ok(out)
}

/// The alias `name` in zsh's `aliastab` (or `sufaliastab`).
fn get_alias(ctx: &mut Ctx<'_, '_>, name: &[u8], suffix: bool) -> Result<Option<Alias>, Need> {
	if !suffix && let Some(Record::Alias(text)) = ctx.record(Key::Alias(BStr::new(name)))? {
		return Ok(Some(Alias { name: name.into(), text, kind: 0 }));
	}
	Ok(match ctx.record(Key::ZshAlias { suffix, name: BStr::new(name) })? {
		Some(Record::Alias(text)) => {
			Some(Alias { name: name.into(), text, kind: if suffix { b's' } else { b'g' } })
		},
		_ => None,
	})
}

/// Words of a [`MiscKey`] list record.
fn words(ctx: &mut Ctx<'_, '_>, key: MiscKey) -> Result<Vec<BString>, Need> {
	Ok(match ctx.record(Key::Misc(key))? {
		Some(Record::Words(w)) => w,
		_ => Vec::new(),
	})
}

/// Replace a [`MiscKey`] list record (removed when empty).
fn set_words(ctx: &mut Ctx<'_, '_>, key: MiscKey, w: Vec<BString>) {
	let rec = (!w.is_empty()).then_some(Record::Words(w));
	ctx.store_record(KeyBuf::Misc(key), rec);
}

/// zsh `printaliasnode`.
fn print_alias(
	ctx: &mut Ctx<'_, '_>,
	a: &Alias,
	flags: u32,
	out: &mut Vec<u8>,
) -> Result<(), Need> {
	let cs = charset(ctx)?;
	let rc = isset(ctx, ZshOpt::Rcquotes)?;
	let nice = |s: &[u8]| niceformat(s, false, cs);
	if flags & NAMEONLY != 0 {
		out.extend_from_slice(&a.name);
		out.push(b'\n');
	} else if flags & WHENCE_WORD != 0 {
		let what: &[u8] = match a.kind {
			b's' => b": suffix alias\n",
			b'g' => b": global alias\n",
			_ => b": alias\n",
		};
		out.extend_from_slice(&a.name);
		out.extend_from_slice(what);
	} else if flags & WHENCE_SIMPLE != 0 {
		out.extend_from_slice(&a.text);
		out.push(b'\n');
	} else if flags & WHENCE_CSH != 0 {
		out.extend_from_slice(&nice(&a.name));
		out.extend_from_slice(match a.kind {
			b's' => b": suffix aliased to ".as_slice(),
			b'g' => b": globally aliased to ",
			_ => b": aliased to ",
		});
		out.extend_from_slice(&nice(&a.text));
		out.push(b'\n');
	} else if flags & WHENCE_VERBOSE != 0 {
		out.extend_from_slice(&nice(&a.name));
		out.extend_from_slice(match a.kind {
			b's' => b" is a suffix alias for ".as_slice(),
			b'g' => b" is a global alias for ",
			_ => b" is an alias for ",
		});
		out.extend_from_slice(&nice(&a.text));
		out.push(b'\n');
	} else {
		if flags & LIST != 0 {
			if a.name.contains(&b'=') {
				ctx.diag(Diag::Usage {
					msg: format!(
						"invalid alias '{}' encountered while printing aliases",
						a.name.as_bstr()
					)
					.into(),
				});
				return Ok(());
			}
			out.extend_from_slice(b"alias ");
			match a.kind {
				b's' => out.extend_from_slice(b"-s "),
				b'g' => out.extend_from_slice(b"-g "),
				_ => {},
			}
			if matches!(a.name.first(), Some(b'-' | b'+')) {
				out.extend_from_slice(b"-- ");
			}
		}
		out.extend_from_slice(&quotedzputs(&a.name, rc, cs));
		out.push(b'=');
		out.extend_from_slice(&quotedzputs(&a.text, rc, cs));
		out.push(b'\n');
	}
	Ok(())
}

/// zsh `bin_alias`.
pub fn alias(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let type_opts =
		u8::from(ops.isset(b'r')) + u8::from(ops.isset(b'g')) + u8::from(ops.isset(b's'));
	if type_opts > 1 {
		ctx.usage("illegal combination of options");
		return done(1);
	}
	let suffix = ops.isset(b's');
	let want = |a: &Alias| -> bool {
		if type_opts == 0 {
			return true;
		}
		if ops.isset(b'g') {
			a.kind == b'g'
		} else if ops.isset(b's') {
			a.kind == b's'
		} else {
			a.kind == 0
		}
	};
	let mut printflags = 0;
	if ops.isset(b'L') {
		printflags |= LIST;
	} else if ops.plus(b'g') || ops.plus(b'r') || ops.plus(b's') || ops.plus(b'm') || ops.isset(b'+')
	{
		printflags |= NAMEONLY;
	}
	let mut out = Vec::new();
	if args.is_empty() {
		for a in aliases(ctx, suffix)? {
			if want(&a) {
				print_alias(ctx, &a, printflags, &mut out)?;
			}
		}
		ctx.out(&out);
		return done(0);
	}
	let mut returnval = 0;
	if ops.isset(b'm') {
		for p in args {
			let Some(pat) = pattern_arg(ctx, p)? else {
				returnval = 1;
				continue;
			};
			for a in aliases(ctx, suffix)? {
				if want(&a) && pat.matches(&a.name) {
					print_alias(ctx, &a, printflags, &mut out)?;
				}
			}
		}
		ctx.out(&out);
		return done(returnval);
	}
	for arg in args {
		if arg.first() == Some(&b'=') {
			ctx.diag(Diag::Usage { msg: "bad assignment".into() });
			return done(1);
		}
		match arg.find_byte(b'=') {
			Some(eq) if !ops.isset(b'L') => {
				let (name, text) = (head(arg, eq), BString::from(tail(arg, eq + 1)));
				// Regular and global aliases share one table in zsh.
				if suffix {
					ctx.store_record(
						KeyBuf::ZshAlias { suffix: true, name: name.into() },
						Some(Record::Alias(text)),
					);
				} else if ops.isset(b'g') {
					ctx.store_record(KeyBuf::Alias(name.into()), None);
					ctx.store_record(
						KeyBuf::ZshAlias { suffix: false, name: name.into() },
						Some(Record::Alias(text)),
					);
				} else {
					ctx.store_record(KeyBuf::ZshAlias { suffix: false, name: name.into() }, None);
					ctx.store_record(KeyBuf::Alias(name.into()), Some(Record::Alias(text)));
				}
			},
			eq => {
				let name = head(arg, eq.unwrap_or(arg.len()));
				match get_alias(ctx, name, suffix)? {
					Some(a) => {
						if type_opts == 0 || suffix || want(&a) {
							print_alias(ctx, &a, printflags, &mut out)?;
						}
					},
					None => returnval = 1,
				}
			},
		}
	}
	ctx.out(&out);
	done(returnval)
}

/// The tables `unhash` works on.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ht {
	Alias,
	Suffix,
	Func,
	Cmd,
}

/// Names in table `ht`.
fn table_names(ctx: &mut Ctx<'_, '_>, ht: Ht) -> Result<Vec<BString>, Need> {
	Ok(match ht {
		Ht::Alias | Ht::Suffix => aliases(ctx, ht == Ht::Suffix)?
			.into_iter()
			.map(|a| a.name)
			.collect(),
		Ht::Func => state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::Func)?
			.into_iter()
			.filter_map(|(k, _)| match k {
				KeyBuf::Func(n) => Some(n),
				_ => None,
			})
			.collect(),
		Ht::Cmd => state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::CmdHash)?
			.into_iter()
			.filter_map(|(k, _)| match k {
				KeyBuf::CmdHash(n) => Some(n),
				_ => None,
			})
			.collect(),
	})
}

/// Remove `name` from `ht`; whether it was there.
fn remove(ctx: &mut Ctx<'_, '_>, ht: Ht, name: &[u8]) -> Result<bool, Need> {
	Ok(match ht {
		Ht::Alias | Ht::Suffix => {
			let suffix = ht == Ht::Suffix;
			let found = get_alias(ctx, name, suffix)?.is_some();
			if found {
				if !suffix {
					ctx.store_record(KeyBuf::Alias(name.into()), None);
				}
				ctx.store_record(KeyBuf::ZshAlias { suffix, name: name.into() }, None);
			}
			found
		},
		Ht::Func => {
			let found = ctx.function(name)?.is_some();
			if found {
				// A `TRAPxxx` function is its trap.
				super::trap::func_changing(ctx.k, ctx.cx.store, ctx.vp, name, false)?;
				ctx.store_record(KeyBuf::Func(name.into()), None);
			}
			found
		},
		Ht::Cmd => {
			let found = ctx.record(Key::CmdHash(BStr::new(name)))?.is_some();
			if found {
				ctx.store_record(KeyBuf::CmdHash(name.into()), None);
			}
			found
		},
	})
}

/// zsh `bin_unhash` for `unhash`, `unalias`, `unfunction` (and `unset
/// -f`).
pub fn unhash(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString], func: Func) -> R {
	let mut all = false;
	let ht = if func == Func::Unalias {
		if ops.isset(b'a') {
			if !args.is_empty() {
				ctx.usage("-a: too many arguments");
				return done(1);
			}
			all = true;
		} else if args.is_empty() {
			ctx.usage("not enough arguments");
			return done(1);
		}
		if ops.isset(b's') {
			Ht::Suffix
		} else {
			Ht::Alias
		}
	} else if ops.isset(b'd') {
		ctx.diag(Diag::Unsupported { what: "unhash -d (zsh named directories)".into() });
		return done(1);
	} else if ops.isset(b'f') {
		Ht::Func
	} else if ops.isset(b's') {
		Ht::Suffix
	} else if func == Func::Unhash && ops.isset(b'a') {
		Ht::Alias
	} else {
		Ht::Cmd
	};
	if all {
		for n in table_names(ctx, ht)? {
			remove(ctx, ht, &n)?;
		}
		return done(0);
	}
	if ops.isset(b'm') {
		let (mut matched, mut returnval) = (0, 0);
		for p in args {
			let Some(pat) = pattern_arg(ctx, p)? else {
				returnval = 1;
				continue;
			};
			for n in table_names(ctx, ht)? {
				if pat.matches(&n) {
					remove(ctx, ht, &n)?;
					matched += 1;
				}
			}
		}
		return done(if matched == 0 { 1 } else { returnval });
	}
	let posix = isset(ctx, ZshOpt::Posixbuiltins)?;
	let mut returnval = 0;
	for n in args {
		if !remove(ctx, ht, n)? && (func != Func::Unset || !posix) {
			ctx.usage(format!("no such hash table element: {}", n.as_bstr()));
			returnval = 1;
		}
	}
	done(returnval)
}

/// zsh `printcmdnamnode` for a hashed command `name` at `path`.
fn print_cmd(
	ctx: &mut Ctx<'_, '_>,
	name: &[u8],
	path: &[u8],
	hashed: bool,
	flags: u32,
	out: &mut Vec<u8>,
) -> Result<(), Need> {
	let cs = charset(ctx)?;
	let rc = isset(ctx, ZshOpt::Rcquotes)?;
	if flags & WHENCE_WORD != 0 {
		out.extend_from_slice(name);
		out.extend_from_slice(if hashed {
			b": hashed\n"
		} else {
			b": command\n"
		});
	} else if flags & (WHENCE_CSH | WHENCE_SIMPLE) != 0 {
		out.extend_from_slice(path);
		out.push(b'\n');
	} else if flags & WHENCE_VERBOSE != 0 {
		out.extend_from_slice(&niceformat(name, false, cs));
		out.extend_from_slice(if hashed { b" is hashed to " } else { b" is " });
		out.extend_from_slice(&niceformat(path, false, cs));
		out.push(b'\n');
	} else {
		if flags & LIST != 0 {
			out.extend_from_slice(b"hash ");
			if name.first() == Some(&b'-') {
				out.extend_from_slice(b"-- ");
			}
		}
		out.extend_from_slice(&quotedzputs(name, rc, cs));
		out.push(b'=');
		out.extend_from_slice(&quotedzputs(path, rc, cs));
		out.push(b'\n');
	}
	Ok(())
}

/// The hashed commands, sorted.
fn hashed(ctx: &mut Ctx<'_, '_>) -> Result<Vec<(BString, BString)>, Need> {
	Ok(state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::CmdHash)?
		.into_iter()
		.filter_map(|(k, r)| match (k, r) {
			(KeyBuf::CmdHash(n), Record::CmdHash { path, .. }) => Some((n, path)),
			_ => None,
		})
		.collect())
}

/// zsh's `DEFAULT_PATH` (`command -p`).
const DEFAULT_PATH: &[u8] = b"/bin:/usr/bin:/usr/ucb:/usr/local/bin";

/// `$PATH` search for `name` (zsh `findcmd`); `defpath`: search zsh's
/// default path instead (`command -p`).
fn findcmd(ctx: &mut Ctx<'_, '_>, name: &[u8], defpath: bool) -> Result<Option<BString>, Need> {
	if name.contains(&b'/') {
		let path = crate::bash::vm::probe::absolute(&ctx.vp.cwd, name);
		return Ok((ctx.probe(Probe::Access { path, mode: 4 })? == ProbeResult::Ok(true))
			.then(|| name.into()));
	}
	let path = if defpath {
		BString::from(DEFAULT_PATH)
	} else {
		ctx.scalar(b"PATH")?.unwrap_or_default()
	};
	Ok(match ctx.probe(Probe::Path { name: name.into(), path })? {
		ProbeResult::Path(p) => p,
		_ => None,
	})
}

/// zsh `bin_hash` (`rehash` is `hash -r`).
pub fn hash(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	if ops.isset(b'd') {
		ctx.diag(Diag::Unsupported { what: "hash -d (zsh named directories)".into() });
		return done(1);
	}
	if ops.isset(b'r') || ops.isset(b'f') {
		if !args.is_empty() {
			ctx.diag(Diag::Usage { msg: "too many arguments".into() }.by("hash"));
			return done(1);
		}
		if ops.isset(b'r') {
			for (n, _) in hashed(ctx)? {
				ctx.store_record(KeyBuf::CmdHash(n), None);
			}
		}
		return done(0);
	}
	let flags = if ops.isset(b'L') { LIST } else { 0 };
	let mut out = Vec::new();
	if args.is_empty() {
		for (n, p) in hashed(ctx)? {
			print_cmd(ctx, &n, &p, true, flags, &mut out)?;
		}
		ctx.out(&out);
		return done(0);
	}
	let mut returnval = 0;
	for arg in args {
		if ops.isset(b'm') {
			let Some(pat) = pattern_arg(ctx, arg)? else {
				returnval = 1;
				continue;
			};
			for (n, p) in hashed(ctx)? {
				if pat.matches(&n) {
					print_cmd(ctx, &n, &p, true, flags, &mut out)?;
				}
			}
			continue;
		}
		if arg.first() == Some(&b'=') {
			ctx.usage("bad assignment");
			returnval = 1;
			break;
		}
		if let Some(eq) = arg.find_byte(b'=') {
			let (name, path) = (head(arg, eq), tail(arg, eq + 1));
			if isset(ctx, ZshOpt::Restricted)? {
				ctx.usage(format!("restricted: {}", path.as_bstr()));
				returnval = 1;
				continue;
			}
			ctx.store_record(
				KeyBuf::CmdHash(name.into()),
				Some(Record::CmdHash { path: path.into(), hits: 0 }),
			);
			if ops.isset(b'v') {
				print_cmd(ctx, name, path, true, 0, &mut out)?;
			}
		} else if let Some(Record::CmdHash { path, .. }) = ctx.record(Key::CmdHash(BStr::new(arg)))? {
			if ops.isset(b'v') {
				print_cmd(ctx, arg, &path, true, 0, &mut out)?;
			}
		} else if let Some(p) = findcmd(ctx, arg, false)? {
			ctx.store_record(
				KeyBuf::CmdHash(arg.clone()),
				Some(Record::CmdHash { path: p.clone(), hits: 0 }),
			);
			if ops.isset(b'v') {
				print_cmd(ctx, arg, &p, true, 0, &mut out)?;
			}
		} else {
			ctx.usage(format!("no such command: {}", arg.as_bstr()));
			returnval = 1;
		}
	}
	ctx.out(&out);
	done(returnval)
}

/// A function's text indented `expand` spaces per tab (zsh
/// `text_expand_tabs`: 0 keeps tabs, -1 no indentation).
fn expand_text(src: &[u8], expand: i32) -> Vec<u8> {
	if expand == 0 {
		return src.to_vec();
	}
	let mut out = Vec::with_capacity(src.len());
	for (i, line) in src.split(|&c| c == b'\n').enumerate() {
		if i > 0 {
			out.push(b'\n');
		}
		let tabs = line.iter().take_while(|&&c| c == b'\t').count();
		if expand > 0 {
			out.resize(out.len() + tabs * usize::try_from(expand).unwrap_or(0), b' ');
		}
		out.extend_from_slice(tail(line, tabs));
	}
	out
}

/// zsh `printshfuncnode`.
fn print_func(
	ctx: &mut Ctx<'_, '_>,
	name: &[u8],
	rec: &Record,
	flags: u32,
	expand: i32,
	out: &mut Vec<u8>,
) -> Result<(), Need> {
	let Record::Func { source, attrs, file, .. } = rec else {
		return Ok(());
	};
	let undefined = attrs.contains(Attrs::ZSH_UNDEFINED);
	if flags & NAMEONLY != 0 || (flags & WHENCE_SIMPLE != 0 && flags & WHENCE_FUNCDEF == 0) {
		out.extend_from_slice(name);
		out.push(b'\n');
		return Ok(());
	}
	let cs = charset(ctx)?;
	let rc = isset(ctx, ZshOpt::Rcquotes)?;
	if flags & (WHENCE_VERBOSE | WHENCE_WORD) != 0 && flags & WHENCE_FUNCDEF == 0 {
		out.extend_from_slice(&niceformat(name, false, cs));
		out.extend_from_slice(if flags & WHENCE_WORD != 0 {
			b": function".as_slice()
		} else if undefined {
			b" is an autoload shell function"
		} else {
			b" is a shell function"
		});
		if flags & WHENCE_VERBOSE != 0 && !file.is_empty() {
			out.extend_from_slice(b" from ");
			out.extend_from_slice(&quotedzputs(file, rc, cs));
		}
		out.push(b'\n');
		return Ok(());
	}
	if undefined {
		let tab: &[u8] = match expand {
			0 => b"\t",
			e if e > 0 => &b"        "[..usize::try_from(e).unwrap_or(0).min(8)],
			_ => b"",
		};
		out.extend_from_slice(&quotedzputs(name, rc, cs));
		out.extend_from_slice(b" () {\n");
		out.extend_from_slice(tab);
		out.extend_from_slice(b"# undefined\n");
		out.extend_from_slice(tab);
		if attrs.contains(Attrs::TRACE) {
			out.extend_from_slice(b"# traced\n");
			out.extend_from_slice(tab);
		}
		out.extend_from_slice(b"builtin autoload -X");
		for (bit, c) in [
			(Attrs::ZSH_UNALIASED, b'U'),
			(Attrs::TRACE, b't'),
			(Attrs::ZSH_TRACE_ONCE, b'T'),
			(Attrs::ZSH_KSHSTORED, b'k'),
			(Attrs::ZSH_ZSHSTORED, b'z'),
		] {
			if attrs.contains(bit) {
				out.push(c);
			}
		}
		out.extend_from_slice(b"\n}\n");
		return Ok(());
	}
	// `-x N` re-prints the definition with N spaces per level (zsh
	// `text_expand_tabs`); text that does not parse keeps its tabs
	// expanded line by line.
	let text = if expand == 0 {
		source.to_vec()
	} else {
		crate::bash::syntax::zsh::reindent_function(name, source, expand)
			.unwrap_or_else(|| expand_text(source, expand))
	};
	out.extend_from_slice(&text);
	if !source.ends_with(b"\n") {
		out.push(b'\n');
	}
	Ok(())
}

/// Every function, sorted by name (disabled ones left out).
fn functions_list(ctx: &mut Ctx<'_, '_>) -> Result<Vec<(BString, Record)>, Need> {
	let disabled = words(ctx, MiscKey::ZshDisabledFuncs)?;
	Ok(state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::Func)?
		.into_iter()
		.filter_map(|(k, r)| match k {
			KeyBuf::Func(n) if !disabled.contains(&n) => Some((n, r)),
			_ => None,
		})
		.collect())
}

/// zsh `bin_functions` for `functions`, `autoload` and `typeset -f`.
#[expect(clippy::too_many_lines, reason = "one function, as zsh's bin_functions")]
pub fn functions(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString], _func: Func) -> R {
	let (mut on, mut off) = (Attrs::NONE, Attrs::NONE);
	if ops.plus(b'u') {
		off = off.with(Attrs::ZSH_UNDEFINED);
	} else if ops.minus(b'u') || ops.isset(b'X') {
		on = on.with(Attrs::ZSH_UNDEFINED);
	}
	if ops.minus(b'U') {
		on = on.with(Attrs::ZSH_UNALIASED).with(Attrs::ZSH_UNDEFINED);
	} else if ops.plus(b'U') {
		off = off.with(Attrs::ZSH_UNALIASED);
	}
	for (c, bit) in
		[(b't', Attrs::TRACE), (b'T', Attrs::ZSH_TRACE_ONCE), (b'W', Attrs::ZSH_WARN_NESTED)]
	{
		if ops.minus(c) {
			on = on.with(bit);
		} else if ops.plus(c) {
			off = off.with(bit);
		}
	}
	let roff = off;
	let mut roff_extra = false;
	if ops.minus(b'z') {
		on = on.with(Attrs::ZSH_ZSHSTORED);
		off = off.with(Attrs::ZSH_KSHSTORED);
	} else if ops.plus(b'z') {
		off = off.with(Attrs::ZSH_ZSHSTORED);
		roff_extra = true;
	}
	if ops.minus(b'k') {
		on = on.with(Attrs::ZSH_KSHSTORED);
		off = off.with(Attrs::ZSH_ZSHSTORED);
	} else if ops.plus(b'k') {
		off = off.with(Attrs::ZSH_KSHSTORED);
		roff_extra = true;
	}
	if off.contains(Attrs::ZSH_UNDEFINED)
		|| (ops.isset(b'k') && ops.isset(b'z'))
		|| (ops.isset(b'x') && !ops.hasarg(b'x'))
		|| (ops.isset(b'c') && (ops.isset(b'x') || ops.isset(b'X') || ops.isset(b'm')))
	{
		ctx.usage("invalid option(s)");
		return done(1);
	}
	if ops.isset(b'c') || ops.isset(b'M') || ops.isset(b'w') {
		ctx.diag(Diag::Unsupported { what: "functions -c/-M/-w".into() });
		return done(1);
	}
	let mut expand = 0;
	if let Some(x) = ops.arg(b'x').filter(|_| ops.isset(b'x')) {
		match x.to_str().ok().and_then(|s| s.parse::<i32>().ok()) {
			Some(0) => expand = -1,
			Some(n) => expand = n,
			None => {
				ctx.usage("number expected after -x");
				return done(1);
			},
		}
	}
	let mut pflags = 0;
	if ops.plus(b'f') || roff != Attrs::NONE || roff_extra || ops.isset(b'+') {
		pflags |= NAMEONLY;
	}
	if ops.minus(b'X') {
		// `builtin autoload -X` inside an undefined function's stub.
		return super::flow::zsh_autoload_x(ctx);
	}
	let flagged = on.with(off);
	let mut out = Vec::new();
	if args.is_empty() {
		let want = if ops.isset(b'U') && !ops.isset(b'u') {
			flagged.without(Attrs::ZSH_UNDEFINED)
		} else {
			flagged
		};
		for (n, r) in functions_list(ctx)? {
			let attrs = match &r {
				Record::Func { attrs, .. } => *attrs,
				_ => Attrs::NONE,
			};
			if want == Attrs::NONE || attrs.flags().bits() & want.bits() != 0 {
				print_func(ctx, &n, &r, pflags, expand, &mut out)?;
			}
		}
		ctx.out(&out);
		return done(0);
	}
	let mut returnval = 0;
	let apply = |r: Record| -> Record {
		match r {
			Record::Func { mode, sticky, source, unit, attrs, file } => Record::Func {
				mode,
				sticky,
				source,
				unit,
				attrs: attrs.with(on.without(Attrs::ZSH_UNDEFINED)).without(off),
				file,
			},
			r => r,
		}
	};
	if ops.isset(b'm') {
		for p in args {
			let Some(pat) = pattern_arg(ctx, p)? else {
				returnval = 1;
				continue;
			};
			for (n, r) in functions_list(ctx)? {
				if !pat.matches(&n) {
					continue;
				}
				if flagged.without(Attrs::ZSH_UNDEFINED) == Attrs::NONE && !roff_extra {
					print_func(ctx, &n, &r, pflags, expand, &mut out)?;
				} else {
					ctx.store_record(KeyBuf::Func(n), Some(apply(r)));
				}
			}
		}
		ctx.out(&out);
		return done(returnval);
	}
	for a in args {
		if let Some(r) = ctx.function(a)? {
			if flagged != Attrs::NONE || roff_extra {
				ctx.store_record(KeyBuf::Func(a.clone()), Some(apply(r)));
			} else {
				print_func(ctx, a, &r, pflags, expand, &mut out)?;
			}
		} else if on.contains(Attrs::ZSH_UNDEFINED) {
			// A new autoload stub; `/dir/name` names its directory.
			let (name, file) = match a.rfind_byte(b'/') {
				Some(s) if a.starts_with(b"/") && s + 1 < a.len() => {
					(BString::from(tail(a, s + 1)), BString::from(head(a, s.max(1))))
				},
				_ => (a.clone(), BString::default()),
			};
			let rec = Record::Func {
				mode: ctx.vp.mode,
				sticky: ctx.vp.sticky().cloned().map(Box::new),
				source: BString::default(),
				unit: UnitId([0; 32]),
				attrs: on,
				file,
			};
			super::trap::func_changing(ctx.k, ctx.cx.store, ctx.vp, &name, false)?;
			ctx.store_record(KeyBuf::Func(name), Some(rec));
		} else {
			returnval = 1;
		}
	}
	ctx.out(&out);
	done(returnval)
}

/// How [`whence_one`] reports (zsh `bin_whence`'s locals).
#[derive(Clone, Copy)]
struct WhenceHow {
	/// `printflags`.
	printflags: u32,
	/// `aliasflags`: `command -v` lists an alias as `alias` does.
	aliasflags: u32,
	/// `expand` (`-x`).
	expand:     i32,
	/// `v`: an external command as `NAME is PATH`.
	verbose:    bool,
	/// `BIN_COMMAND` (`command -v`/`-V`): `-p` searches the default path
	/// and shows a builtin first.
	command:    bool,
}

/// Whether `name` is an enabled builtin (or a precommand modifier) of the
/// zsh dialect.
fn is_builtin(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<bool, Need> {
	Ok(word_list(PREFIXES).any(|w| w == name)
		|| (IntrinsicId::lookup(name, ctx.vp.mode).is_some()
			&& !words(ctx, MiscKey::DisabledBuiltins)?
				.iter()
				.any(|w| w == name)))
}

/// zsh's builtin table `printnode` for whence.
fn print_builtin(name: &[u8], printflags: u32, out: &mut Vec<u8>) {
	out.extend_from_slice(name);
	out.extend_from_slice(if printflags & WHENCE_WORD != 0 {
		b": builtin\n".as_slice()
	} else if printflags & WHENCE_CSH != 0 {
		b": shell built-in command\n"
	} else if printflags & WHENCE_VERBOSE != 0 {
		b" is a shell builtin\n"
	} else {
		b"\n"
	});
}

/// What `whence` found for one name.
fn whence_one(
	ctx: &mut Ctx<'_, '_>,
	ops: &Ops,
	name: &[u8],
	how: WhenceHow,
	out: &mut Vec<u8>,
) -> Result<bool, Need> {
	let WhenceHow { printflags, expand, .. } = how;
	let all = ops.isset(b'a');
	let mut informed = false;
	if !ops.isset(b'p') {
		if let Some(a) = get_alias(ctx, name, false)? {
			print_alias(ctx, &a, how.aliasflags, out)?;
			informed = true;
			if !all {
				return Ok(true);
			}
		}
		if let Some(dot) = name.rfind_byte(b'.')
			&& dot > 0
			&& dot + 1 < name.len()
			&& let Some(a) = get_alias(ctx, tail(name, dot + 1), true)?
		{
			print_alias(ctx, &a, printflags, out)?;
			informed = true;
			if !all {
				return Ok(true);
			}
		}
		let reserved = word_list(RESWDS).any(|w| w == name)
			&& !words(ctx, MiscKey::ZshDisabledReswords)?
				.iter()
				.any(|w| w == name);
		if reserved {
			out.extend_from_slice(name);
			out.extend_from_slice(if printflags & WHENCE_WORD != 0 {
				b": reserved\n".as_slice()
			} else if printflags & WHENCE_CSH != 0 {
				b": shell reserved word\n"
			} else if printflags & WHENCE_VERBOSE != 0 {
				b" is a reserved word\n"
			} else {
				b"\n"
			});
			informed = true;
			if !all {
				return Ok(true);
			}
		}
		if !words(ctx, MiscKey::ZshDisabledFuncs)?
			.iter()
			.any(|w| w == name)
			&& let Some(r) = ctx.function(name)?
		{
			print_func(ctx, name, &r, printflags, expand, out)?;
			informed = true;
			if !all {
				return Ok(true);
			}
		}
		if is_builtin(ctx, name)? {
			print_builtin(name, printflags, out);
			informed = true;
			if !all {
				return Ok(true);
			}
		}
		if let Some(Record::CmdHash { path, .. }) = ctx.record(Key::CmdHash(BStr::new(name)))? {
			print_cmd(ctx, name, &path, true, printflags, out)?;
			informed = true;
			if !all {
				return Ok(true);
			}
		}
	}
	let (wd, v, csh) = (ops.isset(b'w'), how.verbose, ops.isset(b'c'));
	let defpath = how.command && ops.isset(b'p');
	let cs = charset(ctx)?;
	let rc = isset(ctx, ZshOpt::Rcquotes)?;
	let mut found: Vec<BString> = Vec::new();
	if all && name.first() != Some(&b'/') {
		let path = ctx.scalar(b"PATH")?.unwrap_or_default();
		for dir in path.split(|&c| c == b':') {
			let full: BString = if dir.is_empty() {
				name.into()
			} else {
				[dir, b"/", name].concat().into()
			};
			let abs = crate::bash::vm::probe::absolute(&ctx.vp.cwd, &full);
			if ctx.probe(Probe::Access { path: abs, mode: 4 })? == ProbeResult::Ok(true) {
				found.push(full);
			}
		}
	} else if defpath && is_builtin(ctx, name)? {
		// `command -p[vV]` shows a builtin before an external command.
		print_builtin(name, printflags, out);
		return Ok(true);
	} else if let Some(p) = findcmd(ctx, name, defpath)? {
		found.push(p);
	}
	for p in &found {
		if wd {
			out.extend_from_slice(name);
			out.extend_from_slice(b": command\n");
		} else {
			if v && !csh {
				out.extend_from_slice(name);
				out.extend_from_slice(b" is ");
				out.extend_from_slice(&quotedzputs(p, rc, cs));
			} else {
				out.extend_from_slice(p);
			}
			out.push(b'\n');
		}
		informed = true;
	}
	if !informed && (wd || v || csh) {
		out.extend_from_slice(name);
		out.extend_from_slice(if wd {
			b": none\n".as_slice()
		} else {
			b" not found\n"
		});
	}
	Ok(informed)
}

/// zsh `bin_whence` for `whence`, `which` (`-c`), `where` (`-ca`), `type`
/// (`-v`) and `command -v`/`-V` (`func` [`Func::Command`]).
pub fn whence(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString], func: Func) -> R {
	let mut expand = 0;
	if let Some(x) = ops.arg(b'x').filter(|_| ops.isset(b'x')) {
		match x.to_str().ok().and_then(|s| s.parse::<i32>().ok()) {
			Some(0) => expand = -1,
			Some(n) => expand = n,
			None => {
				ctx.usage("number expected after -x");
				return done(1);
			},
		}
	}
	let mut printflags = if ops.isset(b'w') {
		WHENCE_WORD
	} else if ops.isset(b'c') {
		WHENCE_CSH
	} else if ops.isset(b'v') {
		WHENCE_VERBOSE
	} else {
		WHENCE_SIMPLE
	};
	if ops.isset(b'f') {
		printflags |= WHENCE_FUNCDEF;
	}
	let command = func == Func::Command;
	let mut aliasflags = printflags;
	let mut verbose = ops.isset(b'v');
	if command {
		verbose = ops.isset(b'V');
		printflags = if verbose {
			WHENCE_VERBOSE
		} else {
			WHENCE_SIMPLE
		};
		aliasflags = if verbose { WHENCE_VERBOSE } else { LIST };
	}
	let how = WhenceHow { printflags, aliasflags, expand, verbose, command };
	let mut out = Vec::new();
	let mut returnval = 0;
	let mut informed = false;
	let names: Vec<BString> = if ops.isset(b'm') {
		let mut names = Vec::new();
		for p in args {
			let Some(pat) = pattern_arg(ctx, p)? else {
				returnval = 1;
				continue;
			};
			let mut cands: Vec<BString> = aliases(ctx, false)?.into_iter().map(|a| a.name).collect();
			cands.extend(word_list(RESWDS).map(BString::from));
			cands.extend(table_names(ctx, Ht::Func)?);
			cands.extend(
				IntrinsicId::iter()
					.filter(|i| i.available_in(Dialect::Zsh))
					.map(|i| BString::from(<&str>::from(i))),
			);
			cands.extend(table_names(ctx, Ht::Cmd)?);
			cands.sort();
			cands.dedup();
			names.extend(cands.into_iter().filter(|n| pat.matches(n)));
		}
		names
	} else {
		args.to_vec()
	};
	for n in &names {
		if whence_one(ctx, ops, n, how, &mut out)? {
			informed = true;
		} else {
			returnval = 1;
		}
	}
	ctx.out(&out);
	done(i32::from(returnval != 0 || !informed))
}

/// zsh `bin_enable` for `enable` and `disable`.
pub fn enable(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString], func: Func) -> R {
	let enabling = func == Func::Enable;
	if ops.isset(b'p') {
		return pat_enables(ctx, args, enabling);
	}
	let (key, universe): (MiscKey, Vec<BString>) = if ops.isset(b'f') {
		(MiscKey::ZshDisabledFuncs, table_names(ctx, Ht::Func)?)
	} else if ops.isset(b'r') {
		(MiscKey::ZshDisabledReswords, word_list(RESWDS).map(BString::from).collect())
	} else if ops.isset(b's') {
		(MiscKey::ZshDisabledSuffixAliases, table_names(ctx, Ht::Suffix)?)
	} else if ops.isset(b'a') {
		(MiscKey::ZshDisabledAliases, table_names(ctx, Ht::Alias)?)
	} else {
		let mut b: Vec<BString> = IntrinsicId::iter()
			.filter(|i| i.available_in(Dialect::Zsh))
			.map(|i| BString::from(<&str>::from(i)))
			.chain(word_list(PREFIXES).map(BString::from))
			.collect();
		b.sort();
		(MiscKey::DisabledBuiltins, b)
	};
	let mut disabled = words(ctx, key)?;
	if args.is_empty() {
		let mut out = Vec::new();
		let mut list = universe;
		list.sort();
		for n in list {
			if disabled.contains(&n) != enabling {
				out.extend_from_slice(&n);
				out.push(b'\n');
			}
		}
		ctx.out(&out);
		return done(0);
	}
	let mut returnval = 0;
	let set = |disabled: &mut Vec<BString>, n: &BString| {
		disabled.retain(|d| d != n);
		if !enabling {
			disabled.push(n.clone());
		}
	};
	if ops.isset(b'm') {
		let mut matched = 0;
		for p in args {
			let Some(pat) = pattern_arg(ctx, p)? else {
				returnval = 1;
				continue;
			};
			for n in universe.iter().filter(|n| pat.matches(n)) {
				set(&mut disabled, n);
				matched += 1;
			}
		}
		set_words(ctx, key, disabled);
		return done(if matched == 0 { 1 } else { returnval });
	}
	for a in args {
		if universe.contains(a) {
			set(&mut disabled, a);
		} else {
			ctx.usage(format!("no such hash table element: {}", a.as_bstr()));
			returnval = 1;
		}
	}
	set_words(ctx, key, disabled);
	done(returnval)
}

/// zsh `pat_enables`: `enable -p`/`disable -p` over the pattern
/// characters (`disable -p` lists the disabled ones).
fn pat_enables(ctx: &mut Ctx<'_, '_>, args: &[BString], enabling: bool) -> R {
	use crate::bash::pattern::zsh::Disables;
	let mut cur = words(ctx, MiscKey::ZshPatDisables)?
		.iter()
		.filter_map(|w| Disables::from_name(w))
		.fold(Disables::NONE, |a, b| a | b);
	if args.is_empty() {
		let names: Vec<&str> = cur.names(!enabling).collect();
		if !names.is_empty() {
			let line: Vec<String> = names.iter().map(|n| format!("'{n}'")).collect();
			ctx.out(format!("{}\n", line.join(" ")).as_bytes());
		}
		return done(0);
	}
	let mut ret = 0;
	for a in args {
		if let Some(d) = Disables::from_name(a) {
			cur = if enabling { cur - d } else { cur | d }
		} else {
			ctx.usage(format!("invalid pattern: {}", a.as_bstr()));
			ret = 1;
		}
	}
	let list: Vec<BString> = cur.names(true).map(BString::from).collect();
	set_words(ctx, MiscKey::ZshPatDisables, list);
	if ret != 0 {
		return Ok(super::Outcome { status: 1, control: super::Control::DiscardAll });
	}
	done(0)
}

/// zsh `bin_zmodload` over the built-in features: listing (`zmodload`,
/// `-L`), `-e` (whether loaded), loading (accepted for the modules this
/// engine provides, [`Diag::ModuleUnavailable`] for any other) and `-u`.
pub fn zmodload(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let known = |m: &[u8]| word_list(MODULES).any(|k| k == m);
	if ops.isset(b'e') {
		return done(i32::from(!args.iter().all(|a| known(a))));
	}
	if args.is_empty() {
		let mut out = Vec::new();
		for m in word_list(MODULES) {
			if ops.isset(b'L') {
				out.extend_from_slice(b"zmodload ");
			}
			out.extend_from_slice(m);
			out.push(b'\n');
		}
		ctx.out(&out);
		return done(0);
	}
	let mut ret = 0;
	for (i, a) in args.iter().enumerate() {
		// `-F module features…`: only the module is checked.
		if ops.isset(b'F') && i > 0 {
			break;
		}
		if known(a) {
			continue;
		}
		if ops.isset(b'u') {
			if !ops.isset(b'i') {
				ctx.usage(format!("no such module {}", a.as_bstr()));
				ret = 1;
			}
			continue;
		}
		ctx.err(Diag::ModuleUnavailable { name: a.clone() });
		ret = 1;
	}
	done(ret)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn function_text_tab_expansion() {
		assert_eq!(expand_text(b"f () {\n\tif x\n\t\tthen\n}", 2), b"f () {\n  if x\n    then\n}");
		assert_eq!(expand_text(b"f () {\n\tx\n}", -1), b"f () {\nx\n}");
		assert_eq!(expand_text(b"f () {\n\tx\n}", 0), b"f () {\n\tx\n}");
	}

	#[test]
	fn reserved_words_are_zsh_s() {
		let is = |w: &[u8]| word_list(RESWDS).any(|r| r == w);
		assert!(is(b"foreach") && is(b"typeset") && is(b"!") && is(b"while"));
		assert!(!is(b"print") && !is(b""));
	}
}
