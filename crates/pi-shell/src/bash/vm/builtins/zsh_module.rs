//! zsh's module system (`module.c`): the module table, autoloadable
//! features, `zmodload` and the gates the rest of the engine asks before a
//! module's builtin, condition, math function or parameter exists.
//!
//! Every module's code is compiled in; "loading" a module marks it loaded
//! and enables its features, exactly as zsh's tables record it, so
//! `zmodload` (all forms), `$modules`, autoloading on first use and
//! feature enables behave like zsh 5.9 built as on this host. A module the
//! engine does not provide fails to load with
//! [`Diag::ModuleUnavailable`]; a name no zsh build knows fails with
//! zsh's `dlopen` message.
//!
//! The tables live in the store under [`MiscKey::ZshModules`] (absent:
//! the tables zsh boots with, [`DEFAULT`]). Hash-table iteration orders
//! (`$modules`) are recomputed from creation order with zsh's `hasher`.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::LazyLock;

use bstr::{BString, ByteSlice};
use serde::{Deserialize, Serialize};

use super::{
	Ctx, Need, R, done,
	zsh_args::{Ops, ZPat, pattern_arg, zx},
	zsh_print::charset,
	zsh_quote::{Charset, niceformat, quotedzputs},
};
use crate::bash::{
	diag::Diag,
	ids::IntrinsicId,
	store::{Key, KeyBuf, MiscKey, Record, StateStore, StoreError},
	vm::{
		Cx, Kernel,
		expand::{Expander, X},
		proc::Vproc,
		state,
		zsh::{params, specials},
	},
};

/// Every module of zsh 5.9 as built on this host, one per line: the name,
/// then a flags word, then its features in zsh's order (`zmodload -lF`:
/// builtins, conditions (`c:` prefix, `C:` infix), math functions,
/// parameters). Flags: `+` the engine provides the module, `-` it does
/// not (loading fails with [`Diag::ModuleUnavailable`]); a trailing `!`
/// marks a module without features support (`zsh/main`, `zsh/newuser`).
///
/// A single string, not a table of slices: no dynamic relocations at
/// process start.
const TABLE: &str =
	"\
zsh/attr + b:zgetattr b:zsetattr b:zdelattr b:zlistattr
zsh/cap + b:cap b:getcap b:setcap
zsh/clone + b:clone
zsh/compctl + b:compcall b:compctl
zsh/complete + b:compadd b:compset c:after c:between c:prefix c:suffix
zsh/complist +
zsh/computil + b:comparguments b:compdescribe b:compfiles b:compgroups b:compquote b:comptags \
	 b:comptry b:compvalues
zsh/curses + b:zcurses p:zcurses_colors p:zcurses_attrs p:zcurses_keycodes p:zcurses_windows \
	 p:ZCURSES_COLORS p:ZCURSES_COLOR_PAIRS
zsh/datetime + b:strftime p:EPOCHSECONDS p:EPOCHREALTIME p:epochtime
zsh/deltochar +
zsh/example + b:example C:ex c:len f:length f:sum p:exarr p:exint p:exstr
zsh/files + b:chgrp b:chmod b:chown b:ln b:mkdir b:mv b:rm b:rmdir b:sync b:zf_chgrp b:zf_chmod \
	 b:zf_chown b:zf_ln b:zf_mkdir b:zf_mv b:zf_rm b:zf_rmdir b:zf_sync
zsh/langinfo + p:langinfo
zsh/main +!
zsh/mapfile + p:mapfile
zsh/mathfunc + f:abs f:acos f:acosh f:asin f:asinh f:atan f:atanh f:cbrt f:ceil f:copysign f:cos \
	 f:cosh f:erf f:erfc f:exp f:expm1 f:fabs f:float f:floor f:fmod f:gamma f:hypot f:ilogb f:int \
	 f:j0 f:j1 f:jn f:ldexp f:lgamma f:log f:log10 f:log1p f:log2 f:logb f:nextafter f:rand48 \
	 f:rint f:scalb f:signgam f:sin f:sinh f:sqrt f:tan f:tanh f:y0 f:y1 f:yn
zsh/nearcolor +
zsh/net/socket + b:zsocket
zsh/net/tcp + b:ztcp
zsh/newuser +!
zsh/param/private + b:private
zsh/parameter + p:aliases p:builtins p:commands p:dirstack p:dis_aliases p:dis_builtins \
	 p:dis_functions p:dis_functions_source p:dis_galiases p:dis_patchars p:dis_reswords \
	 p:dis_saliases p:funcfiletrace p:funcsourcetrace p:funcstack p:functions p:functions_source \
	 p:functrace p:galiases p:history p:historywords p:jobdirs p:jobstates p:jobtexts p:modules \
	 p:nameddirs p:options p:parameters p:patchars p:reswords p:saliases p:userdirs p:usergroups
zsh/pcre + b:pcre_compile b:pcre_match b:pcre_study C:pcre-match
zsh/regex + C:regex-match
zsh/rlimits + b:limit b:ulimit b:unlimit
zsh/sched + b:sched p:zsh_scheduled_events
zsh/stat + b:stat b:zstat
zsh/system + b:syserror b:sysread b:syswrite b:sysopen b:sysseek b:zsystem f:systell p:errnos \
	 p:sysparams
zsh/termcap + b:echotc p:termcap
zsh/terminfo + b:echoti p:terminfo
zsh/watch + b:log p:WATCH p:watch
zsh/zftp + b:zftp
zsh/zle + b:bindkey b:vared b:zle
zsh/zleparameter + p:keymaps p:widgets
zsh/zprof + b:zprof
zsh/zpty + b:zpty
zsh/zselect + b:zselect
zsh/zutil + b:zformat b:zparseopts b:zregexparse b:zstyle
";

/// zsh's own builtins (`builtin.c` `builtins[]`, without the
/// `ZSH_DEBUG`-only `hashinfo`, `mem`, `patdebug`) in the order zsh adds
/// them to `builtintab` at startup, space separated.
pub const CORE_BUILTINS: &str =
	"- builtin command exec noglob [ . : alias autoload bg break bye cd chdir continue declare \
	 dirs disable disown echo emulate enable eval exit export false fc fg float functions getln \
	 getopts hash history integer jobs kill let local logout popd print printf pushd pushln pwd r \
	 read readonly rehash return set setopt shift source suspend test ttyctl times trap true type \
	 typeset umask unalias unfunction unhash unset unsetopt wait whence where which zmodload \
	 zcompile";

/// What zsh registers at startup (`bltinmods.list`, generated from the
/// `load=yes` modules of `config.modules` in its order): per module its
/// autoloadable features (`autofeatures`, in `.mdd` order), then `>` and
/// its dependencies (`add_dep`).
const BOOT: &str = "\
zsh/rlimits b:limit b:ulimit b:unlimit
zsh/sched b:sched p:zsh_scheduled_events
zsh/param/private b:private
zsh/parameter p:parameters p:commands p:functions p:dis_functions p:functions_source \
                    p:dis_functions_source p:funcfiletrace p:funcsourcetrace p:funcstack \
                    p:functrace p:builtins p:dis_builtins p:reswords p:dis_reswords p:patchars \
                    p:dis_patchars p:options p:modules p:dirstack p:history p:historywords \
                    p:jobtexts p:jobdirs p:jobstates p:nameddirs p:userdirs p:usergroups \
                    p:aliases p:dis_aliases p:galiases p:dis_galiases p:saliases p:dis_saliases
zsh/termcap b:echotc p:termcap
zsh/terminfo b:echoti p:terminfo
zsh/watch b:log p:WATCH p:watch
zsh/zutil b:zformat b:zstyle b:zregexparse b:zparseopts > zsh/complete
zsh/compctl b:compctl b:compcall > zsh/complete zsh/zle
zsh/complete b:compadd b:compset c:prefix c:suffix c:between c:after > zsh/zle
zsh/complist > zsh/complete zsh/zle
zsh/computil b:compdescribe b:comparguments b:compvalues b:compquote b:comptags b:comptry \
                    b:compfiles b:compgroups > zsh/complete zsh/zle
zsh/zle b:bindkey b:vared b:zle
zsh/zleparameter p:widgets p:keymaps > zsh/zle
";

/// One module of [`TABLE`].
#[derive(Clone, Copy, Debug)]
pub struct ModDef {
	/// `zsh/…`.
	pub name:     &'static str,
	/// The engine provides it.
	pub provided: bool,
	/// It supports features (`features_` succeeds).
	pub features: bool,
	/// Its features, space separated, in zsh's order.
	list:         &'static str,
}

impl ModDef {
	/// The module's features (`b:name`, `c:name`, `C:name`, `f:name`,
	/// `p:name`) in zsh's order.
	pub fn features(&self) -> impl Iterator<Item = &'static str> + Clone {
		self.list.split(' ').filter(|f| !f.is_empty())
	}

	/// Index of `feature` in [`Self::features`].
	fn index(&self, feature: &[u8]) -> Option<usize> {
		self.features().position(|f| f.as_bytes() == feature)
	}
}

/// The modules of [`TABLE`], in name order.
pub fn defs() -> impl Iterator<Item = ModDef> {
	TABLE.lines().map(|line| {
		let (name, rest) = line.split_once(' ').unwrap_or((line, ""));
		let (flags, list) = rest.split_once(' ').unwrap_or((rest, ""));
		ModDef { name, provided: flags.starts_with('+'), features: !flags.ends_with('!'), list }
	})
}

/// The module named `name` in [`TABLE`].
pub fn def(name: &[u8]) -> Option<ModDef> {
	defs().find(|d| d.name.as_bytes() == name)
}

/// One node of zsh's `modulestab`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Node {
	name:      BString,
	/// `MOD_ALIAS`: the module this name stands for.
	alias:     Option<BString>,
	/// Loaded (`u.handle`/`u.linked` set).
	loaded:    bool,
	/// Per feature of the module's [`ModDef`], whether it is enabled.
	enables:   Vec<bool>,
	/// `deps`: modules loaded before this one.
	deps:      Option<Vec<BString>>,
	/// `autoloads`: features marked autoloadable, in lexical order.
	autoloads: Option<Vec<BString>>,
}

/// An autoload definition: a builtin stub, condition, math function or
/// parameter that loads `module` when used.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Auto {
	name:    BString,
	module:  BString,
	/// `FEAT_AUTOALL`: loading enables all of the module's features.
	autoall: bool,
	/// `CONDF_INFIX` (conditions).
	infix:   bool,
}

/// zsh's module tables.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tables {
	/// `modulestab`, in creation order.
	mods:     Vec<Node>,
	/// Autoloadable builtins (`builtintab` nodes without `BINF_ADDED`), in
	/// creation order.
	bins:     Vec<Auto>,
	/// Autoloadable conditions (`condtab`), newest first.
	conds:    Vec<Auto>,
	/// Autoloadable math functions (`mathfuncs`), newest first.
	mfuncs:   Vec<Auto>,
	/// Autoloadable parameters (`PM_AUTOLOAD`), in creation order.
	params:   Vec<Auto>,
	/// Module builtins in `builtintab` (autoload stubs and builtins a
	/// loaded module added), in the order their nodes were (re)created:
	/// with [`CORE_BUILTINS`] first, this gives `builtintab`'s iteration
	/// order (`$builtins`, `$modules`).
	bin_seq:  Vec<BString>,
	/// Module parameters `typeset +h` took `PM_HIDE` off; they get it back
	/// when the feature goes (a re-added parameter is a new one).
	unhidden: Vec<BString>,
	/// Module parameters `unset` made `PM_UNSET` (zsh's unset function
	/// keeps the special): set again by an assignment, gone with the
	/// feature.
	unset:    Vec<BString>,
	/// The shell parameters zsh `checkaddparam` finds blocking module
	/// parameters, set by the caller before features are enabled.
	#[serde(skip)]
	existing: Existing,
	/// The shell is a program's ([`crate::bash::Profile::Tool`]): the line
	/// editor's and the completion system's modules do not load
	/// ([`EDITOR_MODULES`]). Set by [`tables`] from the shell's record.
	#[serde(skip)]
	tool:     ToolShell,
}

/// The modules a [`crate::bash::Profile::Tool`] shell cannot load: the line
/// editor and the completion system.
const EDITOR_MODULES: [&str; 7] = [
	"zsh/zle",
	"zsh/zleparameter",
	"zsh/deltochar",
	"zsh/complete",
	"zsh/complist",
	"zsh/computil",
	"zsh/compctl",
];

