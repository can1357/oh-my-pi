//! Names: aliases, `type`, `command -v`, `compgen`, `hash`.

use std::{collections::HashMap, io::Write};

use bstr::{BStr, BString, ByteSlice};

use super::{
	Ctx, Need, R, done,
	io::bind_lhs,
	opts,
	vars::{Lhs, all_functions},
};
use crate::bash::{
	diag::Diag,
	host::{ResolveCtx, Resolved, Via},
	ids::IntrinsicId,
	pattern::PatOpts,
	store::{Key, KeyBuf, OptId, OptKind, Record, StoreError, Table},
	syntax::AliasLookup,
	vm::{
		Cx, Kernel,
		exec::mode_of,
		expand::DEFAULT_IFS,
		locale,
		probe::{self, absolute},
		proc::{AssignValue, Probe, ProbeResult, Vproc},
		quote, state,
	},
};

/// The alias table the parser sees while reading one top-level command
/// (kept in a zsh string's frame, [`crate::bash::vm::proc::ParseSnapshot`]).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Aliases {
	/// Regular aliases (command position).
	regular:  HashMap<BString, BString>,
	/// zsh global aliases (`alias -g`, any word position).
	global:   HashMap<BString, BString>,
	/// zsh suffix aliases (`alias -s`), by suffix.
	suffix:   HashMap<BString, BString>,
	/// zsh reserved words turned off by `disable -r`.
	reswords: Vec<BString>,
	/// zsh/param/private is loaded: `private` is a reserved word.
	private:  bool,
}

impl Aliases {
	fn is_empty(&self) -> bool {
		self.regular.is_empty()
			&& self.global.is_empty()
			&& self.suffix.is_empty()
			&& self.reswords.is_empty()
			&& !self.private
	}
}

impl AliasLookup for Aliases {
	fn alias(&self, name: &[u8]) -> Option<&[u8]> {
		self.regular.get(name).map(|v| v.as_slice())
	}

	fn global_alias(&self, name: &[u8]) -> Option<&[u8]> {
		self.global.get(name).map(|v| v.as_slice())
	}

	fn suffix_alias(&self, suffix: &[u8]) -> Option<&[u8]> {
		self.suffix.get(suffix).map(|v| v.as_slice())
	}

	fn reserved_disabled(&self, word: &[u8]) -> bool {
		self.reswords.iter().any(|w| w.as_slice() == word)
	}

	fn module_reserved(&self, word: &[u8]) -> bool {
		self.private && word == b"private"
	}
}

/// The aliases in effect for the next parse: `None` when alias expansion
/// is off (`expand_aliases` unset outside POSIX mode) or none are defined.
pub fn alias_table(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
) -> Result<Option<Aliases>, StoreError> {
	if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		return zsh_alias_table(k, cx, vp);
	}
	let on = state::option(&mut k.root, cx.store, vp, OptId::ExpandAliases)?
		|| state::option(&mut k.root, cx.store, vp, OptId::Posix)?;
	if !on {
		return Ok(None);
	}
	let regular: HashMap<BString, BString> = state::scan(&k.root, cx.store, vp, Table::Alias)?
		.into_iter()
		.filter_map(|(k, r)| match (k, r) {
			(KeyBuf::Alias(n), Record::Alias(v)) => Some((n, v)),
			_ => None,
		})
		.collect();
	Ok((!regular.is_empty()).then(|| Aliases { regular, ..Aliases::default() }))
}

