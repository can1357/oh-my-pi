//! `zcompile` (zsh/main) and the word code file lookups of `source` and
//! autoloading.
//!
//! `zcompile` writes the `.zwc` files zsh 5.9 writes: the files are
//! compiled by [`wordcode::compile`] (zsh's parser emitting word code)
//! and laid out by [`zwc::write_dump`], so the user's real zsh reads them.
//! `zcompile -t` lists any dump zsh wrote.
//!
//! The engine runs source text, not word code: `source` and autoloading
//! keep reading the source file when zsh would prefer its compiled form
//! (the same definition when the dump was compiled from it); when only the
//! compiled form exists ([`source_dump`], [`fpath_dump`]) they fail loudly.
//! `zcompile -c` needs the word code of a function already loaded, which
//! the engine does not keep, and the order of several functions picked by
//! `-m` or by naming none is zsh's hash table order: both fail loudly.
//!
//! Ported from zsh 5.9 `Src/parse.c` (`bin_zcompile`, `build_dump`,
//! `build_cur_dump`, `cur_add_func`, `load_dump_header`, `try_dump_file`,
//! `check_dump_file`) and `Src/exec.c` (`getfpfunc`) (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group).

use bstr::{BStr, BString, ByteSlice};

use super::{Ctx, Need, R, done, zsh_args::Ops};
use crate::bash::{
	diag::Diag,
	fs::{Stat, StatKind},
	store::Attrs,
	syntax::{
		AliasLookup, Features, NO_ALIASES,
		zsh::{
			tok::metafy,
			wordcode::{self, CompileError, Eprog},
		},
	},
	vm::{
		fsprobe::{FsErr, FsReq, FsResult},
		probe::absolute,
		proc::{Probe, ProbeResult},
		zsh::zwc::{self, BadDump, DumpHeader, DumpProg, FD_EXT, FDHF_KSHLOAD, FDHF_ZSHLOAD, Map},
	},
	zshopt::ZshOpt,
};

/// zsh `bin_zcompile`.
pub fn zcompile(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let o = |c: u8| ops.isset(c);
	if (o(b'k') && o(b'z'))
		|| (o(b'R') && o(b'M'))
		|| (o(b'c') && (o(b'U') || o(b'k') || o(b'z')))
		|| (!(o(b'c') || o(b'a')) && o(b'm'))
	{
		ctx.usage("illegal combination of options");
		return done(1);
	}
	let cur = o(b'c') || o(b'a');
	if cur && ctx.zsh_option(ZshOpt::Kshautoload)? {
		ctx.usage("functions will use zsh style autoloading");
	}
	let flags = if o(b'k') {
		FDHF_KSHLOAD
	} else if o(b'z') {
		FDHF_ZSHLOAD
	} else {
		0
	};
	if o(b't') {
		return list(ctx, args);
	}
	let Some(first) = args.first() else {
		ctx.usage("too few arguments");
		return done(1);
	};
	let map = if o(b'M') {
		Map::Mapped
	} else if o(b'R') {
		Map::Read
	} else {
		Map::Auto
	};
	if args.len() == 1 && !cur {
		// The one file compiled into `FILE.zwc`, even when it ends in
		// `.zwc` already.
		let mut dump = first.clone();
		dump.extend_from_slice(FD_EXT);
		return build_dump(ctx, &dump, args, o(b'U'), map, flags);
	}
	let dump = with_ext(first);
	if cur {
		build_cur_dump(ctx, &dump, &args[1..], o(b'm'), map, (o(b'c'), o(b'a')))
	} else {
		build_dump(ctx, &dump, &args[1..], o(b'U'), map, flags)
	}
}

/// `name` with `.zwc` appended unless it ends in it.
fn with_ext(name: &[u8]) -> BString {
	let mut d = BString::from(name);
	if !d.ends_with(FD_EXT) {
		d.extend_from_slice(FD_EXT);
	}
	d
}

/// zsh `check_cond(input, cond)`: `input` is `-COND`.
fn check_cond(input: &[u8], cond: &[u8]) -> bool {
	input.first() == Some(&b'-') && &input[1..] == cond
}