/// Whether [`Tables`] belong to a tool shell. Like [`Existing`], a fact of
/// the shell the tables are read in, not of their state (never stored,
/// equal to any other).
#[derive(Clone, Copy, Debug, Default)]
struct ToolShell(bool);

impl PartialEq for ToolShell {
	fn eq(&self, _: &Self) -> bool {
		true
	}
}

impl Eq for ToolShell {}

/// Shell parameters named like module parameters: the name and whether
/// the visible one is local (zsh's `pm->level`). Taken from the shell's
/// variables for one operation: not part of the tables' state (never
/// stored, equal to any other).
#[derive(Clone, Debug, Default)]
struct Existing(Vec<(BString, bool)>);

impl PartialEq for Existing {
	fn eq(&self, _: &Self) -> bool {
		true
	}
}

impl Eq for Existing {}

/// A message zsh prints while working on the tables.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Msg {
	/// `zwarnnam(nam, …)`: prefixed with the command name.
	Nam(BString, String),
	/// `zwarn(…)`.
	Warn(String),
	/// `zerr(…)`: also aborts the command line.
	Err(String),
	/// A module the engine does not provide.
	Unavailable(BString),
}

/// `FEAT_IGNORE`.
const IGNORE: u8 = 1;
/// `FEAT_REMOVE`.
const REMOVE: u8 = 2;
/// `FEAT_AUTOALL`.
const AUTOALL: u8 = 4;
/// `FEAT_INFIX`.
const INFIX: u8 = 8;
/// `FEAT_CHECKAUTO`.
const CHECKAUTO: u8 = 16;

/// A feature to enable (`+x`/`x`) or disable (`-x`), a pattern with
/// `zmodload -m` (zsh `struct feature_enables`).
struct Fe {
	s:   BString,
	pat: Option<ZPat>,
}

impl Fe {
	fn plain(s: impl Into<BString>) -> Self {
		Self { s: s.into(), pat: None }
	}

	/// The feature text without its sign.
	fn bare(&self) -> &[u8] {
		match self.s.first() {
			Some(b'+' | b'-') => &self.s[1..],
			_ => self.s.as_slice(),
		}
	}

	fn matches(&self, feature: &str) -> bool {
		match &self.pat {
			Some(p) => p.matches(feature.as_bytes()),
			None => self.bare() == feature.as_bytes(),
		}
	}
}

/// zsh `hasher`.
fn hasher(key: &[u8]) -> u32 {
	key.iter()
		.fold(0u32, |h, &c| h.wrapping_add((h << 5).wrapping_add(u32::from(c))))
}

/// Iteration order of a zsh hash table (`newhashtable(size)`) holding
/// `keys`, given in creation order: buckets in order, each chain newest
/// first, the table growing fourfold whenever it holds twice its bucket
/// count (`expandhashtable`). Indexes into `keys`.
fn hash_order<'k>(keys: impl Iterator<Item = &'k [u8]>, size: usize) -> Vec<usize> {
	let mut hsize = size;
	let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); hsize];
	let keys: Vec<&[u8]> = keys.collect();
	let mut count = 0;
	for (i, k) in keys.iter().enumerate() {
		buckets[hasher(k) as usize % hsize].insert(0, i);
		count += 1;
		if count >= hsize * 2 {
			let old = std::mem::take(&mut buckets);
			hsize *= 4;
			buckets = vec![Vec::new(); hsize];
			for chain in old {
				for j in chain {
					buckets[hasher(keys[j]) as usize % hsize].insert(0, j);
				}
			}
		}
	}
	buckets.into_iter().flatten().collect()
}

/// zsh `modname_ok`: identifier characters and slashes, slashes only
/// after identifier characters... (`itype_end(p, IIDENT)` runs then `/`).
fn modname_ok(name: &[u8]) -> bool {
	let mut i = 0;
	loop {
		while name
			.get(i)
			.is_some_and(|&c| c.is_ascii_alphanumeric() || c == b'_' || c >= 0x80)
		{
			i += 1;
		}
		match name.get(i) {
			None => return true,
			Some(b'/') => i += 1,
			Some(_) => return false,
		}
	}
}

/// The tables zsh boots with: [`BOOT`]'s autoloads and dependencies, then
/// `zsh/main` loaded.
pub static DEFAULT: LazyLock<Tables> = LazyLock::new(|| {
	let mut t = Tables::default();
	let mut msgs = Vec::new();
	for line in BOOT.lines() {
		let (name, rest) = line.split_once(' ').unwrap_or((line, ""));
		let (feats, deps) = rest.split_once('>').unwrap_or((rest, ""));
		let feats: Vec<BString> = feats.split_whitespace().map(BString::from).collect();
		if !feats.is_empty() {
			t.autofeatures(&mut msgs, None, Some(name.as_bytes()), &feats, 0, 0);
		}
		for d in deps.split_whitespace() {
			t.add_dep(name.as_bytes(), d.as_bytes());
		}
	}
	t.load_module(&mut msgs, b"zsh/main", None, false);
	debug_assert!(msgs.is_empty(), "{msgs:?}");
	t
});

impl Tables {
	/// Whether module `name` (or the module it is an alias for) is loaded.
	pub fn module_loaded(&self, name: &[u8]) -> bool {
		self
			.find(name, true)
			.is_some_and(|(i, _)| self.is_loaded(i))
	}

	/// The node named `name`.
	fn node(&self, name: &[u8]) -> Option<usize> {
		self.mods.iter().position(|m| m.name == name)
	}

	/// zsh `find_module`: the node of `name`, through aliases with
	/// `aliasp`; also the final name.
	fn find(&self, name: &[u8], aliasp: bool) -> Option<(usize, BString)> {
		let mut name = BString::from(name);
		for _ in 0..64 {
			let i = self.node(&name)?;
			match &self.mods[i].alias {
				Some(a) if aliasp => name = a.clone(),
				_ => return Some((i, name)),
			}
		}
		None
	}

	/// The module `name` stands for: the end of its alias chain.
	fn resolve(&self, name: &[u8]) -> BString {
		let mut name = BString::from(name);
		for _ in 0..64 {
			match self.node(&name).and_then(|i| self.mods[i].alias.clone()) {
				Some(a) => name = a,
				None => break,
			}
		}
		name
	}

	/// zsh `find_module(…, FINDMOD_ALIASP | FINDMOD_CREATE, …)`.
	fn find_or_create(&mut self, name: &[u8]) -> usize {
		if let Some((i, _)) = self.find(name, true) {
			return i;
		}
		let name = self.resolve(name);
		self.mods.push(Node { name, ..Node::default() });
		self.mods.len() - 1
	}

	/// zsh `add_dep`.
	fn add_dep(&mut self, name: &[u8], from: &[u8]) {
		let i = self.find_or_create(name);
		let deps = self.mods[i].deps.get_or_insert_with(Vec::new);
		if !deps.iter().any(|d| d == from) {
			deps.push(from.into());
		}
	}

	/// Whether the node is a loaded module (`u.handle` set and not an
	/// alias).
	fn is_loaded(&self, i: usize) -> bool {
		self.mods[i].alias.is_none() && self.mods[i].loaded
	}

	/// The loaded module that has feature `feature` (`b:zstyle`, …)
	/// enabled.
	fn provider(&self, feature: &[u8]) -> Option<usize> {
		(0..self.mods.len()).find(|&i| {
			self.is_loaded(i)
				&& def(&self.mods[i].name).is_some_and(|d| {
					d.index(feature)
						.is_some_and(|f| self.mods[i].enables.get(f).copied().unwrap_or(false))
				})
		})
	}

	/// The autoload list for feature type `c`.
	const fn autos(&mut self, c: u8) -> &mut Vec<Auto> {
		match c {
			b'b' => &mut self.bins,
			b'c' | b'C' => &mut self.conds,
			b'f' => &mut self.mfuncs,
			_ => &mut self.params,
		}
	}

	/// The autoload definition of `name` for feature type `c`.
	fn auto(&self, c: u8, name: &[u8]) -> Option<&Auto> {
		let list = match c {
			b'b' => &self.bins,
			b'c' | b'C' => &self.conds,
			b'f' => &self.mfuncs,
			_ => &self.params,
		};
		list
			.iter()
			.find(|a| a.name == name && (!matches!(c, b'c' | b'C') || a.infix == (c == b'C')))
	}

	/// Remove the autoload definition of `name` for feature type `c`.
	fn remove_auto(&mut self, c: u8, name: &[u8]) -> bool {
		let infix = c == b'C';
		let cond = matches!(c, b'c' | b'C');
		let list = self.autos(c);
		if let Some(p) = list
			.iter()
			.position(|a| a.name == name && (!cond || a.infix == infix))
		{
			list.remove(p);
			if c == b'b' {
				self.bin_drop(name);
			}
			true
		} else {
			false
		}
	}

	/// A `builtintab` node for module builtin `name` is (re)created: it
	/// moves to the end of [`Self::bin_seq`].
	fn bin_touch(&mut self, name: &[u8]) {
		self.bin_drop(name);
		self.bin_seq.push(name.into());
	}

	/// The `builtintab` node of module builtin `name` is removed.
	fn bin_drop(&mut self, name: &[u8]) {
		self.bin_seq.retain(|n| n.as_slice() != name);
	}

	/// `builtintab`'s builtins in zsh's iteration order (its 85 buckets):
	/// zsh's own, then the module ones.
	pub fn builtin_order(&self) -> Vec<BString> {
		let names: Vec<&[u8]> = CORE_BUILTINS
			.split(' ')
			.map(str::as_bytes)
			.chain(self.bin_seq.iter().map(|n| n.as_slice()))
			.collect();
		hash_order(names.iter().copied(), 85)
			.into_iter()
			.map(|i| BString::from(names[i]))
			.collect()
	}

	/// zsh `add_autobin`/`add_autocond`/`add_automathfunc`/
	/// `add_autoparam`: 0, or 1 when it clashes with a real definition.
	fn add_auto(&mut self, c: u8, module: &[u8], name: &[u8], flags: u8) -> i32 {
		let feature = feature_name(c, name);
		if self.provider(&feature).is_some() {
			// A real builtin/condition/math function/parameter exists.
			return i32::from(flags & IGNORE == 0);
		}
		if c == b'b' && core_builtin(name) {
			return i32::from(flags & IGNORE == 0);
		}
		self.remove_auto(c, name);
		if c == b'b' {
			self.bin_touch(name);
		}
		let a = Auto {
			name:    name.into(),
			module:  module.into(),
			// zsh `add_automathfunc` drops `FEAT_AUTOALL` (its flags are 0).
			autoall: flags & AUTOALL != 0 && c != b'f',
			infix:   c == b'C',
		};
		match c {
			// Linked at the head of the list.
			b'c' | b'C' | b'f' => self.autos(c).insert(0, a),
			_ => self.autos(c).push(a),
		}
		0
	}

	/// zsh `del_autobin`/…: 0, 2 when there is none, 3 when it is a real
	/// one.
	fn del_auto(&mut self, c: u8, name: &[u8], flags: u8) -> i32 {
		if self.remove_auto(c, name) {
			return 0;
		}
		let real =
			self.provider(&feature_name(c, name)).is_some() || (c == b'b' && core_builtin(name));
		match (flags & IGNORE != 0, real) {
			(true, _) => 0,
			(false, true) => 3,
			(false, false) => 2,
		}
	}

