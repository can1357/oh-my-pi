//! zsh's name-table builtins: `alias`, `unalias`/`unhash`/`unfunction`,
//! `hash`/`rehash`, `whence`/`which`/`where`/`type`, `functions`/
//! `autoload` and `enable`/`disable`. Ports of zsh 5.9
//! `builtin.c` `bin_alias`, `bin_unhash`, `bin_hash`, `bin_whence`,
//! `bin_functions`, `bin_enable`, `pattern.c` `pat_enables` and `hashtable.c`
//! `printaliasnode`, `printreswdnode`, `printshfuncnode`,
//! `printbuiltinnode`, `printcmdnamnode`, over the engine's records:
//! regular aliases are [`Table::Alias`], global and suffix ones
//! [`Key::ZshAlias`], functions [`Record::Func`] (autoload stubs carry
//! [`Attrs::ZSH_UNDEFINED`]), the command hash [`Table::CmdHash`], named
//! directories (`hash -d`, `unhash -d`, `printnameddirnode`)
//! [`MiscKey::ZshNamedDirs`].
//!
//! Not provided: math functions (`functions -M`), `functions -c`/`-w`.
//! `zmodload` is
//! [`super::zsh_module`].
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BStr, BString, ByteSlice};
use strum::IntoEnumIterator;

use super::{
	Ctx, Need, R, done,
	zsh_args::{Func, Ops, isset, pattern_arg, zx},
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
		zsh::{
			nameddir::{self, NamedDirs},
			text::{user_end, word_list},
		},
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
	/// Named directories.
	Dir,
}

/// zsh's named directory table.
fn named_dirs(ctx: &mut Ctx<'_, '_>) -> Result<NamedDirs, Need> {
	Ok(NamedDirs::from_record(ctx.record(Key::Misc(MiscKey::ZshNamedDirs))?.as_ref()))
}