/// `zcompile -t FILE [NAME…]` (zsh `load_dump_header` with its messages).
fn list(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let Some(first) = args.first() else {
		ctx.usage("too few arguments");
		return done(1);
	};
	let name = with_ext(first);
	let path = absolute(&ctx.vp.cwd, &name);
	let data = match ctx.probe(Probe::Read { path })? {
		ProbeResult::Bytes(Ok(data)) => Some(data),
		// zsh opens a directory, then fails to read it.
		ProbeResult::Bytes(Err(msg)) if msg.as_slice() == b"Is a directory" => None,
		_ => {
			ctx.usage(format!("can't open zwc file: {}", name.as_bstr()));
			return done(1);
		},
	};
	let head = match data.as_ref().map(|d| DumpHeader::parse(d)) {
		Some(Ok(h)) => h,
		Some(Err(BadDump::Version(v))) => {
			ctx.usage(format!("zwc file has wrong version (zsh-{}): {}", v.as_bstr(), name.as_bstr()));
			return done(1);
		},
		Some(Err(BadDump::Invalid)) | None => {
			ctx.usage(format!("invalid zwc file: {}", name.as_bstr()));
			return done(1);
		},
	};
	if args.len() > 1 {
		let all = args[1..].iter().all(|a| head.find_func(&metafy(a)));
		return done(i32::from(!all));
	}
	let mut out = Vec::new();
	out.extend_from_slice(b"zwc file (");
	out.extend_from_slice(if head.mapped() {
		&b"mapped"[..]
	} else {
		&b"read"[..]
	});
	out.extend_from_slice(b") for zsh-");
	out.extend_from_slice(head.version());
	out.push(b'\n');
	for f in head.funcs() {
		out.extend_from_slice(f.name);
		out.push(b'\n');
	}
	ctx.out(&out);
	done(0)
}

/// The grammar switches and aliases `zcompile` parses with: the shell's
/// current ones; comments are always recognised (zsh's `parse_string`
/// reads from a string).
fn parse_setup(ctx: &mut Ctx<'_, '_>) -> Result<(Features, Option<super::names::Aliases>), Need> {
	let feat =
		crate::bash::vm::mode::features(&mut ctx.k.root, ctx.cx.store, ctx.vp, Features::NONE)?;
	let aliases = super::alias_table(ctx.k, ctx.cx, ctx.vp)?;
	Ok((feat | Features::ZSH_INTERACTIVE_COMMENTS, aliases))
}

/// Compile `text` with the shell's switches and aliases (`noaliases`:
/// `-U`, or a function autoloaded with `-U`). On failure the messages zsh
/// printed are queued; `Ok(None)` then.
fn compile(
	ctx: &mut Ctx<'_, '_>,
	setup: &(Features, Option<super::names::Aliases>),
	text: &[u8],
	noaliases: bool,
	what: &[u8],
) -> Option<Eprog> {
	let lookup: &dyn AliasLookup = match &setup.1 {
		Some(t) => t,
		None => NO_ALIASES,
	};
	match wordcode::compile(text, setup.0, lookup, noaliases) {
		Ok(p) => Some(p),
		Err(CompileError::Syntax(msgs)) => {
			for (line, msg) in msgs {
				ctx.diag(Diag::ZshAtLine { line, msg: BString::from(msg) });
			}
			None
		},
		Err(CompileError::Undefined(why)) => {
			ctx.diag(Diag::Unsupported {
				what: format!("zcompile of {} ({why})", what.as_bstr()).into(),
			});
			None
		},
	}
}

/// A [`Probe::Fs`] request numbered `seq`.
fn fs(ctx: &Ctx<'_, '_>, seq: u32, req: FsReq) -> Result<FsResult, Need> {
	Ok(match ctx.probe(Probe::Fs { seq, req: Box::new(req) })? {
		ProbeResult::Fs(r) => r,
		_ => Err(FsErr { errno: 0, text: BString::default() }),
	})
}

/// The end of `build_dump`/`build_cur_dump`. zsh removes the dump and
/// creates it (mode 0444) before it reads anything: when that fails, its
/// only message is `can't write zwc file`, so the messages queued since
/// `mark` are dropped. `data` is the dump to write; `None` after a
/// failure, whose dump zsh removes again.
fn finish(ctx: &mut Ctx<'_, '_>, mark: usize, dump: &[u8], data: Option<Vec<u8>>) -> R {
	let path = absolute(&ctx.vp.cwd, dump);
	let _ = fs(ctx, 0, FsReq::Unlink { path: path.clone() })?;
	let ok = data.is_some();
	let data = BString::from(data.unwrap_or_default());
	if fs(ctx, 1, FsReq::MapWrite { path: path.clone(), data, mode: 0o444 })?.is_err() {
		ctx.chunks.truncate(mark);
		ctx.usage(format!("can't write zwc file: {}", BStr::new(dump)));
		return done(1);
	}
	if ok {
		return done(0);
	}
	let _ = fs(ctx, 2, FsReq::Unlink { path })?;
	done(1)
}