/// [`alias_table`] in the zsh dialect: with the `aliases` option on, the
/// regular, global and suffix aliases not turned off by `disable -a`/`-s`;
/// always the reserved words `disable -r` turned off.
fn zsh_alias_table(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
) -> Result<Option<Aliases>, StoreError> {
	use crate::bash::store::{Key, MiscKey};
	fn words(cx: &mut Cx<'_>, vp: &Vproc, key: MiscKey) -> Result<Vec<BString>, StoreError> {
		Ok(match state::record(cx.store, vp, Key::Misc(key))? {
			Some(Record::Words(w)) => w.clone(),
			_ => Vec::new(),
		})
	}
	let mut table = Aliases {
		reswords: words(cx, vp, MiscKey::ZshDisabledReswords)?,
		private: super::zsh_module::loaded(cx.store, vp, b"zsh/param/private")?,
		..Aliases::default()
	};
	if state::zsh_option(&mut k.root, cx.store, vp, crate::bash::zshopt::ZshOpt::Aliases)? {
		let off = words(cx, vp, MiscKey::ZshDisabledAliases)?;
		let off_suffix = words(cx, vp, MiscKey::ZshDisabledSuffixAliases)?;
		for (key, rec) in state::scan(&k.root, cx.store, vp, Table::Alias)? {
			if let (KeyBuf::Alias(n), Record::Alias(v)) = (key, rec)
				&& !off.contains(&n)
			{
				table.regular.insert(n, v);
			}
		}
		for (key, rec) in state::scan(&k.root, cx.store, vp, Table::ZshAlias)? {
			if let (KeyBuf::ZshAlias { suffix, name }, Record::Alias(v)) = (key, rec) {
				if suffix && !off_suffix.contains(&name) {
					table.suffix.insert(name, v);
				} else if !suffix && !off.contains(&name) {
					table.global.insert(name, v);
				}
			}
		}
	}
	Ok((!table.is_empty()).then_some(table))
}

/// bash `legal_alias_name`.
pub fn legal_alias_name(name: &[u8]) -> bool {
	!name.is_empty() && !name.iter().any(|c| b"/$`=|&;()<> \t\n'\"\\".contains(c))
}

/// Every alias, sorted by name.
fn all_aliases(ctx: &mut Ctx<'_, '_>) -> Result<Vec<(BString, BString)>, Need> {
	Ok(state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::Alias)?
		.into_iter()
		.filter_map(|(k, r)| match (k, r) {
			(KeyBuf::Alias(n), Record::Alias(v)) => Some((n, v)),
			_ => None,
		})
		.collect())
}

fn alias_line(name: &[u8], value: &[u8], out: &mut Vec<u8>) {
	out.extend_from_slice(b"alias ");
	out.extend_from_slice(name);
	out.push(b'=');
	out.extend_from_slice(&quote::single(value));
	out.push(b'\n');
}