	/// zsh `autofeatures`.
	fn autofeatures(
		&mut self,
		msgs: &mut Vec<Msg>,
		cmdnam: Option<&[u8]>,
		module: Option<&[u8]>,
		features: &[BString],
		prefchar: u8,
		defflags: u8,
	) -> i32 {
		let warn = |msgs: &mut Vec<Msg>, s: String| {
			msgs.push(match cmdnam {
				Some(n) => Msg::Nam(n.into(), s),
				None => Msg::Warn(s),
			});
		};
		let mut ret = 0;
		let defm = module.map(|m| self.find_or_create(m));
		// The module's features when it is loaded.
		let loaded_def = defm
			.filter(|&i| self.mods[i].loaded)
			.and_then(|i| def(&self.mods[i].name).map(|d| (i, d)));
		for f in features {
			let (add, fchar, fnam, feature): (bool, u8, &[u8], BString) = if prefchar != 0 {
				(true, prefchar, f.as_slice(), feature_name(prefchar, f))
			} else {
				let (add, feat) = match f.first() {
					Some(b'-') => (false, &f[1..]),
					Some(b'+') => (true, &f[1..]),
					_ => (true, f.as_slice()),
				};
				if feat.is_empty() || feat.get(1) != Some(&b':') {
					warn(msgs, format!("bad format for autoloadable feature: `{}'", feat.as_bstr()));
					ret = 1;
					continue;
				}
				(add, feat[0], &feat[2..], feat.into())
			};
			let add = add && defflags & REMOVE == 0;
			let mut flags = defflags;
			let typnam = match fchar {
				b'b' => "builtin",
				b'C' => {
					flags |= INFIX;
					"condition"
				},
				b'c' => "condition",
				b'f' => "math function",
				b'p' => "parameter",
				_ => {
					warn(msgs, format!("bad autoloadable feature type: `{}'", char::from(fchar)));
					ret = 1;
					continue;
				},
			};
			if fnam.contains(&b'/') {
				warn(msgs, format!("{}: `/' is illegal in a {typnam}", fnam.as_bstr()));
				ret = 1;
				continue;
			}
			let m = if let Some(m) = defm {
				m
			} else {
				// Traditional un-autoload syntax: find the module.
				let order = hash_order(self.mods.iter().map(|n| n.name.as_slice()), 17);
				let found = order.into_iter().find(|&i| {
					self.mods[i]
						.autoloads
						.as_ref()
						.is_some_and(|a| a.contains(&feature))
				});
				let Some(m) = found else {
					if flags & IGNORE == 0 {
						ret = 1;
						warn(msgs, format!("{}: no such {typnam}", fnam.as_bstr()));
					}
					continue;
				};
				m
			};
			let mut subret = 0;
			if add {
				if let Some((i, d)) = loaded_def {
					let Some(fi) = d.index(&feature) else {
						warn(
							msgs,
							format!(
								"module `{}' has no such feature: `{}'",
								self.mods[i].name,
								feature.as_bstr()
							),
						);
						ret = 1;
						continue;
					};
					if self.mods[i].enables.get(fi).copied().unwrap_or(false) {
						continue;
					}
				}
				let list = self.mods[m].autoloads.get_or_insert_with(Vec::new);
				if let Err(p) = list.binary_search_by(|x| x.as_slice().cmp(feature.as_slice())) {
					list.insert(p, feature);
				}
			} else if let Some(list) = self.mods[m].autoloads.as_mut() {
				if let Some(p) = list.iter().position(|x| *x == feature) {
					list.remove(p);
				} else {
					subret = if flags & IGNORE != 0 { -2 } else { 2 };
				}
			}
			if subret == 0 {
				let module_name = module.map_or_default(BString::from);
				subret = if add {
					self.add_auto(fchar, &module_name, fnam, flags)
				} else {
					self.del_auto(fchar, fnam, flags)
				};
			}
			if subret != 0 {
				if subret != -2 {
					ret = 1;
				}
				match subret {
					1 => warn(msgs, format!("failed to add {typnam} `{}'", fnam.as_bstr())),
					2 => warn(msgs, format!("{}: no such {typnam}", fnam.as_bstr())),
					3 => warn(msgs, format!("{}: {typnam} is already defined", fnam.as_bstr())),
					_ => {},
				}
			}
		}
		ret
	}

	/// Set the enables of loaded module `i` (zsh `enables_module` with an
	/// array: `setfeatureenables`): features turned on are added (their
	/// autoload definitions replaced), features turned off removed.
	fn set_enables(&mut self, msgs: &mut Vec<Msg>, i: usize, want: &[bool]) -> i32 {
		let Some(d) = def(&self.mods[i].name) else {
			return 0;
		};
		let mut ret = 0;
		let modname = self.mods[i].name.clone();
		for (fi, f) in d.features().enumerate() {
			let on = want.get(fi).copied().unwrap_or(false);
			let was = self.mods[i].enables.get(fi).copied().unwrap_or(false);
			if on == was {
				continue;
			}
			let (c, name) = (f.as_bytes()[0], &f.as_bytes()[2..]);
			if on {
				if self.provider(f.as_bytes()).is_some() || (c == b'b' && core_builtin(name)) {
					let what = match c {
						b'b' => "builtin",
						b'c' | b'C' => "condition",
						b'f' => "math function",
						_ => "parameter",
					};
					msgs.push(Msg::Nam(
						modname.clone(),
						format!("name clash when adding {what} `{}'", name.as_bstr()),
					));
					ret = 1;
					continue;
				}
				// zsh `addparamdef` → `checkaddparam`: a shell parameter of
				// the name stays; the feature stays off.
				if c == b'p'
					&& let Some(&(_, local)) = self.existing.0.iter().find(|(n, _)| n.as_slice() == name)
				{
					let why = if local {
						"local parameter exists"
					} else {
						"parameter already exists"
					};
					msgs.push(Msg::Warn(format!(
						"Can't add module parameter `{}': {why}",
						name.as_bstr()
					)));
					msgs.push(Msg::Nam(
						modname.clone(),
						format!("error when adding parameter `{}'", name.as_bstr()),
					));
					ret = 1;
					continue;
				}
				self.remove_auto(c, name);
			}
			if c == b'p' {
				self.unhidden.retain(|n| n.as_slice() != name);
				self.unset.retain(|n| n.as_slice() != name);
			}
			// zsh `addbuiltin` links a new node; `deletebuiltin` unlinks it.
			if c == b'b' {
				if on {
					self.bin_touch(name);
				} else {
					self.bin_drop(name);
				}
			}
			let e = &mut self.mods[i].enables;
			if e.len() <= fi {
				e.resize(fi + 1, false);
			}
			e[fi] = on;
		}
		ret
	}

	/// zsh `do_module_features`: 0, 1 on failure, 2 when the enables could
	/// not be applied.
	fn do_module_features(
		&mut self,
		msgs: &mut Vec<Msg>,
		i: usize,
		enables: Option<&mut Vec<Fe>>,
		flags: u8,
	) -> i32 {
		let Some(d) = def(&self.mods[i].name) else {
			return 0;
		};
		if !d.features {
			if enables.is_some() {
				if flags & IGNORE == 0 {
					msgs.push(Msg::Warn(format!(
						"module `{}' does not support features",
						self.mods[i].name
					)));
				}
				return 1;
			}
			return 0;
		}
		let mut ret = 0;
		let mut enables = enables;
		if flags & CHECKAUTO != 0
			&& let Some(autos) = self.mods[i].autoloads.clone()
		{
			for al in autos {
				if d.index(&al).is_some() {
					continue;
				}
				if flags & IGNORE == 0 {
					msgs.push(Msg::Warn(format!(
						"module `{}' has no such feature: `{}': autoload cancelled",
						self.mods[i].name,
						al.as_bstr()
					)));
				}
				let name = self.mods[i].name.clone();
				self.autofeatures(
					&mut Vec::new(),
					None,
					Some(&name),
					std::slice::from_ref(&al),
					0,
					IGNORE | REMOVE,
				);
				if let Some(list) = enables.as_deref_mut() {
					let before = list.len();
					let al_str = al.to_str_lossy();
					list.retain(|fe| !fe.matches(&al_str));
					if list.len() != before {
						ret = 1;
					}
				}
			}
		}
		let n = d.features().count();
		let mut want = self.mods[i].enables.clone();
		want.resize(n, false);
		if let Some(list) = enables {
			for fe in list.iter() {
				let on = fe.s.first() != Some(&b'-');
				let mut found = false;
				for (fi, f) in d.features().enumerate() {
					if fe.matches(f) {
						want[fi] = on;
						found = true;
						if fe.pat.is_none() {
							break;
						}
					}
				}
				if !found {
					if flags & IGNORE == 0 {
						let what = if fe.pat.is_some() {
							"has no feature matching"
						} else {
							"has no such feature"
						};
						msgs.push(Msg::Warn(format!(
							"module `{}' {what}: `{}'",
							self.mods[i].name,
							fe.bare().as_bstr()
						)));
					}
					return 1;
				}
			}
		} else {
			want = vec![true; n];
		}
		if self.set_enables(msgs, i, &want) != 0 {
			return 2;
		}
		ret
	}

	/// zsh `load_module`: 0, 1 on failure, 2 when some features could not
	/// be set.
	fn load_module(
		&mut self,
		msgs: &mut Vec<Msg>,
		name: &[u8],
		enables: Option<&mut Vec<Fe>>,
		silent: bool,
	) -> i32 {
		self.load_module_inner(msgs, name, enables, silent, &mut Vec::new())
	}

	fn load_module_inner(
		&mut self,
		msgs: &mut Vec<Msg>,
		name: &[u8],
		enables: Option<&mut Vec<Fe>>,
		silent: bool,
		busy: &mut Vec<BString>,
	) -> i32 {
		if !modname_ok(name) {
			if !silent {
				msgs.push(Msg::Err(format!("invalid module name `{}'", name.as_bstr())));
			}
			return 1;
		}
		let flags = if silent {
			IGNORE | CHECKAUTO
		} else {
			CHECKAUTO
		};
		let Some((i, name)) = self.find(name, true) else {
			// zsh `find_module` resolved aliases to the final name.
			let name = self.resolve(name);
			if !self.can_load(msgs, &name, silent) {
				return 1;
			}
			self
				.mods
				.push(Node { name: name.clone(), loaded: true, ..Node::default() });
			if !self.setup(msgs, &name) {
				if let Some(i) = self.node(&name) {
					self.mods.remove(i);
				}
				return 1;
			}
			let Some(i) = self.node(&name) else {
				return 1;
			};
			let r = self.do_module_features(msgs, i, enables, flags);
			if r == 1 {
				self.mods.remove(i);
				return 1;
			}
			return r;
		};
		if self.mods[i].loaded {
			return 0;
		}
		if busy.contains(&name) {
			msgs.push(Msg::Err(format!("circular dependencies for module ;{}", name.as_bstr())));
			return 1;
		}
		busy.push(name.clone());
		for d in self.mods[i].deps.clone().unwrap_or_default() {
			if self.load_module_inner(msgs, &d, None, silent, busy) == 1 {
				busy.pop();
				return 1;
			}
		}
		busy.pop();
		if !self.can_load(msgs, &name, silent) {
			return 1;
		}
		let Some(i) = self.node(&name) else {
			return 1;
		};
		self.mods[i].loaded = true;
		if !self.setup(msgs, &name) {
			if let Some(i) = self.node(&name) {
				self.mods[i].loaded = false;
			}
			return 1;
		}
		let Some(i) = self.node(&name) else {
			return 1;
		};
		let r = self.do_module_features(msgs, i, enables, flags);
		if r == 1 {
			// Cleanup: back to unloaded with every feature off.
			let n = self.mods[i].enables.len();
			self.set_enables(&mut Vec::new(), i, &vec![false; n]);
			self.mods[i].loaded = false;
			return 1;
		}
		r
	}

	/// A module's `setup_` loading other modules it needs (zsh/zftp's
	/// `require_module("zsh/net/tcp")`): `false` when one failed.
	fn setup(&mut self, msgs: &mut Vec<Msg>, name: &[u8]) -> bool {
		let requires: &[&str] = match name {
			b"zsh/zftp" => &["zsh/net/tcp"],
			_ => &[],
		};
		requires
			.iter()
			.all(|r| self.require_module(msgs, r.as_bytes(), None, false) != 1)
	}

	/// zsh `do_load_module`/`module_linked`: whether the module's code
	/// exists, with zsh's message when it does not.
	fn can_load(&self, msgs: &mut Vec<Msg>, name: &[u8], silent: bool) -> bool {
		let refused = self.tool.0 && EDITOR_MODULES.iter().any(|m| m.as_bytes() == name);
		match def(name) {
			Some(d) if d.provided && !refused => true,
			Some(_) => {
				if !silent {
					msgs.push(Msg::Unavailable(name.into()));
				}
				false
			},
			None => {
				if !silent {
					msgs.push(Msg::Warn(format!(
						"failed to load module `{}': {}",
						name.as_bstr(),
						dlopen_error(name)
					)));
				}
				false
			},
		}
	}

	/// zsh `require_module`.
	fn require_module(
		&mut self,
		msgs: &mut Vec<Msg>,
		module: &[u8],
		enables: Option<&mut Vec<Fe>>,
		silent: bool,
	) -> i32 {
		match self.find(module, true) {
			Some((i, _)) if self.mods[i].loaded => self.do_module_features(msgs, i, enables, 0),
			_ => self.load_module(msgs, module, enables, silent),
		}
	}