/// The text of `file` if it is a regular file zsh can open and read
/// (`Err` is the message: `can't open file`).
fn read_file(ctx: &Ctx<'_, '_>, file: &[u8]) -> Result<Option<BString>, Need> {
	let path = absolute(&ctx.vp.cwd, file);
	let regular = matches!(
		ctx.probe(Probe::Stat { path: path.clone(), follow: true })?,
		ProbeResult::Stat(Some(st)) if st.kind == StatKind::File
	);
	if !regular {
		return Ok(None);
	}
	Ok(match ctx.probe(Probe::Read { path })? {
		ProbeResult::Bytes(Ok(text)) => Some(text),
		_ => None,
	})
}

/// zsh `build_dump`: compile `files` into `dump`.
fn build_dump(
	ctx: &mut Ctx<'_, '_>,
	dump: &[u8],
	files: &[BString],
	noaliases: bool,
	map: Map,
	mut flags: u32,
) -> R {
	let dump = with_ext(dump);
	let mark = ctx.chunks.len();
	let setup = parse_setup(ctx)?;
	let mut progs: Vec<(Vec<u8>, Eprog, u32)> = Vec::new();
	for file in files {
		if check_cond(file, b"k") {
			flags = FDHF_KSHLOAD;
			continue;
		}
		if check_cond(file, b"z") {
			flags = FDHF_ZSHLOAD;
			continue;
		}
		let Some(text) = read_file(ctx, file)? else {
			ctx.usage(format!("can't open file: {}", file.as_bstr()));
			return finish(ctx, mark, &dump, None);
		};
		let Some(prog) = compile(ctx, &setup, &text, noaliases, file) else {
			ctx.usage(format!("can't read file: {}", file.as_bstr()));
			return finish(ctx, mark, &dump, None);
		};
		// zsh stores the name as given (metafied).
		progs.push((metafy(file), prog, flags));
	}
	let entries: Vec<DumpProg<'_>> = progs
		.iter()
		.map(|(name, prog, flags)| DumpProg { name, prog, flags: *flags })
		.collect();
	let data = zwc::write_dump(&entries, map);
	finish(ctx, mark, &dump, Some(data))
}

/// zsh `build_cur_dump`: compile shell functions into `dump`; `what` is
/// (`-c`, `-a`).
fn build_cur_dump(
	ctx: &mut Ctx<'_, '_>,
	dump: &[u8],
	names: &[BString],
	matching: bool,
	map: Map,
	what: (bool, bool),
) -> R {
	let dump = with_ext(dump);
	let mark = ctx.chunks.len();
	let funcs = super::vars::all_functions(ctx)?;
	let mut chosen: Vec<(BString, Attrs)> = Vec::new();
	if names.is_empty() || matching {
		let mut pats = Vec::new();
		for n in names {
			let Some(p) = super::zsh_args::pattern_arg(ctx, n)? else {
				return finish(ctx, mark, &dump, None);
			};
			pats.push(p);
		}
		for (name, _, attrs) in &funcs {
			if names.is_empty() || pats.iter().any(|p| p.matches(name)) {
				chosen.push((name.clone(), *attrs));
			}
		}
		if chosen.len() > 1 {
			// zsh walks its function hash table: an order this engine
			// does not keep.
			ctx.diag(Diag::Unsupported {
				what: "zcompile -c/-a of several functions chosen by pattern or by naming none".into(),
			});
			return done(1);
		}
	} else {
		for n in names {
			if let Some((name, _, attrs)) = funcs.iter().find(|(name, ..)| name == n) {
				chosen.push((name.clone(), *attrs));
			} else {
				ctx.usage(format!("unknown function: {}", n.as_bstr()));
				return finish(ctx, mark, &dump, None);
			}
		}
	}
	let setup = parse_setup(ctx)?;
	let mut progs: Vec<(Vec<u8>, Eprog)> = Vec::new();
	for (name, attrs) in &chosen {
		match cur_add_func(ctx, &setup, name, *attrs, what)? {
			Some(prog) => progs.push((metafy(name), prog)),
			None => return finish(ctx, mark, &dump, None),
		}
	}
	if progs.is_empty() {
		ctx.usage("no functions");
		return finish(ctx, mark, &dump, None);
	}
	let entries: Vec<DumpProg<'_>> = progs
		.iter()
		.map(|(name, prog)| DumpProg { name, prog, flags: FDHF_ZSHLOAD })
		.collect();
	let data = zwc::write_dump(&entries, map);
	finish(ctx, mark, &dump, Some(data))
}