/// Store zsh's named directory table.
fn save_named_dirs(ctx: &mut Ctx<'_, '_>, t: &NamedDirs) {
	ctx.store_record(KeyBuf::Misc(MiscKey::ZshNamedDirs), t.to_record());
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
		Ht::Dir => named_dirs(ctx)?
			.entries()
			.map(|e| BString::from(e.name))
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
		Ht::Dir => {
			let mut t = named_dirs(ctx)?;
			let found = t.remove(name);
			if found {
				save_named_dirs(ctx, &t);
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
		Ht::Dir
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

/// zsh's `DEFAULT_PATH` (`command -p`), joined for `platform`.
fn default_path(platform: crate::bash::ids::Platform) -> BString {
	let separator = crate::bash::vm::probe::path_separator(platform);
	let bytes: Vec<u8> = DEFAULT_PATH
		.iter()
		.map(|&byte| if byte == b':' { separator } else { byte })
		.collect();
	BString::from(bytes)
}

/// zsh's `DEFAULT_PATH` (`command -p`) on a POSIX host.
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
		default_path(ctx.k.engine.config().platform)
	} else {
		ctx.scalar(b"PATH")?.unwrap_or_default()
	};
	Ok(match ctx.probe(Probe::Path { name: name.into(), path })? {
		ProbeResult::Path(p) => p,
		_ => None,
	})
}

/// zsh `printnameddirnode`.
fn print_dir(
	ctx: &mut Ctx<'_, '_>,
	e: &nameddir::Entry<'_>,
	flags: u32,
	out: &mut Vec<u8>,
) -> Result<(), Need> {
	if flags & NAMEONLY != 0 {
		out.extend_from_slice(e.name);
		out.push(b'\n');
		return Ok(());
	}
	let cs = charset(ctx)?;
	let rc = isset(ctx, ZshOpt::Rcquotes)?;
	if flags & LIST != 0 {
		out.extend_from_slice(b"hash -d ");
		if e.name.first() == Some(&b'-') {
			out.extend_from_slice(b"-- ");
		}
	}
	out.extend_from_slice(&quotedzputs(e.name, rc, cs));
	out.push(b'=');
	out.extend_from_slice(&quotedzputs(e.dir, rc, cs));
	out.push(b'\n');
	Ok(())
}

/// zsh `bin_hash` over the named directory table (`hash -d`).
fn hash_dirs(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	if ops.isset(b'r') || ops.isset(b'f') {
		if !args.is_empty() {
			ctx.diag(Diag::Usage { msg: "too many arguments".into() }.by("hash"));
			return done(1);
		}
		if ops.isset(b'r') {
			let mut t = named_dirs(ctx)?;
			t.clear();
			save_named_dirs(ctx, &t);
		}
		if ops.isset(b'f')
			&& let Err(d) = zx(ctx, nameddir::fill)?
		{
			return super::zsh_args::zerr(ctx, d);
		}
		return done(0);
	}
	let flags = if ops.isset(b'L') { LIST } else { 0 };
	let mut out = Vec::new();
	if args.is_empty() {
		let t = named_dirs(ctx)?;
		for e in t.sorted() {
			print_dir(ctx, &e, flags, &mut out)?;
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
			let t = named_dirs(ctx)?;
			for e in t.sorted() {
				if pat.matches(e.name) {
					print_dir(ctx, &e, flags, &mut out)?;
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
			let (name, dir) = (head(arg, eq), tail(arg, eq + 1));
			if isset(ctx, ZshOpt::Restricted)? {
				ctx.usage(format!("restricted: {}", dir.as_bstr()));
				returnval = 1;
				continue;
			}
			if user_end(name, 0) != name.len() {
				ctx.usage(format!("invalid character in directory name: {}", name.as_bstr()));
				returnval = 1;
				continue;
			}
			let mut t = named_dirs(ctx)?;
			t.add(name, dir, 0);
			save_named_dirs(ctx, &t);
			if ops.isset(b'v') {
				let e = nameddir::Entry { name, flags: 0, dir };
				print_dir(ctx, &e, 0, &mut out)?;
			}
			continue;
		}
		if named_dirs(ctx)?.get(arg).is_none() {
			match zx(ctx, |ex| nameddir::getnameddir(ex, arg))? {
				Ok(Some(_)) => {},
				Ok(None) => {
					ctx.usage(format!("no such directory name: {}", arg.as_bstr()));
					returnval = 1;
				},
				Err(d) => return super::zsh_args::zerr(ctx, d),
			}
		}
		if ops.isset(b'v') {
			let t = named_dirs(ctx)?;
			if let Some(e) = t.get(arg) {
				print_dir(ctx, &e, 0, &mut out)?;
			}
		}
	}
	ctx.out(&out);
	done(returnval)
}

/// zsh `bin_hash` (`rehash` is `hash -r`).
pub fn hash(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	if ops.isset(b'd') {
		return hash_dirs(ctx, ops, args);
	}
	if ops.isset(b'r') || ops.isset(b'f') {
		if !args.is_empty() {
			ctx.diag(Diag::Usage { msg: "too many arguments".into() }.by("hash"));
			return done(1);
		}
		if ops.isset(b'r') {
			// zsh `emptycmdnamtable`: `pathchecked` goes back to the start.
			for (n, _) in hashed(ctx)? {
				ctx.store_record(KeyBuf::CmdHash(n), None);
			}
			ctx.store_record(KeyBuf::Misc(MiscKey::ZshPathChecked), None);
		} else if let Err(d) = zx(ctx, crate::bash::vm::zsh::specials::fill_cmdnamtab)? {
			// `-f`: zsh `fillcmdnamtable`.
			ctx.diag(d);
			return done(1);
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
			// An autoload stub's file is its load directory (zsh
			// `PM_LOADDIR`).
			if undefined {
				out.push(b'/');
				out.extend_from_slice(&quotedzputs(name, rc, cs));
			}
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
		if attrs.contains(Attrs::TRACE) || attrs.contains(Attrs::ZSH_TRACE_ONCE) {
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
			(Attrs::ZSH_CUR_FPATH, b'c'),
		] {
			if attrs.contains(bit) {
				out.push(c);
			}
		}
		if !file.is_empty() {
			out.push(b' ');
			out.extend_from_slice(file);
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
	// zsh `printshfuncnode`: the name through `quotedzputs`, then ` () {`,
	// `# traced` for a traced function, the body.
	match text.find(b" () {\n") {
		Some(head) if !text[..head].contains(&b'\n') => {
			out.extend_from_slice(&quotedzputs(name, rc, cs));
			out.extend_from_slice(b" () {\n");
			if attrs.contains(Attrs::TRACE) || attrs.contains(Attrs::ZSH_TRACE_ONCE) {
				let tab: &[u8] = match expand {
					0 => b"\t",
					e if e > 0 => &b"        "[..usize::try_from(e).unwrap_or(0).min(8)],
					_ => b"",
				};
				out.extend_from_slice(tab);
				out.extend_from_slice(b"# traced\n");
			}
			out.extend_from_slice(&text[head + 6..]);
		},
		_ => out.extend_from_slice(&text),
	}
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
	let mut roff = off;
	if ops.minus(b'z') {
		on = on.with(Attrs::ZSH_ZSHSTORED);
		off = off.with(Attrs::ZSH_KSHSTORED);
	} else if ops.plus(b'z') {
		off = off.with(Attrs::ZSH_ZSHSTORED);
		roff = roff.with(Attrs::ZSH_ZSHSTORED);
	}
	if ops.minus(b'k') {
		on = on.with(Attrs::ZSH_KSHSTORED);
		off = off.with(Attrs::ZSH_ZSHSTORED);
	} else if ops.plus(b'k') {
		off = off.with(Attrs::ZSH_KSHSTORED);
		roff = roff.with(Attrs::ZSH_KSHSTORED);
	}
	// zsh sets `PM_CUR_FPATH` in both: a stub gets it, an existing
	// function loses it.
	if ops.minus(b'd') {
		on = on.with(Attrs::ZSH_CUR_FPATH);
		off = off.with(Attrs::ZSH_CUR_FPATH);
	} else if ops.plus(b'd') {
		off = off.with(Attrs::ZSH_CUR_FPATH);
		roff = roff.with(Attrs::ZSH_CUR_FPATH);
	}
	if off.contains(Attrs::ZSH_UNDEFINED)
		|| (ops.isset(b'k') && ops.isset(b'z'))
		|| (ops.isset(b'x') && !ops.hasarg(b'x'))
		|| (ops.minus(b'X') && ops.isset(b'm'))
		|| (ops.isset(b'c') && (ops.isset(b'x') || ops.isset(b'X') || ops.isset(b'm')))
	{
		ctx.usage("invalid option(s)");
		return done(1);
	}
	if ops.isset(b'c') {
		return copy_function(ctx, args);
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
	if ops.plus(b'f') || roff != Attrs::NONE || ops.isset(b'+') {
		pflags |= NAMEONLY;
	}
	if ops.minus(b'M') || ops.plus(b'M') {
		if on != Attrs::NONE
			|| off != Attrs::NONE
			|| pflags != 0
			|| ops.isset(b'X')
			|| ops.isset(b'u')
			|| ops.isset(b'U')
			|| ops.isset(b'w')
		{
			ctx.usage("invalid option(s)");
			return done(1);
		}
		return math_functions(ctx, ops, args);
	}
	if ops.minus(b'X') {
		return autoload_x(ctx, args, on);
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
		let on = on.without(Attrs::ZSH_UNDEFINED);
		for p in args {
			let Some(pat) = pattern_arg(ctx, p)? else {
				returnval = 1;
				continue;
			};
			for (n, r) in functions_list(ctx)? {
				if !pat.matches(&n) {
					continue;
				}
				if on == Attrs::NONE && off == Attrs::NONE && !ops.isset(b'X') {
					print_func(ctx, &n, &r, pflags, expand, &mut out)?;
				} else {
					ctx.store_record(KeyBuf::Func(n.clone()), Some(apply(r)));
					if check_autoload(ctx, ops, &n)? != 0 {
						returnval = 1;
					}
				}
			}
		}
		ctx.out(&out);
		return done(returnval);
	}
	for a in args {
		if ops.isset(b'w') {
			ctx.diag(Diag::Unsupported { what: "autoload -w (word code files)".into() });
			returnval = 1;
		} else if let Some(r) = ctx.function(a)? {
			if flagged == Attrs::NONE {
				print_func(ctx, a, &r, pflags, expand, &mut out)?;
			} else {
				ctx.store_record(KeyBuf::Func(a.clone()), Some(apply(r)));
				if check_autoload(ctx, ops, a)? != 0 {
					returnval = 1;
				}
			}
		} else if on.contains(Attrs::ZSH_UNDEFINED) {
			// `/dir/name` for a function that exists: its flags change,
			// and a stub not loaded yet gets that directory.
			if let Some(s) = a.rfind_byte(b'/').filter(|_| a.starts_with(b"/"))
				&& s + 1 < a.len()
				&& let Some(Record::Func { mode, sticky, source, unit, attrs, file }) =
					ctx.function(tail(a, s + 1))?
			{
				let name = BString::from(tail(a, s + 1));
				let attrs = attrs.with(on.without(Attrs::ZSH_UNDEFINED)).without(off);
				let file = if attrs.contains(Attrs::ZSH_UNDEFINED) {
					BString::from(head(a, s.max(1)))
				} else {
					file
				};
				let rec = Record::Func { mode, sticky, source, unit, attrs, file };
				ctx.store_record(KeyBuf::Func(name.clone()), Some(rec));
				if check_autoload(ctx, ops, &name)? != 0 {
					returnval = 1;
				}
				continue;
			}
			let name = add_autoload_function(ctx, a, on)?;
			if check_autoload(ctx, ops, &name)? != 0 {
				returnval = 1;
			}
		} else {
			returnval = 1;
		}
	}
	ctx.out(&out);
	done(returnval)
}

/// zsh `mkautofn` and `add_autoload_function`: a new autoload stub with
/// attributes `on` for `arg`, which is `/dir/name` for one loaded from
/// that directory (`PM_ABSPATH_USED`); a bare name autoloaded by a
/// function itself loaded by an absolute path is looked for in that
/// function's directory first, if a file for it is there. Its name.
fn add_autoload_function(ctx: &mut Ctx<'_, '_>, arg: &[u8], on: Attrs) -> Result<BString, Need> {
	let (name, file, attrs) = match arg.rfind_byte(b'/') {
		Some(s) if arg.starts_with(b"/") && s + 1 < arg.len() => (
			BString::from(tail(arg, s + 1)),
			BString::from(head(arg, s.max(1))),
			on.with(Attrs::ZSH_ABSPATH_USED),
		),
		_ => {
			let caller = running_function(ctx, None);
			let dir = match caller {
				Some(c) => match ctx.function(&c)? {
					Some(Record::Func { attrs, file, .. })
						if attrs.contains(Attrs::ZSH_ABSPATH_USED) && !file.is_empty() =>
					{
						// A loaded function's file is `DIR/NAME`, a stub's
						// its directory.
						if attrs.contains(Attrs::ZSH_UNDEFINED) {
							Some(file)
						} else {
							file
								.rfind_byte(b'/')
								.map(|s| BString::from(head(&file, s.max(1))))
						}
					},
					_ => None,
				},
				None => None,
			};
			let mut found = None;
			if let Some(dir) = dir {
				let mut path = dir.clone();
				path.push(b'/');
				path.extend_from_slice(arg);
				if ctx.probe(Probe::Access { path, mode: 4 })? == ProbeResult::Ok(true) {
					found = Some(dir);
				}
			}
			match found {
				Some(dir) => (BString::from(arg), dir, on.with(Attrs::ZSH_ABSPATH_USED)),
				None => (BString::from(arg), BString::default(), on),
			}
		},
	};
	let rec = Record::Func {
		mode: ctx.vp.mode,
		sticky: ctx.vp.sticky().cloned().map(Box::new),
		source: BString::default().into(),
		unit: UnitId([0; 32]),
		attrs,
		file,
	};
	super::trap::func_changing(ctx.k, ctx.cx.store, ctx.vp, &name, false)?;
	ctx.store_record(KeyBuf::Func(name.clone()), Some(rec));
	Ok(name)
}

/// The innermost running function (zsh `funcstack`'s first `FS_FUNC`)
/// other than `not`.
fn running_function(ctx: &Ctx<'_, '_>, not: Option<&[u8]>) -> Option<BString> {
	ctx.vp.frames.iter().rev().find_map(|f| match &f.kind {
		crate::bash::vm::proc::FrameKind::Function { name, .. }
			if name.as_slice() != crate::bash::ir::ANON.as_bytes() && not != Some(name.as_slice()) =>
		{
			Some(name.clone())
		},
		_ => None,
	})
}

/// zsh `check_autoload` for function `name` after its flags changed:
/// `+X` loads it (zsh `eval_autoload`); `-r`/`-R` resolve a stub's
/// directory now (its own if the definition is there, else the `$fpath`
/// directory holding it); `-R` reports one not found. Its status.
fn check_autoload(ctx: &mut Ctx<'_, '_>, ops: &Ops, name: &[u8]) -> Result<i32, Need> {
	let Some(Record::Func { mode, sticky, source, unit, attrs, file }) = ctx.function(name)? else {
		return Ok(0);
	};
	if !attrs.contains(Attrs::ZSH_UNDEFINED) {
		return Ok(i32::from(ops.isset(b'X')));
	}
	if ops.isset(b'X') {
		let fksh = if ops.isset(b'k') {
			Some(true)
		} else if ops.isset(b'z') {
			Some(false)
		} else {
			None
		};
		return Ok(i32::from(!load_stub(ctx, name, fksh, ops.isset(b'd'))?));
	}
	if !(ops.isset(b'r') || ops.isset(b'R')) {
		return Ok(0);
	}
	let fpath = ctx.scalar(b"FPATH")?;
	let fpath = crate::bash::vm::command::fpath_dirs(
		fpath.as_ref().map(|s| s.as_slice()),
		ctx.k.engine.config().platform,
	);
	let cwd = ctx.vp.cwd.clone();
	let not_found = |ctx: &mut Ctx<'_, '_>| {
		ctx.diag(Diag::Usage {
			msg: format!("{}: function definition file not found", BStr::new(name)).into(),
		});
	};
	if !file.is_empty() {
		let found = {
			let mut ask = |p: Probe| ctx.probe(p);
			crate::bash::vm::command::getfpfunc::<Need>(
				&mut ask,
				&cwd,
				name,
				std::slice::from_ref(&file),
				false,
			)?
		};
		if !matches!(found, crate::bash::vm::command::FpFound::None) {
			return Ok(0);
		}
		if !ops.isset(b'd') {
			if ops.isset(b'R') {
				not_found(ctx);
				return Ok(1);
			}
			return Ok(0);
		}
	}
	let dir = {
		let mut ask = |p: Probe| ctx.probe(p);
		match crate::bash::vm::command::getfpfunc::<Need>(&mut ask, &cwd, name, &fpath, false)? {
			crate::bash::vm::command::FpFound::None => None,
			crate::bash::vm::command::FpFound::File { dir, .. } => {
				Some(crate::bash::vm::command::load_dir::<Need>(&mut ask, &cwd, &dir)?)
			},
			// zsh's `fdir` of a word code file: the `$fpath` entry.
			crate::bash::vm::command::FpFound::Dump(_) => None,
		}
	};
	if let Some(dir) = dir {
		let rec = Record::Func { mode, sticky, source, unit, attrs, file: dir };
		ctx.store_record(KeyBuf::Func(BString::from(name)), Some(rec));
		return Ok(0);
	}
	if ops.isset(b'R') {
		not_found(ctx);
		return Ok(1);
	}
	Ok(0)
}

/// zsh `loadautofn(shf, fksh, 1, current_fpath)` from a builtin for the
/// stub `name`: find its definition and install it (zsh style; `fksh`
/// `Some(true)` forces ksh style, `Some(false)` zsh style, `None` the
/// stub's and `kshautoload`'s choice). `false` when it was not loaded
/// (reported).
fn load_stub(
	ctx: &mut Ctx<'_, '_>,
	name: &[u8],
	fksh: Option<bool>,
	current_fpath: bool,
) -> Result<bool, Need> {
	let Some(Record::Func { mode, sticky, attrs, file, .. }) = ctx.function(name)? else {
		return Ok(false);
	};
	let ksh = match fksh {
		Some(k) => k,
		None => {
			attrs.contains(Attrs::ZSH_KSHSTORED)
				|| (!attrs.contains(Attrs::ZSH_ZSHSTORED) && isset(ctx, ZshOpt::Kshautoload)?)
		},
	};
	let fpath = ctx.scalar(b"FPATH")?;
	let fpath = crate::bash::vm::command::fpath_dirs(
		fpath.as_ref().map(|s| s.as_slice()),
		ctx.k.engine.config().platform,
	);
	let cwd = ctx.vp.cwd.clone();
	let found = {
		let mut ask = |p: Probe| ctx.probe(p);
		match crate::bash::vm::command::find_autoload::<Need>(
			&mut ask,
			&cwd,
			name,
			attrs,
			&file,
			&fpath,
			current_fpath,
		)? {
			crate::bash::vm::command::FpFound::File { dir, text } => {
				Ok((crate::bash::vm::command::load_dir::<Need>(&mut ask, &cwd, &dir)?, text))
			},
			missing => Err(missing),
		}
	};
	let (dir, text) = match found {
		Ok(found) => found,
		Err(crate::bash::vm::command::FpFound::Dump(dump)) => {
			ctx.diag(super::zsh_zcompile::word_code_only(&dump));
			return Ok(false);
		},
		Err(_) => {
			ctx.diag(Diag::Usage {
				msg: format!("{}: function definition file not found", BStr::new(name)).into(),
			});
			return Ok(false);
		},
	};
	if ksh {
		let what =
			format!("loading the ksh-style autoload function {} without running it", BStr::new(name));
		ctx.diag(Diag::Unsupported { what: what.into() });
		return Ok(false);
	}
	let def =
		crate::bash::vm::command::Autoloaded { name, text: &text, dir: &dir, mode, attrs, sticky };
	Ok(crate::bash::vm::command::define_autoloaded(ctx.k, ctx.vp, ctx.cx, def))
}

/// zsh `bin_functions -X [DIR]` in an autoload stub's body (or any
/// function): the innermost running function becomes a stub with
/// attributes `on` (loaded from `DIR` if given) and `eval_autoload`
/// runs it again as `name "$@"`, which loads and calls the definition.
fn autoload_x(ctx: &mut Ctx<'_, '_>, args: &[BString], on: Attrs) -> R {
	if args.len() > 1 {
		ctx.usage("-X: too many arguments");
		return done(1);
	}
	let Some(name) = running_function(ctx, None) else {
		ctx.usage("bad autoload");
		return done(1);
	};
	let file = match args.first() {
		Some(dir) => {
			let cwd = ctx.vp.cwd.clone();
			let mut ask = |p: Probe| ctx.probe(p);
			crate::bash::vm::command::load_dir::<Need>(&mut ask, &cwd, dir)?
		},
		None => BString::default(),
	};
	let rec = match ctx.function(&name)? {
		Some(Record::Func { mode, sticky, source, unit, .. }) => {
			Record::Func { mode, sticky, source, unit, attrs: on, file }
		},
		_ => Record::Func {
			mode: ctx.vp.mode,
			sticky: None,
			source: BString::default().into(),
			unit: UnitId([0; 32]),
			attrs: on,
			file,
		},
	};
	ctx.store_record(KeyBuf::Func(name.clone()), Some(rec));
	// zsh `bin_eval` of `NAME "$@"`.
	let mut src = crate::bash::vm::quote::sh_single_quote(&name);
	src.extend_from_slice(b" \"$@\"\n");
	crate::bash::vm::exec::push_script(ctx.vp, &src, 1, crate::bash::vm::proc::ScriptKind::Eval);
	Ok(super::Outcome { status: 0, control: super::Control::Frame })
}

/// zsh `bin_functions -c OLD NEW`: `NEW` becomes a copy of function `OLD`
/// (loaded first if it is an autoload stub); a copy of an autoloaded
/// function keeps its file but not its load directory.
fn copy_function(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let [old, new] = args else {
		ctx.usage("-c: requires two arguments");
		return done(1);
	};
	let Some(mut rec) = ctx.function(old)? else {
		ctx.usage(format!("no such function: {}", old.as_bstr()));
		return done(1);
	};
	if matches!(&rec, Record::Func { attrs, .. } if attrs.contains(Attrs::ZSH_UNDEFINED)) {
		if !load_stub(ctx, old, None, false)? {
			return done(1);
		}
		let Some(loaded) = ctx.function(old)? else {
			return done(1);
		};
		rec = loaded;
	}
	if let Record::Func { attrs, .. } = &mut rec {
		*attrs = attrs.without(Attrs::ZSH_ABSPATH_USED);
	}
	ctx.store_record(KeyBuf::Func(new.clone()), Some(rec));
	done(0)
}

/// zsh `bin_functions -M`/`+M`: list, add or remove user math functions
/// (zsh `listusermathfunc`, `removemathfunc`).
fn math_functions(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	use crate::bash::vm::zsh::arith::{UserMathFunc, user_math_funcs, user_math_record};
	let mut funcs = user_math_funcs(ctx.cx.store, ctx.vp)?;
	let save = |ctx: &mut Ctx<'_, '_>, funcs: &[UserMathFunc]| {
		ctx.store_record(KeyBuf::Misc(MiscKey::ZshMathFuncs), user_math_record(funcs));
	};
	let list = |f: &UserMathFunc, out: &mut Vec<u8>, rc: bool, cs: super::zsh_quote::Charset| {
		let showargs = if !f.func.is_empty() {
			3
		} else if f.max != if f.min != 0 { f.min } else { -1 } {
			2
		} else {
			i32::from(f.min != 0)
		};
		out.extend_from_slice(b"functions -M");
		if f.string {
			out.push(b's');
		}
		out.push(b' ');
		out.extend_from_slice(&f.name);
		if showargs >= 1 {
			out.extend_from_slice(format!(" {}", f.min).as_bytes());
		}
		if showargs >= 2 {
			out.extend_from_slice(format!(" {}", f.max).as_bytes());
		}
		if showargs >= 3 {
			out.push(b' ');
			out.extend_from_slice(&quotedzputs(&f.func, rc, cs));
		}
		out.push(b'\n');
	};
	let cs = charset(ctx)?;
	let rc = isset(ctx, ZshOpt::Rcquotes)?;
	let mut out = Vec::new();
	let mut returnval = 0;
	if args.is_empty() {
		for f in &funcs {
			list(f, &mut out, rc, cs);
		}
	} else if ops.isset(b'm') {
		for p in args {
			let Some(pat) = pattern_arg(ctx, p)? else {
				returnval = 1;
				continue;
			};
			if ops.plus(b'M') {
				funcs.retain(|f| !pat.matches(&f.name));
			} else {
				for f in funcs.iter().filter(|f| pat.matches(&f.name)) {
					list(f, &mut out, rc, cs);
				}
			}
		}
		if ops.plus(b'M') {
			save(ctx, &funcs);
		}
	} else if ops.plus(b'M') {
		for a in args {
			funcs.retain(|f| f.name != *a);
		}
		save(ctx, &funcs);
	} else {
		let string = ops.isset(b's');
		let (mut min, mut max) = if string { (1, 1) } else { (0, -1) };
		let name = &args[0];
		let ident = |c: &u8| c.is_ascii_alphanumeric() || *c == b'_';
		if name.is_empty() || name[0].is_ascii_digit() || !name.iter().all(ident) {
			ctx.usage(format!("-M {}: bad math function name", name.as_bstr()));
			return done(1);
		}
		let mut rest = args[1..].iter();
		if let Some(a) = rest.next() {
			if let Some(n) = zstrtol(a).filter(|&n| n >= 0) {
				min = i32::try_from(n).unwrap_or(i32::MAX);
			} else {
				ctx.usage(format!("-M: invalid min number of arguments: {}", a.as_bstr()));
				return done(1);
			}
			if string && min != 1 {
				ctx.usage("-Ms: must take a single string argument");
				return done(1);
			}
			max = min;
			if let Some(a) = rest.next() {
				if let Some(n) = zstrtol(a).filter(|&n| n >= -1 && (n == -1 || n >= i64::from(min))) {
					max = i32::try_from(n).unwrap_or(i32::MAX);
				} else {
					ctx.usage(format!("-M: invalid max number of arguments: {}", a.as_bstr()));
					return done(1);
				}
				if string && max != 1 {
					ctx.usage("-Ms: must take a single string argument");
					return done(1);
				}
			}
		}
		let func = rest.next().cloned().unwrap_or_default();
		if rest.next().is_some() {
			ctx.usage("-M: too many arguments");
			return done(1);
		}
		funcs.retain(|f| f.name != *name);
		funcs.insert(0, UserMathFunc { name: name.clone(), string, min, max, func });
		save(ctx, &funcs);
	}
	ctx.out(&out);
	done(returnval)
}

/// zsh `zstrtol(s, &end, 0)` of all of `s`: leading blanks, a sign, `0x`
/// for hexadecimal and `0` for octal; `None` when anything follows.
fn zstrtol(s: &[u8]) -> Option<i64> {
	let s = s.trim_ascii_start();
	let (neg, s) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let (radix, digits) = if let Some(h) = s.strip_prefix(b"0x").or_else(|| s.strip_prefix(b"0X")) {
		(16, h)
	} else if s.len() > 1 && s[0] == b'0' {
		(8, &s[1..])
	} else {
		(10, s)
	};
	let n = i64::from_str_radix(std::str::from_utf8(digits).ok()?, radix).ok()?;
	Some(if neg { -n } else { n })
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
	if word_list(PREFIXES).any(|w| w == name) {
		return Ok(true);
	}
	// A module builtin exists while its module provides it or a stub
	// names it (a stub may name a builtin no module of the engine has).
	let present = match IntrinsicId::lookup(name, ctx.vp.mode) {
		Some(id) => super::zsh_module::builtin_present(ctx.cx.store, ctx.vp, id, name)?,
		None => super::zsh_module::builtin_stub(ctx.cx.store, ctx.vp, name)?,
	};
	Ok(present
		&& !words(ctx, MiscKey::DisabledBuiltins)?
			.iter()
			.any(|w| w == name))
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
		let separator = crate::bash::vm::probe::path_separator(ctx.k.engine.config().platform);
		for dir in path.split(|&c| c == separator) {
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
			if ops.isset(b's') || ops.isset(b'S') {
				print_if_link(ctx, p, ops.isset(b'S'), out)?;
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

/// zsh `print_if_link`: for an absolute `s`, ` -> ` and where it leads:
/// with `all` each step of the symbolic links met resolving it one at a
/// time (zsh `xsymlinks`), else its real path (zsh `chrealpath`).
fn print_if_link(ctx: &Ctx<'_, '_>, s: &[u8], all: bool, out: &mut Vec<u8>) -> Result<(), Need> {
	if s.first() != Some(&b'/') {
		return Ok(());
	}
	if !all {
		let real = chrealpath(ctx, s)?;
		out.extend_from_slice(b" -> ");
		out.extend_from_slice(if real.is_empty() { b"/" } else { &real });
		return Ok(());
	}
	let mut q = super::zsh_mod_files::Fsq::new(ctx);
	let mut start = BString::from(&s[1..]);
	loop {
		let mut xbuf = Vec::new();
		if !xsymlinks(&mut q, &mut xbuf, &start)? {
			return Ok(());
		}
		out.extend_from_slice(b" -> ");
		if xbuf.is_empty() {
			out.push(b'/');
			return Ok(());
		}
		out.extend_from_slice(&xbuf);
		start = BString::from(&xbuf[1..]);
	}
}

/// zsh `xsymlinks` of the relative path `s` onto `xbuf`: components
/// appended one at a time (`.` skipped, `..` dropping the last), up to the
/// first symbolic link, which is replaced by its target (relative to what
/// precedes it) with the remaining components after it. Whether a link
/// was met.
fn xsymlinks(
	q: &mut super::zsh_mod_files::Fsq<'_>,
	xbuf: &mut Vec<u8>,
	s: &[u8],
) -> Result<bool, Need> {
	let comps: Vec<&[u8]> = s.split(|&c| c == b'/').filter(|c| !c.is_empty()).collect();
	for (i, &comp) in comps.iter().enumerate() {
		if comp == b"." {
			continue;
		}
		if comp == b".." {
			if xbuf.as_slice() != b"/" && !xbuf.is_empty() {
				let cut = xbuf.iter().rposition(|&c| c == b'/').unwrap_or(0);
				xbuf.truncate(cut);
			}
			continue;
		}
		let mut path = xbuf.clone();
		path.push(b'/');
		path.extend_from_slice(comp);
		let Ok(link) =
			q.bytes(crate::bash::vm::fsprobe::FsReq::ReadLink { path: path.clone().into() })?
		else {
			*xbuf = path;
			continue;
		};
		if link.first() == Some(&b'/') {
			*xbuf = link.to_vec();
		} else {
			xbuf.push(b'/');
			xbuf.extend_from_slice(link);
		}
		for rest in &comps[i + 1..] {
			xbuf.push(b'/');
			xbuf.extend_from_slice(rest);
		}
		return Ok(true);
	}
	Ok(false)
}

/// zsh `chrealpath(…, 'P')` of the absolute path `s`: the longest prefix
/// ending at a `/` that resolves, resolved, with the rest appended; `s`
/// itself when none does.
fn chrealpath(ctx: &Ctx<'_, '_>, s: &[u8]) -> Result<BString, Need> {
	let mut cut = s.len();
	loop {
		if cut > 0
			&& let ProbeResult::Path(Some(real)) =
				ctx.probe(Probe::RealPath { path: BString::from(head(s, cut)) })?
		{
			let mut out = real;
			out.extend_from_slice(tail(s, cut));
			return Ok(out);
		}
		if cut == 0 {
			return Ok(BString::from(s));
		}
		cut = head(s, cut).iter().rposition(|&c| c == b'/').unwrap_or(0);
	}
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
			for i in IntrinsicId::iter().filter(|i| i.available_in(Dialect::Zsh)) {
				// A module builtin exists while its module provides it or a
				// stub names it.
				if super::zsh_module::builtin_state(ctx.cx.store, ctx.vp, i)?.is_some() {
					cands.push(BString::from(<&str>::from(i)));
				}
			}
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
		let mut b: Vec<BString> = word_list(PREFIXES).map(BString::from).collect();
		for i in IntrinsicId::iter().filter(|i| i.available_in(Dialect::Zsh)) {
			if super::zsh_module::builtin_state(ctx.cx.store, ctx.vp, i)?.is_some() {
				b.push(BString::from(<&str>::from(i)));
			}
		}
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