	/// zsh `ensurefeature`: load `module` with `prefix:feature` enabled,
	/// or all of its features when `feature` is `None`.
	fn ensurefeature(
		&mut self,
		msgs: &mut Vec<Msg>,
		module: &[u8],
		prefix: u8,
		feature: Option<&[u8]>,
	) -> i32 {
		match feature {
			None => self.require_module(msgs, module, None, false),
			Some(f) => {
				let mut fe = vec![Fe::plain(feature_name(prefix, f))];
				self.require_module(msgs, module, Some(&mut fe), false)
			},
		}
	}

	/// zsh `unload_module`.
	fn unload_module(&mut self, i: usize) -> i32 {
		let i = if let Some(a) = self.mods[i].alias.clone() {
			match self.find(&a, true) {
				Some((j, _)) => j,
				None => return 1,
			}
		} else {
			i
		};
		if self.mods[i].loaded {
			let n = self.mods[i].enables.len();
			self.set_enables(&mut Vec::new(), i, &vec![false; n]);
			self.mods[i].enables.clear();
			self.mods[i].loaded = false;
		}
		if let Some(autos) = self.mods[i].autoloads.clone().filter(|a| !a.is_empty()) {
			let name = self.mods[i].name.clone();
			self.autofeatures(&mut Vec::new(), Some(b"zsh"), Some(&name), &autos, 0, IGNORE);
		} else if self.mods[i].deps.is_none() {
			self.mods.remove(i);
		}
		0
	}

	/// zsh `unload_named_module`.
	fn unload_named_module(
		&mut self,
		msgs: &mut Vec<Msg>,
		name: &[u8],
		nam: &[u8],
		silent: bool,
	) -> i32 {
		let Some((i, mname)) = self.find(name, true) else {
			if !silent {
				msgs.push(Msg::Nam(nam.into(), format!("no such module {}", name.as_bstr())));
				return 1;
			}
			return 0;
		};
		let in_use = self
			.mods
			.iter()
			.any(|d| d.loaded && d.deps.as_ref().is_some_and(|deps| deps.contains(&mname)));
		if in_use {
			msgs.push(Msg::Nam(
				nam.into(),
				format!("module {mname} is in use by another module and cannot be unloaded"),
			));
			return 1;
		}
		self.unload_module(i)
	}

	/// The modules zsh lists for `$modules`, in its order, with their
	/// values (zsh `scanpmmodules`).
	fn modules_param(&self) -> Vec<(BString, BString)> {
		let mut out: Vec<(BString, BString)> = Vec::new();
		for i in hash_order(self.mods.iter().map(|m| m.name.as_slice()), 17) {
			let m = &self.mods[i];
			if let Some(a) = &m.alias {
				out.push((m.name.clone(), format!("alias:{a}").into()));
			} else if m.loaded {
				out.push((m.name.clone(), "loaded".into()));
			}
		}
		let push = |module: &BString, out: &mut Vec<(BString, BString)>| {
			if !out.iter().any(|(n, _)| n == module) {
				out.push((module.clone(), "autoloaded".into()));
			}
		};
		for name in self.builtin_order() {
			if let Some(a) = self.auto(b'b', &name) {
				push(&a.module, &mut out);
			}
		}
		for c in &self.conds {
			push(&c.module, &mut out);
		}
		for i in hash_order(self.params.iter().map(|a| a.name.as_slice()), 151) {
			push(&self.params[i].module, &mut out);
		}
		out
	}
}

/// `c:name`.
fn feature_name(c: u8, name: &[u8]) -> BString {
	let mut f = BString::from(vec![c, b':']);
	f.extend_from_slice(name);
	f
}

/// Whether `name` is one of zsh's own (`zsh/main`) builtins: an autoload
/// definition cannot replace it.
fn core_builtin(name: &[u8]) -> bool {
	IntrinsicId::from_name(name)
		.is_some_and(|id| id.available_in(crate::bash::ids::Dialect::Zsh) && module_of(id).is_none())
		&& super::zsh_args::builtin(std::str::from_utf8(name).unwrap_or("")).is_some()
}

/// The `dlopen` error zsh reports for a module no build provides.
fn dlopen_error(name: &[u8]) -> String {
	let path = format!("/usr/lib/zsh/5.9/{}.so", name.as_bstr());
	if cfg!(target_os = "macos") {
		format!(
			"dlopen({path}, 0x0009): tried: '{path}' (no such file), \
			 '/System/Volumes/Preboot/Cryptexes/OS{path}' (no such file), '{path}' (no such file, \
			 not in dyld cache)"
		)
	} else {
		format!("{path}: cannot open shared object file: No such file or directory")
	}
}

/// The module whose `b:` feature builtin `id` is, for the builtins that
/// belong to a module (`zsh/main`'s own are `None`).
pub const fn module_of(id: IntrinsicId) -> Option<&'static str> {
	use IntrinsicId as I;
	Some(match id {
		I::Zstyle | I::Zformat | I::Zparseopts | I::Zregexparse => "zsh/zutil",
		I::Strftime => "zsh/datetime",
		I::Echoti => "zsh/terminfo",
		I::Echotc => "zsh/termcap",
		I::PcreCompile | I::PcreStudy | I::PcreMatch => "zsh/pcre",
		I::Private => "zsh/param/private",
		I::Syserror | I::Sysread | I::Syswrite | I::Sysopen | I::Sysseek | I::Zsystem => "zsh/system",
		I::Zselect => "zsh/zselect",
		I::Zsocket => "zsh/net/socket",
		I::Ztcp => "zsh/net/tcp",
		I::Zftp => "zsh/zftp",
		I::Zpty => "zsh/zpty",
		I::Zcurses => "zsh/curses",
		I::ZshClone => "zsh/clone",
		I::Limit | I::Ulimit | I::Unlimit => "zsh/rlimits",
		I::Sched => "zsh/sched",
		I::Log => "zsh/watch",
		I::Zprof => "zsh/zprof",
		I::Example => "zsh/example",
		I::Cap | I::Getcap | I::Setcap => "zsh/cap",
		I::Chgrp
		| I::Chmod
		| I::Chown
		| I::Ln
		| I::Mkdir
		| I::Mv
		| I::Rm
		| I::Rmdir
		| I::Sync
		| I::ZfChgrp
		| I::ZfChmod
		| I::ZfChown
		| I::ZfLn
		| I::ZfMkdir
		| I::ZfMv
		| I::ZfRm
		| I::ZfRmdir
		| I::ZfSync => "zsh/files",
		I::Stat | I::Zstat => "zsh/stat",
		I::Zgetattr | I::Zsetattr | I::Zdelattr | I::Zlistattr => "zsh/attr",
		I::Bindkey | I::Vared | I::Zle => "zsh/zle",
		I::Compadd | I::Compset => "zsh/complete",
		I::Compctl | I::Compcall => "zsh/compctl",
		I::Comparguments
		| I::Compdescribe
		| I::Compfiles
		| I::Compgroups
		| I::Compquote
		| I::Comptags
		| I::Comptry
		| I::Compvalues => "zsh/computil",
		_ => return None,
	})
}

// ---- store access ------------------------------------------------------