/// zsh `cur_add_func`: the program of function `name`, `None` after
/// queuing why there is none.
fn cur_add_func(
	ctx: &mut Ctx<'_, '_>,
	setup: &(Features, Option<super::names::Aliases>),
	name: &BString,
	attrs: Attrs,
	(loaded_ok, undefined_ok): (bool, bool),
) -> Result<Option<Eprog>, Need> {
	if !attrs.contains(Attrs::ZSH_UNDEFINED) {
		if !loaded_ok {
			ctx.usage(format!("function is already loaded: {}", name.as_bstr()));
			return Ok(None);
		}
		// zsh dumps the word code it keeps for the function; the engine
		// keeps none.
		ctx.diag(Diag::Unsupported {
			what: format!("zcompile -c of the loaded function `{}'", name.as_bstr()).into(),
		});
		return Ok(None);
	}
	if !undefined_ok {
		ctx.usage(format!("function is not loaded: {}", name.as_bstr()));
		return Ok(None);
	}
	let noaliases = attrs.contains(Attrs::ZSH_UNALIASED);
	// zsh `getfpfunc`.
	let fpath = ctx.scalar(b"FPATH")?.unwrap_or_default();
	let sep = crate::bash::vm::probe::path_separator(ctx.k.engine.config().platform);
	for dir in fpath.split(|&c| c == sep).filter(|d| !d.is_empty()) {
		let mut file = BString::from(dir);
		file.push(b'/');
		file.extend_from_slice(name);
		let cwd = ctx.vp.cwd.clone();
		let found = {
			let mut ask = |p: Probe| ctx.probe(p);
			match try_dump_file::<Need>(&mut ask, &cwd, dir, name, &file)? {
				Some(dump) => check_dump_file::<Need>(&mut ask, &cwd, &dump, name)?,
				None => None,
			}
		};
		if let Some(prog) = found {
			return Ok(Some(prog));
		}
		if let Some(text) = read_file(ctx, &file)? {
			let prog = compile(ctx, setup, &text, noaliases, &file);
			if prog.is_none() {
				ctx.usage(format!("can't load function: {}", name.as_bstr()));
			}
			return Ok(prog);
		}
	}
	ctx.usage(format!("can't load function: {}", name.as_bstr()));
	Ok(None)
}

/// What answers the probes of the dump lookups: a builtin's
/// [`Ctx::probe`], or the probe of the command an op runs.
pub type Ask<'a, E> = dyn FnMut(Probe) -> Result<ProbeResult, E> + 'a;

/// `stat` of `path` (relative to `cwd`).
fn stat<E>(ask: &mut Ask<'_, E>, cwd: &[u8], path: &[u8]) -> Result<Option<Stat>, E> {
	let path = absolute(cwd, path);
	Ok(match ask(Probe::Stat { path, follow: true })? {
		ProbeResult::Stat(st) => st,
		_ => None,
	})
}

/// Whole seconds of a modification time (zsh compares `st_mtime`).
const fn mtime(st: &Stat) -> i64 {
	st.mtime_ns.div_euclid(1_000_000_000)
}

/// zsh `check_dump_file`: the program of function `name` in dump `path`.
fn check_dump_file<E>(
	ask: &mut Ask<'_, E>,
	cwd: &[u8],
	path: &[u8],
	name: &[u8],
) -> Result<Option<Eprog>, E> {
	let ProbeResult::Bytes(Ok(data)) = ask(Probe::Read { path: absolute(cwd, path) })? else {
		return Ok(None);
	};
	let Ok(head) = DumpHeader::parse(&data) else {
		return Ok(None);
	};
	Ok(head.func_prog(&data, &metafy(name)))
}

/// Whether the dump `path` (relative to `cwd`; its `stat` is `st`) holds
/// function `name`, as [`check_dump_file`] would load it: asked once per
/// dump ([`Probe::DumpHas`]), not read again for every function.
fn dump_holds<E>(
	ask: &mut Ask<'_, E>,
	cwd: &[u8],
	path: &[u8],
	name: &[u8],
	st: Option<&Stat>,
) -> Result<bool, E> {
	let Some(st) = st else {
		return Ok(false);
	};
	let probe = Probe::DumpHas(Box::new(crate::bash::vm::proc::DumpQuery {
		path:     absolute(cwd, path),
		name:     BString::from(metafy(name)),
		mtime_ns: st.mtime_ns,
		size:     st.size,
	}));
	Ok(matches!(ask(probe)?, ProbeResult::Ok(true)))
}