/// The alias `name`, if defined.
fn alias_of(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<Option<BString>, Need> {
	Ok(match ctx.record(crate::bash::store::Key::Alias(BStr::new(name)))? {
		Some(Record::Alias(v)) => Some(v),
		_ => None,
	})
}

/// `alias [-p] [name[=value] …]`.
pub fn alias(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"p", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let mut out = Vec::new();
	if o.rest.is_empty() || o.has(b'p') {
		for (name, value) in all_aliases(ctx)? {
			alias_line(&name, &value, &mut out);
		}
		if o.rest.is_empty() {
			ctx.out(&out);
			return done(0);
		}
	}
	let mut status = 0;
	for arg in o.rest {
		match arg.find_byte(b'=') {
			Some(eq) => {
				let (name, value) = (&arg[..eq], &arg[eq + 1..]);
				if !legal_alias_name(name) {
					ctx.out(&std::mem::take(&mut out));
					ctx.err(Diag::InvalidAlias { name: name.into() });
					status = 1;
					continue;
				}
				ctx.store_record(KeyBuf::Alias(name.into()), Some(Record::Alias(value.into())));
			},
			None => {
				if let Some(v) = alias_of(ctx, arg)? {
					alias_line(arg, &v, &mut out);
				} else {
					ctx.out(&std::mem::take(&mut out));
					ctx.err(Diag::NotFound { name: arg.clone() });
					status = 1;
				}
			},
		}
	}
	ctx.out(&out);
	done(status)
}

/// `unalias [-a] name …`.
pub fn unalias(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"a", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	if o.has(b'a') {
		for (name, _) in all_aliases(ctx)? {
			ctx.store_record(KeyBuf::Alias(name), None);
		}
		return done(0);
	}
	if o.rest.is_empty() {
		ctx.builtin_usage();
		return done(2);
	}
	let mut status = 0;
	for name in o.rest {
		if alias_of(ctx, name)?.is_some() {
			ctx.store_record(KeyBuf::Alias(name.clone()), None);
		} else {
			ctx.err(Diag::NotFound { name: name.clone() });
			status = 1;
		}
	}
	done(status)
}

/// bash's reserved words.
const KEYWORDS: [&[u8]; 22] = [
	b"if",
	b"then",
	b"else",
	b"elif",
	b"fi",
	b"case",
	b"esac",
	b"for",
	b"select",
	b"while",
	b"until",
	b"do",
	b"done",
	b"in",
	b"function",
	b"time",
	b"{",
	b"}",
	b"!",
	b"[[",
	b"]]",
	b"coproc",
];

/// What a name refers to, in `type` order.
enum Kind {
	Alias(BString),
	Keyword,
	Function(BString),
	Builtin,
	/// A POSIX special builtin in POSIX mode, found before functions.
	Special,
	File(BString),
	/// A command found in the hash table (`hash -p`, earlier lookups).
	Hashed(BString),
}

/// The hashed path of `name`, counting the lookup as a hit, as bash's
/// `phash_search` does.
fn hashed(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<Option<BString>, Need> {
	if name.contains(&b'/') {
		return Ok(None);
	}
	match ctx.record(Key::CmdHash(BStr::new(name)))? {
		Some(Record::CmdHash { path, hits }) => {
			let rec = Record::CmdHash { path: path.clone(), hits: hits.saturating_add(1) };
			ctx.store_record(KeyBuf::CmdHash(name.into()), Some(rec));
			Ok(Some(path))
		},
		_ => Ok(None),
	}
}

/// bash's `sv_path` (`phash_flush`): any assignment to `PATH`, a command's
/// temporary one included, and `unset PATH` empty the command hash table.
/// Called by the variable assignment and `unset` paths and the simple
/// command's prefix-assignment loop.
pub fn flush_hash(
	root: &mut state::Root,
	store: &mut dyn crate::bash::store::StateStore,
	vp: &mut Vproc,
) -> Result<(), StoreError> {
	for (key, _) in state::scan(root, store, vp, Table::CmdHash)? {
		state::store_record(root, store, vp, key, None);
	}
	// zsh: the emptied table is filled again from the start of `$path`.
	if state::record(
		store,
		vp,
		crate::bash::store::Key::Misc(crate::bash::store::MiscKey::ZshPathChecked),
	)?
	.is_some()
	{
		let key = crate::bash::store::KeyBuf::Misc(crate::bash::store::MiscKey::ZshPathChecked);
		state::store_record(root, store, vp, key, None);
	}
	Ok(())
}

/// Whether assigning or unsetting `name` empties the command hash table
/// ([`flush_hash`]): `PATH`, and on Windows `PATHEXT`, whose extensions
/// change the same answers.
pub fn resets_hash(platform: crate::bash::ids::Platform, name: &[u8]) -> bool {
	name == b"PATH" || (platform == crate::bash::ids::Platform::Windows && name == b"PATHEXT")
}

/// The `PATH` a lookup of `name` searches: bash's standard path for
/// `command -p` (`std_path`), else `$PATH`.
fn search_path(ctx: &mut Ctx<'_, '_>, std_path: bool) -> Result<BString, Need> {
	if std_path {
		return Ok(BString::from(probe::standard_path(ctx.k.engine.config().platform)));
	}
	Ok(ctx.scalar(b"PATH")?.unwrap_or_default())
}

/// Every meaning of `name` (`all`) or the first one; `path_only` skips
/// everything but files (`type -P`); `std_path` searches the standard
/// path instead of `$PATH` (`command -pv`).
fn kinds(
	ctx: &mut Ctx<'_, '_>,
	name: &[u8],
	all: bool,
	path_only: bool,
	std_path: bool,
) -> Result<Vec<Kind>, Need> {
	let mut found = Vec::new();
	if !path_only {
		// Aliases count only while alias expansion is on.
		if ctx.option(OptId::ExpandAliases)?
			&& let Some(v) = alias_of(ctx, name)?
		{
			found.push(Kind::Alias(v));
		}
		if KEYWORDS.contains(&name) {
			found.push(Kind::Keyword);
		}
		let special = ctx.option(OptId::Posix)?
			&& IntrinsicId::from_name(name).is_some_and(crate::bash::vm::command::is_special);
		if special {
			found.push(Kind::Special);
			if !all {
				return Ok(found);
			}
		}
		if let Some(Record::Func { source, .. }) = ctx.function(name)? {
			found.push(Kind::Function((*source).clone()));
		}
		if !found.is_empty() && !all {
			return Ok(found);
		}
		let mode = mode_of(ctx.vp);
		let rctx = ResolveCtx { has_slash: name.contains(&b'/'), via: Via::Type };
		let resolved = ctx.cx.host.resolve(BStr::new(name), mode, rctx);
		// `enable -n` hides a builtin; `enable -f` makes `strmatch` one.
		let intrinsic = match resolved {
			Resolved::Intrinsic(id) => Some(id),
			_ => None,
		};
		let usable = super::misc::usable(ctx.k, ctx.cx.store, ctx.vp, name, intrinsic)?;
		match resolved {
			Resolved::Intrinsic(_) | Resolved::NotFound if usable.is_some() => {
				if !special {
					found.push(Kind::Builtin);
				}
			},
			Resolved::Intrinsic(_) => {},
			Resolved::Tool(_) | Resolved::Native(_) | Resolved::Device(_) | Resolved::SelfShell => {
				if !special {
					found.push(Kind::Builtin);
				}
			},
			Resolved::External(p) => found.push(match hashed(ctx, name)? {
				Some(h) => Kind::Hashed(h),
				None => Kind::File(p),
			}),
			Resolved::NotFound => {
				if let Some(h) = hashed(ctx, name)? {
					found.push(Kind::Hashed(h));
				}
			},
		}
		if !found.is_empty() && !all {
			return Ok(found);
		}
	} else if let Some(h) = hashed(ctx, name)? {
		// `type -P`: the hash table first, as bash's `find_user_command`.
		found.push(Kind::Hashed(h));
		return Ok(found);
	}
	if name.contains(&b'/') {
		let p = absolute(&ctx.vp.cwd, name);
		if ctx.probe(Probe::Access { path: p, mode: 4 })? == ProbeResult::Ok(true) {
			found.push(Kind::File(name.into()));
		}
	} else {
		let path = search_path(ctx, std_path)?;
		if let ProbeResult::Path(Some(p)) = ctx.probe(Probe::Path { name: name.into(), path })? {
			found.push(Kind::File(p));
		}
	}
	Ok(found)
}

/// `type [-afptP] name …`.
pub fn type_(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"afptP", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let (all, terse, path) = (o.has(b'a'), o.has(b't'), o.has(b'p') || o.has(b'P'));
	let mut out = Vec::new();
	let mut status = 0;
	for name in o.rest {
		let mut found = kinds(ctx, name, all, o.has(b'P'), false)?;
		if o.has(b'f') {
			found.retain(|k| !matches!(k, Kind::Function(_)));
		}
		if found.is_empty() {
			if !terse && !path {
				ctx.out(&std::mem::take(&mut out));
				ctx.err(Diag::NotFound { name: name.clone() });
			}
			status = 1;
			continue;
		}
		for k in &found {
			if path {
				if let Kind::File(p) | Kind::Hashed(p) = k {
					out.extend_from_slice(p);
					out.push(b'\n');
				}
				continue;
			}
			if terse {
				let word: &[u8] = match k {
					Kind::Alias(_) => b"alias\n",
					Kind::Keyword => b"keyword\n",
					Kind::Function(_) => b"function\n",
					Kind::Builtin | Kind::Special => b"builtin\n",
					Kind::File(_) | Kind::Hashed(_) => b"file\n",
				};
				out.extend_from_slice(word);
				continue;
			}
			out.extend_from_slice(name);
			match k {
				Kind::Alias(v) => {
					out.extend_from_slice(b" is aliased to `");
					out.extend_from_slice(v);
					out.extend_from_slice(b"'\n");
				},
				Kind::Keyword => out.extend_from_slice(b" is a shell keyword\n"),
				Kind::Function(src) => {
					out.extend_from_slice(b" is a function\n");
					out.extend_from_slice(src);
					out.push(b'\n');
				},
				Kind::Builtin => out.extend_from_slice(b" is a shell builtin\n"),
				Kind::Special => out.extend_from_slice(b" is a special shell builtin\n"),
				Kind::File(p) => {
					out.extend_from_slice(b" is ");
					out.extend_from_slice(p);
					out.push(b'\n');
				},
				Kind::Hashed(p) => {
					out.extend_from_slice(b" is hashed (");
					out.extend_from_slice(p);
					out.extend_from_slice(b")\n");
				},
			}
		}
	}
	ctx.out(&out);
	done(status)
}

/// `command -v` / `command -V` (other forms are resolved by the `Exec`).
/// As bash's, the status is 0 when any name is found (misses still print
/// their `-V` diagnostic).
pub fn command_v(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"pvV", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	if !o.has(b'v') && !o.has(b'V') {
		return done(0);
	}
	if o.has(b'V') {
		let mut status = i32::from(!o.rest.is_empty());
		for name in o.rest {
			if type_(ctx, &[BString::from("--"), name.clone()])?.status == 0 {
				status = 0;
			}
		}
		return done(status);
	}
	let mut out = Vec::new();
	let mut status = i32::from(!o.rest.is_empty());
	for name in o.rest {
		match kinds(ctx, name, false, false, o.has(b'p'))?
			.into_iter()
			.next()
		{
			Some(Kind::Alias(v)) => alias_line(name, &v, &mut out),
			Some(Kind::File(p) | Kind::Hashed(p)) => {
				out.extend_from_slice(&p);
				out.push(b'\n');
			},
			Some(_) => {
				out.extend_from_slice(name);
				out.push(b'\n');
			},
			None => continue,
		}
		status = 0;
	}
	ctx.out(&out);
	done(status)
}

/// `compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W
/// wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S
/// suffix] [-V varname] [word]`: the completions of `word`, one per line
/// (or into the array `varname`); status 1 when there are none.
///
/// Programmable completion is interactive; scripts use `compgen` for word
/// lists. Generated: the actions answerable from shell state (alias,
/// builtin, function, keyword, variable, shopt, setopt), then `-W`'s words
/// (split on `IFS`, without bash's expansions of the list), filtered by
/// `-X` (a leading `!` keeps the matches instead) and wrapped in `-P`/`-S`.
/// Actions that read the system (files, commands, users, jobs, …), `-G`,
/// `-F` and `-C` generate nothing, so those completions come back empty
/// instead of failing.
pub fn compgen(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"abcdefgjksuv", b"oAGWFCXPSV", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let prefix = o.rest.first().cloned().unwrap_or_default();
	let mut words: Vec<BString> = Vec::new();
	let mut actions: Vec<BString> = o
		.flags
		.iter()
		.filter(|&&(c, ..)| c == b'A')
		.filter_map(|(_, _, a)| a.clone())
		.collect();
	for (c, name) in [
		(b'a', "alias"),
		(b'b', "builtin"),
		(b'c', "command"),
		(b'd', "directory"),
		(b'e', "export"),
		(b'f', "file"),
		(b'g', "group"),
		(b'j', "job"),
		(b'k', "keyword"),
		(b's', "service"),
		(b'u', "user"),
		(b'v', "variable"),
	] {
		if o.has(c) {
			actions.push(name.into());
		}
	}
	for c in *b"FC" {
		if o.has(c) {
			let msg = format!("warning: -{} option may not work as you expect", char::from(c));
			ctx.err(Diag::Warning { msg: msg.into() });
		}
	}
	let dialect = ctx.vp.mode.dialect();
	for action in &actions {
		match action.as_slice() {
			b"function" => words.extend(all_functions(ctx)?.into_iter().map(|(n, ..)| n)),
			b"variable" => words.extend(
				state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::Var)?
					.into_iter()
					.filter_map(|(k, _)| match k {
						KeyBuf::Var(n) => Some(n),
						_ => None,
					}),
			),
			b"alias" => words.extend(all_aliases(ctx)?.into_iter().map(|(n, _)| n)),
			b"shopt" | b"setopt" => {
				use strum::IntoEnumIterator;
				let kind = if action.as_slice() == b"shopt" {
					OptKind::Shopt
				} else {
					OptKind::Set
				};
				let mut names: Vec<&'static str> = OptId::iter()
					.filter(|o| o.kind() == kind)
					.map(<&'static str>::from)
					.collect();
				names.sort_unstable();
				words.extend(names.into_iter().map(BString::from));
			},
			b"keyword" => words.extend(KEYWORDS.iter().map(|k| BString::from(*k))),
			b"builtin" => {
				use strum::IntoEnumIterator;
				for id in crate::bash::ids::IntrinsicId::iter().filter(|id| id.available_in(dialect)) {
					let name: &'static str = id.into();
					if super::misc::usable(ctx.k, ctx.cx.store, ctx.vp, name.as_bytes(), Some(id))?
						.is_some()
					{
						words.push(BString::from(name));
					}
				}
			},
			// Read from the system: nothing here.
			_ => {},
		}
	}
	if let Some(list) = o.arg(b'W') {
		let ifs = ctx
			.scalar(b"IFS")?
			.unwrap_or_else(|| BString::from(DEFAULT_IFS));
		words.extend(
			list
				.split(|c| ifs.contains(c))
				.filter(|w| !w.is_empty())
				.map(BString::from),
		);
	}
	words.retain(|w| w.starts_with(&prefix));
	if let Some(filter) = o.arg(b'X') {
		let (keep_matches, pattern) = match filter.strip_prefix(b"!") {
			Some(p) => (true, p),
			None => (false, filter.as_slice()),
		};
		let utf8 = locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
		let pattern = ctx
			.k
			.engine
			.patterns()
			.get(pattern, PatOpts::strmatch(utf8));
		words.retain(|w| pattern.matches(w) == keep_matches);
	}
	let (before, after) =
		(o.arg(b'P').cloned().unwrap_or_default(), o.arg(b'S').cloned().unwrap_or_default());
	let words: Vec<BString> = words
		.into_iter()
		.map(|w| {
			[before.as_slice(), w.as_slice(), after.as_slice()]
				.concat()
				.into()
		})
		.collect();
	let status = i32::from(words.is_empty());
	if let Some(name) = o.arg(b'V') {
		let items = words.into_iter().map(|w| (None, false, w)).collect();
		let lhs = Lhs { name, index: None, append: false };
		return done(if bind_lhs(ctx, lhs, AssignValue::Array(items)) {
			status
		} else {
			1
		});
	}
	let mut out = Vec::new();
	for w in &words {
		out.extend_from_slice(w);
		out.push(b'\n');
	}
	ctx.out(&out);
	done(status)
}

/// `complete [-abcdefgjksuv] [-pr] [-DEI] [-o option] [-A action] [-G
/// globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P
/// prefix] [-S suffix] [name …]`: define how `name`s complete. This shell
/// never runs programmable completion (an interactive feature), so valid
/// specifications are accepted and not kept: `complete -p` lists nothing.
pub fn complete(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	match opts(ctx, args, b"abcdefgjksuvprDEI", b"oAGWFCXPS", false) {
		Ok(_) => done(0),
		Err(st) => done(st),
	}
}

/// `compopt [-o|+o option] [-DEI] [name …]`: change completion options.
/// Without a name (or `-D`/`-E`/`-I`) it changes the completion being
/// generated, so outside a completion function it fails as bash's does;
/// named specifications are accepted ([`complete`] keeps none).
pub fn compopt(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"DEI", b"o", true) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	if o.rest.is_empty() && !b"DEI".iter().any(|&c| o.has(c)) {
		ctx.usage("not currently executing completion function");
		return done(1);
	}
	done(0)
}

/// The command hash table (`hash`, `BASH_CMDS`): `(name, path)` in bash's
/// listing order (its 256-bucket table; store order stands in for
/// insertion order, which only matters for colliding names).
pub fn hashed_commands(ctx: &mut Ctx<'_, '_>) -> Result<Vec<(BString, BString)>, Need> {
	let items: Vec<(BString, BString)> =
		state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::CmdHash)?
			.into_iter()
			.filter_map(|(k, r)| match (k, r) {
				(KeyBuf::CmdHash(n), Record::CmdHash { path, .. }) => Some((n, path)),
				_ => None,
			})
			.collect();
	Ok(state::hash_order(&items, state::CMD_HASH_BUCKETS)
		.into_iter()
		.cloned()
		.collect())
}