/// The module tables as `vp` sees them.
///
/// # Errors
/// A store failure.
pub fn tables(store: &mut dyn StateStore, vp: &Vproc) -> Result<Tables, StoreError> {
	let mut t = match state::record(store, vp, Key::Misc(MiscKey::ZshModules))? {
		Some(Record::Misc(bytes)) => postcard::from_bytes(bytes).unwrap_or_else(|_| DEFAULT.clone()),
		_ => DEFAULT.clone(),
	};
	t.tool = ToolShell(crate::bash::vm::is_tool(store, vp)?);
	Ok(t)
}
/// Give `t`, for an operation that may add module parameters, the shell
/// parameters of their names that block them (zsh `checkaddparam`). A
/// parameter that is the special's own storage (zsh/watch's `WATCH`) does
/// not count.
///
/// # Errors
/// A store failure.
fn find_existing(
	t: &mut Tables,
	root: &state::Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<(), StoreError> {
	t.existing.0.clear();
	let in_function = state::scope_count(root, vp) > 0;
	for d in defs() {
		for f in d.features() {
			let Some(name) = f.strip_prefix("p:").map(str::as_bytes) else {
				continue;
			};
			if specials::lookup(name).is_some_and(|s| s.is_backed_by(name))
				|| state::lookup_declared(root, store, vp, name)?.is_none()
			{
				continue;
			}
			let local = in_function && state::binding_scope(root, store, vp, name)?.is_some();
			t.existing.0.push((BString::from(name), local));
		}
	}
	Ok(())
}

/// [`tables`] with [`find_existing`] done.
///
/// # Errors
/// A store failure.
fn tables_adding(
	root: &state::Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Tables, StoreError> {
	let mut t = tables(store, vp)?;
	find_existing(&mut t, root, store, vp)?;
	Ok(t)
}

/// Store the module tables (removing the record when they are the boot
/// tables).
fn save(k: &mut Kernel, store: &mut dyn StateStore, vp: &mut Vproc, t: &Tables) {
	let rec = (*t != *DEFAULT)
		.then(|| postcard::to_allocvec(t).ok())
		.flatten()
		.map(|b| Record::Misc(b.into()));
	state::store_record(&mut k.root, store, vp, KeyBuf::Misc(MiscKey::ZshModules), rec);
}

/// Emit `msgs` from a builtin: `true` when one was a `zerr`.
fn emit(ctx: &mut Ctx<'_, '_>, msgs: Vec<Msg>) -> bool {
	let mut err = false;
	for m in msgs {
		match m {
			Msg::Nam(n, s) => {
				if n.as_slice() == ctx.name.as_bytes() {
					ctx.usage(s);
				} else {
					ctx.diag(Diag::Usage { msg: s.into() }.by(n.to_string()));
				}
			},
			Msg::Warn(s) => ctx.diag(Diag::Warning { msg: s.into() }),
			Msg::Err(s) => {
				err = true;
				ctx.diag(Diag::Warning { msg: s.into() });
			},
			Msg::Unavailable(n) => ctx.diag(Diag::ModuleUnavailable { name: n }),
		}
	}
	err
}

/// Emit `msgs` from an expansion: `Err` for a `zerr`.
fn emit_ex(ex: &mut Expander<'_, '_>, msgs: Vec<Msg>) -> X<()> {
	let mut fail = None;
	for m in msgs {
		let d = match m {
			Msg::Nam(n, s) => Diag::Usage { msg: s.into() }.by(n.to_string()),
			Msg::Warn(s) => Diag::Warning { msg: s.into() },
			Msg::Err(s) => {
				fail = Some(Diag::Warning { msg: s.into() });
				continue;
			},
			Msg::Unavailable(n) => Diag::ModuleUnavailable { name: n },
		};
		ex.k.diag(ex.cx, ex.vp, ex.line, d);
	}
	match fail {
		Some(d) => Err(crate::bash::vm::expand::Stop::Fail(d)),
		None => Ok(()),
	}
}

// ---- module hooks ------------------------------------------------------

/// The modules loaded in `after` but not in `before` (booted), and the
/// other way round (finished), each in `modulestab` creation order.
fn transitions(before: &Tables, after: &Tables) -> (Vec<&'static str>, Vec<&'static str>) {
	let loaded = |t: &Tables| -> Vec<&'static str> {
		(0..t.mods.len())
			.filter(|&i| t.is_loaded(i))
			.filter_map(|i| def(&t.mods[i].name).map(|d| d.name))
			.collect()
	};
	let (b, a) = (loaded(before), loaded(after));
	(
		a.iter().filter(|m| !b.contains(m)).copied().collect(),
		b.iter().filter(|m| !a.contains(m)).copied().collect(),
	)
}

/// A module's `setup_`/`boot_` side effects beyond its features, run
/// after it was loaded from a builtin (`zmodload`, an autoloaded
/// builtin), before the tables are stored: a [`Need`] re-runs the whole
/// builtin from scratch, so a hook must be idempotent. It cannot push
/// frames.
fn boot_hook(ctx: &mut Ctx<'_, '_>, module: &'static str) -> Result<(), Need> {
	match module {
		"zsh/zftp" => super::zsh_mod_zftp::boot(ctx),
		"zsh/zprof" => {
			super::zsh_mod_zprof::boot(ctx);
			Ok(())
		},
		"zsh/example" => {
			super::zsh_mod_example::boot(ctx);
			Ok(())
		},
		"zsh/newuser" => super::zsh_mod_newuser::boot(ctx),
		// zsh/zle's `setup_` (keymaps, widgets, `zle_bracketed_paste`).
		"zsh/zle" => {
			crate::bash::vm::zle::zle_mut(ctx.k, ctx.cx, ctx.vp);
			Ok(())
		},
		"zsh/deltochar" => {
			crate::bash::vm::zle::deltochar::boot(ctx.k, ctx.cx, ctx.vp);
			Ok(())
		},
		// zsh/complist's `boot_` (`menu-select`, the `menuselect` and
		// `listscroll` keymaps; its hooks are found through `$modules`).
		"zsh/complist" => {
			crate::bash::vm::zle::comp::complist::boot(ctx.k, ctx.cx, ctx.vp);
			Ok(())
		},
		"zsh/terminfo" | "zsh/termcap" => {
			Ok(super::zsh_mod_terminfo::boot(&mut ctx.k.root, ctx.cx.store, ctx.vp)?)
		},
		"zsh/watch" => {
			if let Err(d) = super::zsh_args::zx(ctx, super::zsh_mod_watch::boot)? {
				ctx.diag(d);
			}
			Ok(())
		},
		_ => Ok(()),
	}
}

/// A module's `cleanup_`/`finish_` side effects, run after `zmodload -u`
/// unloaded it; `after` are the tables once the command is done.
fn finish_hook(ctx: &mut Ctx<'_, '_>, module: &'static str, after: &Tables) -> Result<(), Need> {
	match module {
		// `zdeleteterm`: ncurses drops the terminal once neither module
		// holds it.
		"zsh/terminfo" | "zsh/termcap" => {
			if !after.module_loaded(b"zsh/terminfo") && !after.module_loaded(b"zsh/termcap") {
				ctx.store_record(KeyBuf::Misc(MiscKey::ZshCurTerm), None);
			}
			Ok(())
		},
		"zsh/zftp" => super::zsh_mod_zftp::finish(ctx),
		"zsh/deltochar" => {
			crate::bash::vm::zle::deltochar::cleanup(ctx.vp);
			Ok(())
		},
		"zsh/complist" => {
			crate::bash::vm::zle::comp::complist::cleanup(ctx.vp);
			Ok(())
		},
		// The special goes with the module: a reload makes it afresh.
		"zsh/mapfile" => {
			ctx.store_record(KeyBuf::Misc(MiscKey::ZshMapfileUnset), None);
			Ok(())
		},
		"zsh/zpty" => {
			super::zsh_mod_zpty::delete_all(ctx);
			Ok(())
		},
		// zsh/curses `cleanup_`: the windows and color pairs go.
		"zsh/curses" => {
			if let Some(z) = ctx.vp.zsh.as_mut() {
				z.curses = None;
			}
			Ok(())
		},
		"zsh/zutil" => {
			super::zsh_mod_zutil::finish(ctx);
			Ok(())
		},
		"zsh/computil" => {
			crate::bash::vm::zle::comp::computil::finish(ctx);
			Ok(())
		},
		"zsh/compctl" => crate::bash::vm::zle::comp::compctl::finish(ctx),
		"zsh/zprof" => {
			super::zsh_mod_zprof::cleanup(ctx);
			Ok(())
		},
		"zsh/example" => {
			super::zsh_mod_example::finish(ctx);
			Ok(())
		},
		// zsh/net/tcp `cleanup_`: close every session.
		"zsh/net/tcp" => super::zsh_mod_tcp::cleanup(ctx),
		_ => Ok(()),
	}
}

/// [`boot_hook`] for a module an expansion autoloaded (a parameter, math
/// function or condition).
fn boot_hook_ex(ex: &mut Expander<'_, '_>, module: &'static str) -> X<()> {
	match module {
		"zsh/example" => {
			super::zsh_mod_example::boot_ex(ex);
			Ok(())
		},
		"zsh/watch" => super::zsh_mod_watch::boot(ex),
		"zsh/terminfo" | "zsh/termcap" => {
			Ok(super::zsh_mod_terminfo::boot(&mut ex.k.root, ex.cx.store, ex.vp)?)
		},
		_ => Ok(()),
	}
}

/// Run the hooks of the modules a builtin loaded or unloaded.
fn run_hooks(ctx: &mut Ctx<'_, '_>, before: &Tables, after: &Tables) -> Result<(), Need> {
	let (booted, finished) = transitions(before, after);
	for m in finished {
		finish_hook(ctx, m, after)?;
	}
	for m in booted {
		boot_hook(ctx, m)?;
	}
	Ok(())
}

/// Run the boot hooks of the modules an expansion loaded.
fn run_hooks_ex(ex: &mut Expander<'_, '_>, before: &Tables, after: &Tables) -> X<()> {
	for m in transitions(before, after).0 {
		boot_hook_ex(ex, m)?;
	}
	Ok(())
}

// ---- gates -------------------------------------------------------------

/// Whether builtin `id` exists now (a module's real builtin or its
/// autoload stub); builtins of no module always do. Command lookup calls
/// this ([`super::misc::usable`]).
///
/// # Errors
/// A store failure.
pub fn builtin_present(
	store: &mut dyn StateStore,
	vp: &Vproc,
	id: IntrinsicId,
	name: &[u8],
) -> Result<bool, StoreError> {
	if module_of(id).is_none() {
		return Ok(true);
	}
	let present =
		|t: &Tables| t.auto(b'b', name).is_some() || t.provider(&feature_name(b'b', name)).is_some();
	// Boot tables (nothing ever changed): no record to decode.
	if state::record(store, vp, Key::Misc(MiscKey::ZshModules))?.is_none() {
		return Ok(present(&DEFAULT));
	}
	Ok(present(&tables(store, vp)?))
}

/// The state of builtin `id` for listings (`$builtins`, `enable`,
/// `whence -m`): `None` when it does not exist now, `Some(false)` for an
/// autoload stub (`$builtins` says `undefined`), `Some(true)` otherwise.
///
/// # Errors
/// A store failure.
pub fn builtin_state(
	store: &mut dyn StateStore,
	vp: &Vproc,
	id: IntrinsicId,
) -> Result<Option<bool>, StoreError> {
	if module_of(id).is_none() {
		return Ok(Some(true));
	}
	let name: &'static str = id.into();
	let t = tables(store, vp)?;
	Ok(if t.provider(&feature_name(b'b', name.as_bytes())).is_some() {
		Some(true)
	} else if t.auto(b'b', name.as_bytes()).is_some() {
		Some(false)
	} else {
		None
	})
}

/// Before a module builtin runs (zsh `resolvebuiltin`): load its module if
/// it is an autoload stub. `false` after `autoloading module M failed to
/// define builtin: NAME` (status 1, the command line abandoned).
///
/// # Errors
/// A store failure.
pub fn resolve_builtin(ctx: &mut Ctx<'_, '_>, id: IntrinsicId) -> Result<bool, Need> {
	if module_of(id).is_none() {
		return Ok(true);
	}
	let name = ctx.name;
	resolve_named(ctx, name.as_bytes())
}

/// [`IntrinsicId::ModuleStub`]: the autoload stub `argv[0]` names a builtin
/// no module of the engine defines. zsh `resolvebuiltin` loads its module,
/// which fails to define it (`autoloading module M failed to define
/// builtin: NAME`, status 1, the command line abandoned).
///
/// # Errors
/// A store failure.
pub fn run_stub(ctx: &mut Ctx<'_, '_>, argv: &[BString]) -> R {
	let Some(name) = argv.first() else {
		return done(1);
	};
	if !resolve_named(ctx, name)? {
		return Ok(super::Outcome { status: 1, control: super::Control::DiscardAll });
	}
	// The module defined it after all: a builtin of the engine runs.
	if let Some(id) = IntrinsicId::lookup(name, ctx.vp.mode) {
		super::run(id, ctx, argv)
	} else {
		ctx.diag(Diag::CommandNotFound { name: name.clone() });
		done(127)
	}
}

/// Whether an autoload stub names builtin `name` (zsh's `builtintab`
/// node without `BINF_ADDED`): command lookup finds it before a command
/// of the path ([`super::misc::usable`]).
///
/// # Errors
/// A store failure.
pub fn builtin_stub(
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<bool, StoreError> {
	has_stub(store, vp, b'b', name)
}

/// Whether an autoload stub `c` (`b`, `p`) names `name`.
fn has_stub(
	store: &mut dyn StateStore,
	vp: &Vproc,
	c: u8,
	name: &[u8],
) -> Result<bool, StoreError> {
	let maybe = match state::record(store, vp, Key::Misc(MiscKey::ZshModules))? {
		None => return Ok(DEFAULT.auto(c, name).is_some()),
		// Every stub's name is in the record's bytes: most names are not.
		Some(Record::Misc(bytes)) => bytes.find(name).is_some(),
		Some(_) => true,
	};
	Ok(maybe && tables(store, vp)?.auto(c, name).is_some())
}

/// [`resolve_builtin`] for the builtin named `name`.
fn resolve_named(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<bool, Need> {
	let mut t = tables(ctx.cx.store, ctx.vp)?;
	let Some(stub) = t.auto(b'b', name).cloned() else {
		return Ok(true);
	};
	find_existing(&mut t, &ctx.k.root, ctx.cx.store, ctx.vp)?;
	let before = t.clone();
	let mut msgs = Vec::new();
	let feature = (!stub.autoall).then_some(name);
	t.ensurefeature(&mut msgs, &stub.module, b'b', feature);
	let ok = t.provider(&feature_name(b'b', name)).is_some();
	if !ok {
		t.remove_auto(b'b', name);
		msgs.push(Msg::Err(format!(
			"autoloading module {} failed to define builtin: {}",
			stub.module,
			name.as_bstr()
		)));
	}
	run_hooks(ctx, &before, &t)?;
	save(ctx.k, ctx.cx.store, ctx.vp, &t);
	emit(ctx, msgs);
	Ok(ok)
}

/// Whether module parameter `name` (feature `p:NAME` of a module) exists,
/// loading its module first when it is autoloadable (zsh's
/// `PM_AUTOLOAD` parameters, `loadparamnode`). Parameter lookup calls this
/// for the specials that belong to a module
/// ([`crate::bash::vm::zsh::specials::Special::module`]).
///
/// # Errors
/// A store failure; `autoloading module M failed to define parameter: N`.
pub fn param_present(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<bool> {
	Ok(param_state(ex, name)?.is_some())
}

/// The state of a present module parameter beyond its static flags.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ParamState {
	/// `typeset +h` took its `PM_HIDE` off: a local of its name then makes
	/// a local copy of the special rather than an ordinary parameter
	/// hiding it.
	pub unhidden: bool,
	/// `unset` made it `PM_UNSET` (the special stays; an assignment sets
	/// it again).
	pub unset:    bool,
}

/// [`param_present`] with the parameter's [`ParamState`].
///
/// # Errors
/// As [`param_present`].
pub fn param_state(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<ParamState>> {
	let feature = feature_name(b'p', name);
	let rec = state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshModules))?.is_some();
	if !rec && DEFAULT.provider(&feature).is_some() {
		return Ok(Some(ParamState::default()));
	}
	let mut t = tables(ex.cx.store, ex.vp)?;
	if t.provider(&feature).is_some() {
		let has = |l: &[BString]| l.iter().any(|n| n.as_slice() == name);
		return Ok(Some(ParamState { unhidden: has(&t.unhidden), unset: has(&t.unset) }));
	}
	let Some(stub) = t.auto(b'p', name).cloned() else {
		return Ok(None);
	};
	find_existing(&mut t, &ex.k.root, ex.cx.store, ex.vp)?;
	let before = t.clone();
	let mut msgs = Vec::new();
	t.remove_auto(b'p', name);
	t.ensurefeature(&mut msgs, &stub.module, b'p', (!stub.autoall).then_some(name));
	let ok = t.provider(&feature).is_some();
	if !ok {
		msgs.push(Msg::Err(format!(
			"autoloading module {} failed to define parameter: {}",
			stub.module,
			name.as_bstr()
		)));
	}
	run_hooks_ex(ex, &before, &t)?;
	save(ex.k, ex.cx.store, ex.vp, &t);
	emit_ex(ex, msgs)?;
	Ok(ok.then(ParamState::default))
}

/// Whether module parameter `name` exists, without autoloading (for
/// listings: zsh lists an autoloadable parameter by name too).
///
/// # Errors
/// A store failure.
pub fn param_listed(
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<bool, StoreError> {
	let t = tables(store, vp)?;
	Ok(t.provider(&feature_name(b'p', name)).is_some() || t.auto(b'p', name).is_some())
}

/// `typeset -h`/`+h` on module parameter `name`: set its `PM_HIDE` (on
/// the parameter, so until its feature goes).
///
/// # Errors
/// A store failure.
pub fn set_param_hidden(ex: &mut Expander<'_, '_>, name: &[u8], hide: bool) -> X<()> {
	let mut t = tables(ex.cx.store, ex.vp)?;
	if mark(&mut t.unhidden, name, !hide) {
		save(ex.k, ex.cx.store, ex.vp, &t);
	}
	Ok(())
}

/// `unset` of a present module parameter zsh's unset function keeps
/// (`stdunsetfn`: `PM_UNSET`, the special stays), or an assignment
/// setting it again (`unset == false`; zsh `createparam` clears
/// `PM_UNSET` of a special).
///
/// # Errors
/// A store failure.
pub fn set_param_unset(ex: &mut Expander<'_, '_>, name: &[u8], unset: bool) -> X<()> {
	// Assignments call this: most names are in no list (no record: boot
	// tables; not in the record's bytes; no module special).
	if !unset {
		match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshModules))? {
			Some(Record::Misc(bytes)) if bytes.find(name).is_some() => {},
			_ => return Ok(()),
		}
		if specials::lookup(name).is_none_or(|s| s.module().is_none()) {
			return Ok(());
		}
	}
	let mut t = tables(ex.cx.store, ex.vp)?;
	if mark(&mut t.unset, name, unset) {
		save(ex.k, ex.cx.store, ex.vp, &t);
	}
	Ok(())
}

/// zsh `unsetparam` reaching an autoloadable parameter (`gethashnode2`
/// does not load its module): the stub goes, the module stays unloaded.
/// `false` when no stub names `name` (or its module provides it).
///
/// # Errors
/// A store failure.
pub fn remove_param_stub(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<bool> {
	if !has_stub(ex.cx.store, ex.vp, b'p', name)? {
		return Ok(false);
	}
	let mut t = tables(ex.cx.store, ex.vp)?;
	if t.provider(&feature_name(b'p', name)).is_some() || !t.remove_auto(b'p', name) {
		return Ok(false);
	}
	save(ex.k, ex.cx.store, ex.vp, &t);
	Ok(true)
}

/// Whether an autoload stub names parameter `name` (for a name that is
/// no special: a stub of a feature no module of the engine defines).
///
/// # Errors
/// A store failure.
pub fn param_stub(store: &mut dyn StateStore, vp: &Vproc, name: &[u8]) -> Result<bool, StoreError> {
	has_stub(store, vp, b'p', name)
}

/// Put `name` in `list` (`on`) or take it out: `true` when that changed
/// the list.
fn mark(list: &mut Vec<BString>, name: &[u8], on: bool) -> bool {
	let was = list.iter().any(|n| n.as_slice() == name);
	if was == on {
		return false;
	}
	if on {
		list.push(BString::from(name));
	} else {
		list.retain(|n| n.as_slice() != name);
	}
	true
}

/// The module providing condition `-name` (infix with `infix`), loading
/// it first when the condition is autoloadable (zsh `getconddef(…, 1)`):
/// `None` when no such condition exists.
///
/// # Errors
/// A store failure; a failed autoload.
pub fn cond_module(ex: &mut Expander<'_, '_>, name: &[u8], infix: bool) -> X<Option<&'static str>> {
	let c = if infix { b'C' } else { b'c' };
	let feature = feature_name(c, name);
	let mut t = tables(ex.cx.store, ex.vp)?;
	if let Some(i) = t.provider(&feature) {
		return Ok(def(&t.mods[i].name).map(|d| d.name));
	}
	let Some(stub) = t.auto(c, name).cloned() else {
		return Ok(None);
	};
	find_existing(&mut t, &ex.k.root, ex.cx.store, ex.vp)?;
	let before = t.clone();
	let mut msgs = Vec::new();
	t.ensurefeature(&mut msgs, &stub.module, c, (!stub.autoall).then_some(name));
	let found = t.provider(&feature);
	if found.is_none() {
		t.remove_auto(c, name);
	}
	let module = found.and_then(|i| def(&t.mods[i].name)).map(|d| d.name);
	run_hooks_ex(ex, &before, &t)?;
	save(ex.k, ex.cx.store, ex.vp, &t);
	emit_ex(ex, msgs)?;
	Ok(module)
}

/// zsh `ensurefeature(module, "P:", feature)` from an expansion: load
/// `module` (if needed) with feature `prefix:feature` enabled, as `[[ =~ ]]`
/// does for zsh/regex's `C:regex-match` or zsh/pcre's `C:pcre-match`.
///
/// # Errors
/// A store failure; a failed load (`zerr`).
pub fn ensure_feature_ex(
	ex: &mut Expander<'_, '_>,
	module: &[u8],
	prefix: u8,
	feature: &[u8],
) -> X<()> {
	let mut t = tables_adding(&ex.k.root, ex.cx.store, ex.vp)?;
	let before = t.clone();
	let mut msgs = Vec::new();
	t.ensurefeature(&mut msgs, module, prefix, Some(feature));
	run_hooks_ex(ex, &before, &t)?;
	save(ex.k, ex.cx.store, ex.vp, &t);
	emit_ex(ex, msgs)
}

/// The module providing math function `name`, loading it first when the
/// function is autoloadable (zsh `getmathfunc(…, 1)`): `None` when no
/// such function exists.
///
/// # Errors
/// A store failure; `autoloading module M failed to define math function`.
pub fn math_module(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<&'static str>> {
	let feature = feature_name(b'f', name);
	let rec = state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshModules))?.is_some();
	if !rec {
		// Boot tables: no module with math functions is loaded.
		return Ok(None);
	}
	let mut t = tables(ex.cx.store, ex.vp)?;
	if let Some(i) = t.provider(&feature) {
		return Ok(def(&t.mods[i].name).map(|d| d.name));
	}
	let Some(stub) = t.auto(b'f', name).cloned() else {
		return Ok(None);
	};
	find_existing(&mut t, &ex.k.root, ex.cx.store, ex.vp)?;
	let before = t.clone();
	let mut msgs = Vec::new();
	t.remove_auto(b'f', name);
	t.ensurefeature(&mut msgs, &stub.module, b'f', (!stub.autoall).then_some(name));
	let found = t.provider(&feature);
	if found.is_none() {
		msgs.push(Msg::Err(format!(
			"autoloading module {} failed to define math function: {}",
			stub.module,
			name.as_bstr()
		)));
	}
	let module = found.and_then(|i| def(&t.mods[i].name)).map(|d| d.name);
	run_hooks_ex(ex, &before, &t)?;
	save(ex.k, ex.cx.store, ex.vp, &t);
	emit_ex(ex, msgs)?;
	Ok(module)
}