/// zsh `try_dump_file(dir, name, file)`: the dump zsh loads function or
/// script `name` from, in preference to `file` (`dir/name`): `dir` itself
/// when it is a digest (`….zwc`), else the digest `dir.zwc` when it is
/// not older than `file` and `file.zwc`, else `file.zwc` when it is not
/// older than `file`.
fn try_dump_file<E>(
	ask: &mut Ask<'_, E>,
	cwd: &[u8],
	dir: &[u8],
	name: &[u8],
	file: &[u8],
) -> Result<Option<BString>, E> {
	if dir.ends_with(FD_EXT) {
		let st = stat(ask, cwd, dir)?;
		return Ok(dump_holds(ask, cwd, dir, name, st.as_ref())?.then(|| BString::from(dir)));
	}
	let dig = with_ext(dir);
	let mut wc = BString::from(file);
	wc.extend_from_slice(FD_EXT);
	let rd = stat(ask, cwd, &dig)?;
	let rc = stat(ask, cwd, &wc)?;
	let rn = stat(ask, cwd, file)?;
	if let Some(d) = &rd
		&& rc.as_ref().is_none_or(|c| mtime(d) >= mtime(c))
		&& rn.as_ref().is_none_or(|n| mtime(d) >= mtime(n))
		&& dump_holds(ask, cwd, &dig, name, Some(d))?
	{
		return Ok(Some(dig));
	}
	if let Some(c) = &rc
		&& rn.as_ref().is_none_or(|n| mtime(c) >= mtime(n))
		&& dump_holds(ask, cwd, &wc, name, Some(c))?
	{
		return Ok(Some(wc));
	}
	Ok(None)
}

/// The word code file zsh's `getfpfunc` would load function `name` from
/// in `$fpath` directory `dir` (or digest `dir`, a `.zwc` file), if any;
/// paths are relative to `cwd`. Autoloading reads `dir/name` instead when
/// it exists; when it does not, the definition exists only as word code,
/// which the engine cannot run, and loading must fail loudly.
pub fn fpath_dump<E>(
	ask: &mut Ask<'_, E>,
	cwd: &[u8],
	dir: &[u8],
	name: &[u8],
) -> Result<Option<BString>, E> {
	let mut file = BString::from(dir);
	file.push(b'/');
	file.extend_from_slice(name);
	try_dump_file(ask, cwd, dir, name, &file)
}

/// The paths [`crate::bash::vm::command::getfpfunc`] and [`fpath_dump`]
/// `stat` while they look for function `name` in `$fpath` directory `dir`
/// (absolute, from `cwd`): `dir/name`, and `dir` itself when it is a
/// digest, else `dir.zwc` and `dir/name.zwc`.
pub fn fpath_stat_paths(cwd: &[u8], dir: &[u8], name: &[u8]) -> Vec<BString> {
	let mut file = BString::from(dir);
	if !file.is_empty() {
		file.push(b'/');
	}
	file.extend_from_slice(name);
	let mut out = vec![absolute(cwd, &file)];
	if dir.ends_with(FD_EXT) {
		out.push(absolute(cwd, dir));
	} else {
		out.push(absolute(cwd, &with_ext(dir)));
		file.extend_from_slice(FD_EXT);
		out.push(absolute(cwd, &file));
	}
	out
}

/// The word code file zsh's `try_source_file` would run for `path`, a
/// script that does not exist (relative to `cwd`): `path` itself when it
/// is a dump holding its base name, else `path.zwc` holding it.
pub fn source_dump<E>(ask: &mut Ask<'_, E>, cwd: &[u8], path: &[u8]) -> Result<Option<BString>, E> {
	let tail = path.rsplit(|&c| c == b'/').next().unwrap_or(path);
	if path.ends_with(FD_EXT) {
		let st = stat(ask, cwd, path)?;
		return Ok(dump_holds(ask, cwd, path, tail, st.as_ref())?.then(|| BString::from(path)));
	}
	let wc = with_ext(path);
	let st = stat(ask, cwd, &wc)?;
	Ok(dump_holds(ask, cwd, &wc, tail, st.as_ref())?.then_some(wc))
}

/// The unsupported-feature report for a definition or script zsh would
/// run from the word code file `dump` alone.
pub fn word_code_only(dump: &[u8]) -> Diag {
	Diag::Unsupported {
		what: format!("running the word code of `{}' (no source file)", BStr::new(dump)).into(),
	}
}