/// `hash [-lr] [-p path] [-dt] [name …]`: the command hash table, kept in
/// the state store (`Table::CmdHash`).
pub fn hash(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"rdlt", b"p", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	if o.has(b'd') && o.rest.is_empty() {
		ctx.usage("-d: option requires an argument");
		return done(1);
	}
	if !ctx.option(OptId::Hashall)? {
		ctx.usage("hashing disabled");
		return done(1);
	}
	let reusable = o.has(b'l');
	if o.has(b'r') {
		for (name, _) in hashed_commands(ctx)? {
			ctx.store_record(KeyBuf::CmdHash(name), None);
		}
	}
	let mut out = Vec::new();
	if o.rest.is_empty() {
		if o.has(b'r') || o.has(b'p') {
			return done(0);
		}
		let entries = hashed_commands(ctx)?;
		if entries.is_empty() {
			ctx.out(b"hash: hash table empty\n");
			return done(0);
		}
		if !reusable {
			out.extend_from_slice(b"hits\tcommand\n");
		}
		for (name, path) in entries {
			let hits = match ctx.record(Key::CmdHash(BStr::new(&name)))? {
				Some(Record::CmdHash { hits, .. }) => hits,
				_ => 0,
			};
			let line = if reusable {
				// bash's `print_portable_hash_info` quotes both names.
				let utf8 = locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
				let (p, n) = (
					quote::printable_filename(&path, utf8, true),
					quote::printable_filename(&name, utf8, true),
				);
				writeln!(out, "builtin hash -p {} {}", p.as_bstr(), n.as_bstr())
			} else {
				writeln!(out, "{hits:4}\t{}", path.as_bstr())
			};
			line.expect("writing to a Vec cannot fail");
		}
		ctx.out(&out);
		return done(0);
	}
	let mut status = 0;
	let given = o
		.flags
		.iter()
		.find_map(|(c, _, a)| (*c == b'p').then(|| a.clone()).flatten());
	if let Some(path) = given {
		let abs = absolute(&ctx.vp.cwd, &path);
		if let ProbeResult::Stat(Some(s)) = ctx.probe(Probe::Stat { path: abs, follow: true })?
			&& s.kind == crate::bash::fs::StatKind::Dir
		{
			ctx.err(Diag::IsADirectory { name: path });
			return done(1);
		}
		for name in o.rest {
			ctx.store_record(
				KeyBuf::CmdHash(name.clone()),
				Some(Record::CmdHash { path: path.clone(), hits: 0 }),
			);
		}
		return done(0);
	}
	let single = o.rest.len() == 1;
	for name in o.rest {
		let found = ctx.record(Key::CmdHash(BStr::new(name)))?;
		let found = match found {
			Some(Record::CmdHash { path, .. }) => Some(path),
			_ => None,
		};
		if o.has(b'd') {
			if found.is_some() {
				ctx.store_record(KeyBuf::CmdHash(name.clone()), None);
			} else {
				ctx.out(&std::mem::take(&mut out));
				ctx.err(Diag::NotFound { name: name.clone() });
				status = 1;
			}
			continue;
		}
		if o.has(b't') {
			match found {
				Some(p) if reusable => {
					writeln!(out, "builtin hash -p {} {}", p.as_bstr(), name.as_bstr())
						.expect("writing to a Vec cannot fail");
				},
				Some(p) if single => {
					out.extend_from_slice(&p);
					out.push(b'\n');
				},
				Some(p) => {
					writeln!(out, "{}\t{}", name.as_bstr(), p.as_bstr())
						.expect("writing to a Vec cannot fail");
				},
				None => {
					ctx.out(&std::mem::take(&mut out));
					ctx.err(Diag::NotFound { name: name.clone() });
					status = 1;
				},
			}
			continue;
		}
		if name.contains(&b'/') {
			continue;
		}
		let path = ctx.scalar(b"PATH")?.unwrap_or_default();
		if let ProbeResult::Path(Some(p)) = ctx.probe(Probe::Path { name: name.clone(), path })? {
			ctx.store_record(
				KeyBuf::CmdHash(name.clone()),
				Some(Record::CmdHash { path: p, hits: 0 }),
			);
		} else {
			ctx.out(&std::mem::take(&mut out));
			ctx.err(Diag::NotFound { name: name.clone() });
			status = 1;
		}
	}
	ctx.out(&out);
	done(status)
}