/// The definition of math function `name` of `module` (as
/// [`math_module`] named it).
pub fn math_def(module: &str, name: &[u8]) -> Option<crate::bash::vm::zsh::math::MathFunc> {
	match module {
		"zsh/mathfunc" => super::zsh_mod_mathfunc::def(name),
		"zsh/system" => super::zsh_mod_system::math_def(name),
		"zsh/example" => super::zsh_mod_example::math_def(name),
		_ => None,
	}
}

/// Call math function `name` of `module` (zsh's module `mathfunc`
/// handlers).
///
/// # Errors
/// The function's math error.
pub fn call_math(
	ex: &mut Expander<'_, '_>,
	module: &str,
	name: &[u8],
	args: crate::bash::vm::zsh::math::FuncArgs<'_>,
) -> X<crate::bash::vm::zsh::math::Number> {
	match module {
		"zsh/mathfunc" => super::zsh_mod_mathfunc::call(ex, name, args),
		"zsh/system" => super::zsh_mod_system::math_call(ex, name, args),
		"zsh/example" => super::zsh_mod_example::call_math(name, args),
		_ => Err(crate::bash::vm::expand::Stop::Fail(Diag::BadMathExpr {
			msg: format!("unknown function: {}", name.as_bstr()).into(),
		})),
	}
}

/// Whether module `name` is loaded (zsh `module_loaded`), for modules
/// whose effect is not a feature (`zsh/nearcolor`).
///
/// # Errors
/// A store failure.
pub fn loaded(store: &mut dyn StateStore, vp: &Vproc, name: &[u8]) -> Result<bool, StoreError> {
	let t = tables(store, vp)?;
	Ok(t.find(name, true).is_some_and(|(i, _)| t.is_loaded(i)))
}

/// `$modules` (zsh `scanpmmodules`): every module loaded, aliased or
/// autoloadable, in zsh's order.
///
/// # Errors
/// A store failure.
pub fn modules_param(
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Vec<(BString, BString)>, StoreError> {
	Ok(tables(store, vp)?.modules_param())
}

/// `$builtins` (zsh `scanpmbuiltins`): every builtin in `builtintab`'s
/// order, `defined`, or `undefined` for an autoload stub. Builtins the
/// engine adds beyond zsh's table follow, sorted.
///
/// # Errors
/// A store failure.
pub fn builtins_param(
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Vec<(BString, BString)>, StoreError> {
	use strum::IntoEnumIterator;
	let t = tables(store, vp)?;
	let zsh = |id: &IntrinsicId| id.available_in(crate::bash::ids::Dialect::Zsh);
	let state = |name: &[u8]| -> Option<bool> {
		if matches!(name, b"-" | b"noglob") {
			return Some(true);
		}
		let id = IntrinsicId::from_name(name).filter(zsh)?;
		if module_of(id).is_none() {
			return Some(true);
		}
		if t.provider(&feature_name(b'b', name)).is_some() {
			Some(true)
		} else {
			t.auto(b'b', name).map(|_| false)
		}
	};
	let value = |defined: bool| BString::from(if defined { "defined" } else { "undefined" });
	let order = t.builtin_order();
	let mut out: Vec<(BString, BString)> = Vec::new();
	for name in &order {
		if let Some(defined) = state(name.as_slice()) {
			out.push((name.clone(), value(defined)));
		}
	}
	let mut extra: Vec<&'static str> = IntrinsicId::iter()
		.filter(zsh)
		.map(<&'static str>::from)
		.filter(|n| !order.iter().any(|o| o.as_slice() == n.as_bytes()))
		.filter(|n| state(n.as_bytes()).is_some())
		.collect();
	extra.sort_unstable();
	for n in extra {
		let defined = state(n.as_bytes()).unwrap_or(true);
		out.push((BString::from(n), value(defined)));
	}
	Ok(out)
}

/// Mark module `name` loaded with all its features (zsh/parameter when
/// one of its parameters is used, …) from host code that has no builtin
/// context.
pub fn ensure_loaded(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	name: &[u8],
) -> Result<(), StoreError> {
	let mut t = tables_adding(&k.root, cx.store, vp)?;
	t.require_module(&mut Vec::new(), name, None, true);
	save(k, cx.store, vp, &t);
	Ok(())
}

// ---- zmodload ------------------------------------------------------------

/// The `quotedzputs` of `s` for listings.
fn q(s: &[u8], cs: Charset) -> Vec<u8> {
	quotedzputs(s, false, cs)
}

/// `zmodload` (zsh `bin_zmodload`).
pub fn zmodload(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let o = |c| ops.isset(c);
	let ops_bcpf = o(b'b') || o(b'c') || o(b'p') || o(b'f');
	let ops_au = o(b'a') || o(b'u');
	if ops_bcpf && !ops_au {
		ctx.usage("-b, -c, -f, and -p must be combined with -a or -u");
		return done(1);
	}
	if o(b'F') && (ops_bcpf || o(b'u')) {
		ctx.usage("-b, -c, -f, -p and -u cannot be combined with -F");
		return done(1);
	}
	if o(b'A') || o(b'R') {
		if ops_bcpf || ops_au || o(b'd') || (o(b'R') && o(b'e')) {
			ctx.usage("illegal flags combined with -A or -R");
			return done(1);
		}
		if !o(b'e') {
			return zmodload_alias(ctx, ops, args);
		}
	}
	if o(b'd') && o(b'a') {
		ctx.usage("-d cannot be combined with -a");
		return done(1);
	}
	if o(b'u') && args.is_empty() {
		ctx.usage("what do you want to unload?");
		return done(1);
	}
	if o(b'e') && (o(b'I') || o(b'L') || (o(b'a') && !o(b'F')) || o(b'd') || o(b'i') || o(b'u')) {
		ctx.usage("-e cannot be combined with other options");
		return done(1);
	}
	for c in *b"lP" {
		if o(c) && !o(b'F') {
			ctx.usage(format!("-{} is only allowed with -F", char::from(c)));
			return done(1);
		}
	}
	let cs = charset(ctx)?;
	let mut t = tables_adding(&ctx.k.root, ctx.cx.store, ctx.vp)?;
	let before = t.clone();
	let mut msgs = Vec::new();
	let mut out = Vec::new();
	let ret = if o(b'F') {
		zmodload_features(ctx, &mut t, &mut msgs, &mut out, ops, args, cs)?
	} else if o(b'e') {
		zmodload_exist(&t, &mut out, ops, args, cs)
	} else if o(b'd') {
		zmodload_dep(&mut t, &mut out, ops, args, cs)
	} else if ops_bcpf || o(b'a') {
		if u8::from(o(b'b')) + u8::from(o(b'c')) + u8::from(o(b'p')) + u8::from(o(b'f')) > 1 {
			msgs.push(Msg::Nam(ctx.name.into(), "use only one of -b, -c, or -p".into()));
			1
		} else {
			zmodload_auto(&mut t, &mut msgs, &mut out, ctx.name.as_bytes(), ops, args, cs)
		}
	} else {
		zmodload_load(&mut t, &mut msgs, &mut out, ctx.name.as_bytes(), ops, args, cs)
	};
	run_hooks(ctx, &before, &t)?;
	ctx.out(&out);
	if t != before {
		save(ctx.k, ctx.cx.store, ctx.vp, &t);
	}
	let failed = emit(ctx, msgs);
	if failed {
		// zsh `zerr`: the rest of the command line is abandoned.
		return Ok(super::Outcome { status: 1, control: super::Control::DiscardAll });
	}
	done(ret)
}

/// zsh `printmodulenode` flags.
const PM_LIST: u8 = 1;
const PM_EXIST: u8 = 2;
const PM_ALIAS: u8 = 4;
const PM_DEPS: u8 = 8;
const PM_FEATURES: u8 = 16;
const PM_LISTALL: u8 = 32;
const PM_AUTO: u8 = 64;

/// zsh `printmodulenode`.
fn print_node(t: &Tables, i: usize, flags: u8, cs: Charset, out: &mut Vec<u8>) {
	let m = &t.mods[i];
	let modname = m.name.as_slice();
	let dash = |out: &mut Vec<u8>| {
		if modname.first() == Some(&b'-') {
			out.extend_from_slice(b"-- ");
		}
	};
	if flags & PM_DEPS != 0 {
		let Some(deps) = &m.deps else {
			return;
		};
		if flags & PM_LIST != 0 {
			out.extend_from_slice(b"zmodload -d ");
			dash(out);
			out.extend_from_slice(&q(modname, cs));
		} else {
			out.extend_from_slice(&niceformat(modname, false, cs));
			out.push(b':');
		}
		for d in deps {
			out.push(b' ');
			if flags & PM_LIST != 0 {
				out.extend_from_slice(&q(d, cs));
			} else {
				out.extend_from_slice(&niceformat(d, false, cs));
			}
		}
	} else if flags & PM_EXIST != 0 {
		if let Some(a) = &m.alias {
			if flags & PM_ALIAS == 0 {
				return;
			}
			match t.find(a, true) {
				Some((j, _)) if t.mods[j].loaded => {},
				_ => return,
			}
		} else if !m.loaded {
			return;
		}
		out.extend_from_slice(&niceformat(modname, false, cs));
	} else if let Some(a) = &m.alias {
		if flags & PM_LIST != 0 {
			out.extend_from_slice(b"zmodload -A ");
			dash(out);
			out.extend_from_slice(&q(modname, cs));
			out.push(b'=');
			out.extend_from_slice(&q(a, cs));
		} else {
			out.extend_from_slice(&niceformat(modname, false, cs));
			out.extend_from_slice(b" -> ");
			out.extend_from_slice(&niceformat(a, false, cs));
		}
	} else if m.loaded || flags & PM_AUTO != 0 {
		if flags & PM_LIST != 0 {
			let mut features = None;
			if flags & PM_AUTO != 0 {
				if m.autoloads.as_ref().is_none_or(Vec::is_empty) {
					return;
				}
			} else if flags & PM_FEATURES != 0 {
				match def(modname) {
					Some(d) if d.features && d.features().next().is_some() => features = Some(d),
					_ => return,
				}
			}
			out.extend_from_slice(b"zmodload ");
			if flags & PM_AUTO != 0 {
				out.extend_from_slice(b"-Fa ");
			} else if features.is_some() {
				out.extend_from_slice(b"-F ");
			}
			dash(out);
			out.extend_from_slice(&q(modname, cs));
			if flags & PM_AUTO != 0 {
				for a in m.autoloads.iter().flatten() {
					out.push(b' ');
					out.extend_from_slice(&q(a, cs));
				}
			} else if let Some(d) = features {
				for (fi, f) in d.features().enumerate() {
					let on = m.enables.get(fi).copied().unwrap_or(false);
					if flags & PM_LISTALL != 0 {
						out.extend_from_slice(if on { b" +" } else { b" -" });
					} else if !on {
						continue;
					} else {
						out.push(b' ');
					}
					out.extend_from_slice(&q(f.as_bytes(), cs));
				}
			}
		} else {
			out.extend_from_slice(&niceformat(modname, false, cs));
		}
	} else {
		return;
	}
	out.push(b'\n');
}

/// zsh `scanhashtable(modulestab, 1, flags1, flags2, printmodulenode,
/// flags)`: sorted by name; `only_alias` keeps only aliases (`MOD_ALIAS`
/// in `flags1`), `skip_alias` drops them.
fn print_all(
	t: &Tables,
	flags: u8,
	only_alias: bool,
	skip_alias: bool,
	cs: Charset,
	out: &mut Vec<u8>,
) {
	let mut idx: Vec<usize> = (0..t.mods.len()).collect();
	idx.sort_by(|&a, &b| t.mods[a].name.cmp(&t.mods[b].name));
	for i in idx {
		let alias = t.mods[i].alias.is_some();
		if (only_alias && !alias) || (skip_alias && alias) {
			continue;
		}
		print_node(t, i, flags, cs, out);
	}
}

/// `zmodload -A`/`-R` (zsh `bin_zmodload_alias`).
fn zmodload_alias(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let cs = charset(ctx)?;
	let mut t = tables(ctx.cx.store, ctx.vp)?;
	let flags = if ops.isset(b'L') { PM_LIST } else { 0 };
	if args.is_empty() {
		if ops.isset(b'R') {
			ctx.usage("no module alias to remove");
			return done(1);
		}
		let mut out = Vec::new();
		print_all(&t, flags, true, false, cs, &mut out);
		ctx.out(&out);
		return done(0);
	}
	let mut out = Vec::new();
	let mut ret = 0;
	for a in args {
		let (name, target) = match a.find_byte(b'=') {
			Some(p) => (&a[..p], Some(&a[p + 1..])),
			None => (a.as_slice(), None),
		};
		if !modname_ok(name) {
			ctx.usage(format!("invalid module name `{}'", name.as_bstr()));
			ret = 1;
			break;
		}
		if ops.isset(b'R') {
			if target.is_some() {
				ctx.usage(format!("bad syntax for removing module alias: {}", name.as_bstr()));
				ret = 1;
				break;
			}
			match t.node(name) {
				Some(i) if t.mods[i].alias.is_some() => {
					t.mods.remove(i);
				},
				Some(_) => {
					ctx.usage(format!("module is not an alias: {}", name.as_bstr()));
					ret = 1;
					break;
				},
				None => {
					ctx.usage(format!("no such module alias: {}", name.as_bstr()));
					ret = 1;
					break;
				},
			}
		} else if let Some(target) = target {
			if !modname_ok(target) {
				ctx.usage(format!("invalid module name `{}'", target.as_bstr()));
				ret = 1;
				break;
			}
			let mut mname = BString::from(target);
			let mut cyclic = false;
			for _ in 0..64 {
				if mname == name {
					cyclic = true;
					break;
				}
				match t.node(&mname).and_then(|i| t.mods[i].alias.clone()) {
					Some(next) => mname = next,
					None => break,
				}
			}
			if cyclic {
				ctx.usage(format!("module alias would refer to itself: {}", name.as_bstr()));
				ret = 1;
				break;
			}
			match t.node(name) {
				Some(i) if t.mods[i].alias.is_some() => t.mods[i].alias = Some(target.into()),
				Some(_) => {
					ctx.usage(format!("module is not an alias: {}", name.as_bstr()));
					ret = 1;
					break;
				},
				None => t.mods.push(Node {
					name: name.into(),
					alias: Some(target.into()),
					..Node::default()
				}),
			}
		} else {
			match t.node(name) {
				Some(i) if t.mods[i].alias.is_some() => print_node(&t, i, flags, cs, &mut out),
				Some(_) => {
					ctx.usage(format!("module is not an alias: {}", name.as_bstr()));
					ret = 1;
					break;
				},
				None => {
					ctx.usage(format!("no such module alias: {}", name.as_bstr()));
					ret = 1;
					break;
				},
			}
		}
	}
	ctx.out(&out);
	save(ctx.k, ctx.cx.store, ctx.vp, &t);
	done(ret)
}

/// `zmodload -e` (zsh `bin_zmodload_exist`).
fn zmodload_exist(t: &Tables, out: &mut Vec<u8>, ops: &Ops, args: &[BString], cs: Charset) -> i32 {
	if args.is_empty() {
		let flags = if ops.isset(b'A') {
			PM_EXIST | PM_ALIAS
		} else {
			PM_EXIST
		};
		print_all(t, flags, false, false, cs, out);
		return 0;
	}
	let all = args
		.iter()
		.all(|a| t.find(a, true).is_some_and(|(i, _)| t.is_loaded(i)));
	i32::from(!all)
}

/// `zmodload -d` (zsh `bin_zmodload_dep`).
fn zmodload_dep(
	t: &mut Tables,
	out: &mut Vec<u8>,
	ops: &Ops,
	args: &[BString],
	cs: Charset,
) -> i32 {
	if ops.isset(b'u') {
		let Some((i, _)) = t.find(&args[0], true) else {
			return 0;
		};
		if args.len() > 1 {
			if let Some(deps) = t.mods[i].deps.as_mut() {
				for a in &args[1..] {
					if let Some(p) = deps.iter().position(|d| d == a) {
						deps.remove(p);
					}
				}
				if deps.is_empty() {
					t.mods[i].deps = None;
				}
			}
		} else {
			t.mods[i].deps = None;
		}
		if t.mods[i].deps.is_none() && !t.mods[i].loaded && t.mods[i].alias.is_none() {
			t.mods.remove(i);
		}
		return 0;
	}
	if args.len() < 2 {
		let flags = if ops.isset(b'L') {
			PM_DEPS | PM_LIST
		} else {
			PM_DEPS
		};
		if let Some(a) = args.first() {
			if let Some(i) = t.node(a) {
				print_node(t, i, flags, cs, out);
			}
		} else {
			print_all(t, flags, false, false, cs, out);
		}
		return 0;
	}
	for d in &args[1..] {
		t.add_dep(&args[0], d);
	}
	0
}

/// `zmodload -a`/`-u` with `-b`/`-c`/`-p`/`-f` (zsh `bin_zmodload_auto`).
fn zmodload_auto(
	t: &mut Tables,
	msgs: &mut Vec<Msg>,
	out: &mut Vec<u8>,
	nam: &[u8],
	ops: &Ops,
	args: &[BString],
	cs: Charset,
) -> i32 {
	let list = ops.isset(b'L');
	let fchar = if ops.isset(b'c') {
		if args.is_empty() {
			for c in &t.conds {
				if list {
					out.extend_from_slice(b"zmodload -ac");
					if c.infix {
						out.push(b'I');
					}
					out.extend_from_slice(format!(" {} {}\n", c.module, c.name).as_bytes());
				} else {
					let kind = if c.infix { "infix" } else { "post" };
					out.extend_from_slice(format!("{kind} {} ({})\n", c.name, c.module).as_bytes());
				}
			}
			return 0;
		}
		if ops.isset(b'I') { b'C' } else { b'c' }
	} else if ops.isset(b'p') {
		if args.is_empty() {
			// `scanhashtable(paramtab, 1, …)`: sorted by name.
			let mut order: Vec<usize> = (0..t.params.len()).collect();
			order.sort_by(|&a, &b| t.params[a].name.cmp(&t.params[b].name));
			for i in order {
				let p = &t.params[i];
				if list {
					out.extend_from_slice(format!("zmodload -ap {} {}\n", p.module, p.name).as_bytes());
				} else {
					out.extend_from_slice(format!("{} ({})\n", p.name, p.module).as_bytes());
				}
			}
			return 0;
		}
		b'p'
	} else if ops.isset(b'f') {
		if args.is_empty() {
			for f in &t.mfuncs {
				if list {
					out.extend_from_slice(format!("zmodload -af {} {}\n", f.module, f.name).as_bytes());
				} else {
					out.extend_from_slice(format!("{} ({})\n", f.name, f.module).as_bytes());
				}
			}
			return 0;
		}
		b'f'
	} else {
		if args.is_empty() {
			// `scanhashtable(builtintab, 1, …)`: sorted by name.
			let mut order: Vec<usize> = (0..t.bins.len()).collect();
			order.sort_by(|&a, &b| t.bins[a].name.cmp(&t.bins[b].name));
			for i in order {
				let b = &t.bins[i];
				if list {
					out.extend_from_slice(b"zmodload -ab ");
					if b.module.first() == Some(&b'-') {
						out.extend_from_slice(b"-- ");
					}
					out.extend_from_slice(&q(&b.module, cs));
					if b.name != b.module {
						out.push(b' ');
						out.extend_from_slice(&q(&b.name, cs));
					}
				} else {
					out.extend_from_slice(&niceformat(&b.name, false, cs));
					if b.name != b.module {
						out.extend_from_slice(b" (");
						out.extend_from_slice(&niceformat(&b.module, false, cs));
						out.push(b')');
					}
				}
				out.push(b'\n');
			}
			return 0;
		}
		b'b'
	};
	let mut flags = AUTOALL;
	if ops.isset(b'i') {
		flags |= IGNORE;
	}
	if ops.isset(b'u') {
		flags |= REMOVE;
		t.autofeatures(msgs, Some(nam), None, args, fchar, flags)
	} else {
		let module = args[0].clone();
		let feats = if args.len() > 1 { &args[1..] } else { args };
		t.autofeatures(msgs, Some(nam), Some(&module), feats, fchar, flags)
	}
}

/// `zmodload` without `-F`, `-e`, `-d`, `-a` (zsh `bin_zmodload_load`).
fn zmodload_load(
	t: &mut Tables,
	msgs: &mut Vec<Msg>,
	out: &mut Vec<u8>,
	nam: &[u8],
	ops: &Ops,
	args: &[BString],
	cs: Charset,
) -> i32 {
	if ops.isset(b'u') {
		let mut ret = 0;
		for a in args {
			if t.unload_named_module(msgs, a, nam, ops.isset(b'i')) != 0 {
				ret = 1;
			}
		}
		return ret;
	}
	if args.is_empty() {
		let flags = if ops.isset(b'L') { PM_LIST } else { 0 };
		print_all(t, flags, false, true, cs, out);
		return 0;
	}
	let mut ret = 0;
	for a in args {
		let r = t.require_module(msgs, a, None, ops.isset(b's'));
		if r != 0 && ret != 1 {
			ret = r;
		}
	}
	ret
}

/// `zmodload -F` (zsh `bin_zmodload_features`): its status.
fn zmodload_features(
	ctx: &mut Ctx<'_, '_>,
	t: &mut Tables,
	msgs: &mut Vec<Msg>,
	out: &mut Vec<u8>,
	ops: &Ops,
	args: &[BString],
	cs: Charset,
) -> Result<i32, Need> {
	let nam: BString = ctx.name.into();
	let o = |c| ops.isset(c);
	let Some((modname, args)) = args.split_first() else {
		if o(b'L') {
			if o(b'P') {
				msgs.push(Msg::Nam(nam, "-P is only allowed with a module name".into()));
				return Ok(1);
			}
			let mut flags = PM_LIST | PM_FEATURES;
			if o(b'l') {
				flags |= PM_LISTALL;
			}
			if o(b'a') {
				flags |= PM_AUTO;
			}
			print_all(t, flags, false, true, cs, out);
			return Ok(0);
		}
		msgs.push(Msg::Nam(nam, "-F requires a module name".into()));
		return Ok(1);
	};
	let pats: Option<Vec<ZPat>> = if o(b'm') {
		let mut v = Vec::with_capacity(args.len());
		for a in args {
			let a = match a.first() {
				Some(b'+' | b'-') => &a[1..],
				_ => a.as_slice(),
			};
			let Some(p) = pattern_arg(ctx, a)? else {
				return Ok(1);
			};
			v.push(p);
		}
		Some(v)
	} else {
		None
	};
	let fmatch = |iarg: usize, f: &str| -> bool {
		let arg = &args[iarg];
		if let Some(p) = &pats {
			p[iarg].matches(f.as_bytes())
		} else {
			let a = match arg.first() {
				Some(b'+' | b'-') => &arg[1..],
				_ => arg.as_slice(),
			};
			a == f.as_bytes()
		}
	};
	if o(b'l') || o(b'L') || o(b'e') {
		let param = ops.arg(b'P').map(BString::from);
		let found = t.find(modname, true).map(|(i, _)| i);
		if o(b'a') {
			let Some(i) = found.filter(|&i| t.mods[i].autoloads.is_some()) else {
				return Ok(1);
			};
			let autos = t.mods[i].autoloads.clone().unwrap_or_default();
			if o(b'e') {
				for a in args {
					let (sense, f) = match a.first() {
						Some(b'+') => (true, &a[1..]),
						Some(b'-') => (false, &a[1..]),
						_ => (true, a.as_slice()),
					};
					if autos.iter().any(|x| x == f) != sense {
						return Ok(1);
					}
				}
				return Ok(0);
			}
			if let Some(p) = param {
				return assign_array(ctx, &p, autos);
			}
			if o(b'L') {
				out.extend_from_slice(format!("zmodload -aF {}", t.mods[i].name).as_bytes());
				out.push(if autos.is_empty() { b'\n' } else { b' ' });
			}
			for (k, a) in autos.iter().enumerate() {
				out.extend_from_slice(a);
				out.push(if o(b'L') && k + 1 < autos.len() {
					b' '
				} else {
					b'\n'
				});
			}
			return Ok(0);
		}
		let Some(i) = found.filter(|&i| t.is_loaded(i)) else {
			if !o(b'e') {
				msgs.push(Msg::Nam(nam, format!("module `{}' is not yet loaded", modname.as_bstr())));
			}
			return Ok(1);
		};
		let d = def(&t.mods[i].name).filter(|d| d.features);
		let Some(d) = d else {
			if !o(b'e') {
				msgs.push(Msg::Nam(
					nam,
					format!("module `{}' does not support features", t.mods[i].name),
				));
			}
			return Ok(1);
		};
		let enables = t.mods[i].enables.clone();
		let on = |fi: usize| enables.get(fi).copied().unwrap_or(false);
		for (iarg, a) in args.iter().enumerate() {
			let want = match a.first() {
				Some(b'-') => Some(false),
				Some(b'+') => Some(true),
				_ => None,
			};
			let mut found = false;
			for (fi, f) in d.features().enumerate() {
				if fmatch(iarg, f) {
					if o(b'e') && want.is_some_and(|w| w != on(fi)) {
						return Ok(1);
					}
					found = true;
					if pats.is_none() {
						break;
					}
				}
			}
			if !found {
				if !o(b'e') {
					let what = if pats.is_some() {
						"has no feature matching"
					} else {
						"has no such feature"
					};
					msgs.push(Msg::Nam(
						nam,
						format!("module `{}' {what}: `{}'", modname.as_bstr(), a.as_bstr()),
					));
				}
				return Ok(1);
			}
		}
		if o(b'e') {
			return Ok(0);
		}
		// When listing, zsh compares a plain feature argument with its
		// sign still on (`strcmp(*fp, *argp)`): `+b:x` selects nothing.
		let printed = |f: &str| {
			args.is_empty()
				|| (0..args.len()).any(|iarg| match &pats {
					Some(p) => p[iarg].matches(f.as_bytes()),
					None => args[iarg].as_slice() == f.as_bytes(),
				})
		};
		let only_on = o(b'L') && !o(b'l');
		let mut list: Vec<BString> = Vec::new();
		for (fi, f) in d.features().enumerate() {
			if !printed(f) || (only_on && !on(fi)) {
				continue;
			}
			let sign = if only_on {
				""
			} else if on(fi) {
				"+"
			} else {
				"-"
			};
			list.push(format!("{sign}{f}").into());
		}
		if let Some(p) = param {
			return assign_array(ctx, &p, list);
		}
		if o(b'L') {
			out.extend_from_slice(format!("zmodload -F {} ", t.mods[i].name).as_bytes());
		}
		// zsh ends each entry with a space under -L unless it is the last
		// feature of the module (printed or not).
		let last_feature = d.features().last();
		for (fi, f) in d.features().enumerate() {
			if !printed(f) || (only_on && !on(fi)) {
				continue;
			}
			let sign = if only_on {
				""
			} else if on(fi) {
				"+"
			} else {
				"-"
			};
			out.extend_from_slice(sign.as_bytes());
			out.extend_from_slice(f.as_bytes());
			out.push(if o(b'L') && Some(f) != last_feature {
				b' '
			} else {
				b'\n'
			});
		}
		return Ok(0);
	}
	if o(b'P') {
		msgs.push(Msg::Nam(nam, "-P can only be used with -l or -L".into()));
		return Ok(1);
	}
	if o(b'a') {
		if o(b'm') {
			msgs.push(Msg::Nam(nam, "-m cannot be used with -a".into()));
			return Ok(1);
		}
		return Ok(t.autofeatures(msgs, Some(&nam), Some(modname), args, 0, IGNORE));
	}
	let mut fe: Vec<Fe> = match pats {
		Some(ps) => args
			.iter()
			.zip(ps)
			.map(|(a, p)| Fe { s: a.clone(), pat: Some(p) })
			.collect(),
		None => args.iter().map(|a| Fe::plain(a.clone())).collect(),
	};
	Ok(t.require_module(msgs, modname, Some(&mut fe), o(b's')))
}

/// `zmodload -P NAME`: assign `list` to the array `NAME` (zsh
/// `setaparam`).
fn assign_array(ctx: &mut Ctx<'_, '_>, name: &[u8], list: Vec<BString>) -> Result<i32, Need> {
	match zx(ctx, |ex| params::assignaparam(ex, name, list, 0))? {
		Ok(()) => Ok(0),
		Err(d) => {
			ctx.diag(d);
			Ok(1)
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn boot_tables_order_modules_like_zsh() {
		let mut t = DEFAULT.clone();
		let mut msgs = Vec::new();
		t.require_module(&mut msgs, b"zsh/parameter", None, false);
		let names: Vec<String> = t
			.modules_param()
			.into_iter()
			.map(|(n, _)| n.to_string())
			.collect();
		assert_eq!(
			names.join(" "),
			"zsh/parameter zsh/main zsh/rlimits zsh/computil zsh/zle zsh/sched zsh/zutil zsh/compctl \
			 zsh/complete zsh/termcap zsh/terminfo zsh/watch zsh/param/private zsh/zleparameter"
		);
	}

	#[test]
	fn modname_ok_matches_zsh() {
		assert!(modname_ok(b"zsh/net/tcp") && modname_ok(b"a_b"));
		assert!(!modname_ok(b"zsh/x-y") && !modname_ok(b"a.b"));
	}

	#[test]
	fn every_module_builtin_is_a_feature() {
		use strum::IntoEnumIterator;
		for id in IntrinsicId::iter() {
			if let Some(m) = module_of(id) {
				let name: &'static str = id.into();
				let d = def(m.as_bytes()).expect(m);
				assert!(
					d.index(feature_name(b'b', name.as_bytes()).as_slice())
						.is_some(),
					"{name}"
				);
			}
		}
	}
}
