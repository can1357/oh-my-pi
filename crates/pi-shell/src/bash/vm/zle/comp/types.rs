//! The completion data structures of zsh 5.9 `Src/Zle/comp.h`: matches,
//! groups, explanations, matchers (`-M` specs), the `cline` lists that
//! build the unambiguous string, menu and list state, `compadd`'s
//! arguments.
//!
//! Strings are zsh's internal form: metafied bytes, tokenized where zsh
//! keeps them tokenized ([`crate::bash::syntax::zsh::tok`]). A C `NULL`
//! string is `None`. C's linked lists whose nodes other code points into
//! (groups, clines) live in arenas ([`Groups`], [`Clines`]) addressed by
//! index, so `p->next = q` surgery ports one to one; pointers to a match
//! inside a group's array are [`MRef`]s.

use std::sync::Arc;

use bstr::BString;

// ---- explanations, matches, groups -----------------------------------------

/// zsh `struct cexpl`: an explanation string (`compadd -X`, `-x`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cexpl {
	/// Display even without matches (`-x`).
	pub always: bool,
	/// The string (metafied, `%`-escapes unexpanded).
	pub str:    BString,
	/// Number of matches.
	pub count:  i32,
	/// Number of matches with fignore ignored.
	pub fcount: i32,
}

/// zsh `CGF_*`: group flags.
pub mod cgf {
	/// Don't sort this group.
	pub const NOSORT: u32 = 1;
	/// To be printed on different lines.
	pub const LINES: u32 = 2;
	/// Has display strings printed on separate lines.
	pub const HASDL: u32 = 4;
	/// Remove consecutive duplicates only.
	pub const UNIQALL: u32 = 8;
	/// Don't deduplicate.
	pub const UNIQCON: u32 = 16;
	/// `LIST_PACKED` for this group.
	pub const PACKED: u32 = 32;
	/// `LIST_ROWS_FIRST` for this group.
	pub const ROWS: u32 = 64;
	/// Contains file names.
	pub const FILES: u32 = 128;
	/// Sort by match rather than by display string.
	pub const MATSORT: u32 = 256;
	/// Sort numerically.
	pub const NUMSORT: u32 = 512;
	/// Sort in reverse.
	pub const REVSORT: u32 = 1024;
}

/// zsh `CMF_*` (match flags; `cmatch.flags`).
pub mod cmf {
	/// A file.
	pub const FILE: u32 = 1 << 0;
	/// Remove the suffix.
	pub const REMOVE: u32 = 1 << 1;
	/// A parameter expansion.
	pub const ISPAR: u32 = 1 << 2;
	/// Parameter expansion with a brace.
	pub const PARBR: u32 = 1 << 3;
	/// Nested parameter expansion.
	pub const PARNEST: u32 = 1 << 4;
	/// Not listed.
	pub const NOLIST: u32 = 1 << 5;
	/// Display strings one per line.
	pub const DISPLINE: u32 = 1 << 6;
	/// Temporarily hidden.
	pub const HIDE: u32 = 1 << 7;
	/// Don't add a space.
	pub const NOSPACE: u32 = 1 << 8;
	/// Prefer `LIST_PACKED`.
	pub const PACKED: u32 = 1 << 9;
	/// Prefer `LIST_ROWS_FIRST`.
	pub const ROWS: u32 = 1 << 10;
	/// The string appears more than once.
	pub const MULT: u32 = 1 << 11;
	/// First of multiple equal strings.
	pub const FMULT: u32 = 1 << 12;
	/// A match representing all other matches.
	pub const ALL: u32 = 1 << 13;
	/// Unselectable dummy match.
	pub const DUMMY: u32 = 1 << 14;
	/// Deduplication of unsorted matches (internal).
	pub const DELETE: u32 = 1 << 16;
}

/// zsh `struct cmatch`: one match.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cmatch {
	/// The match itself.
	pub str:    BString,
	/// The match unquoted.
	pub orig:   Option<BString>,
	/// Ignored prefix, re-inserted.
	pub ipre:   Option<BString>,
	/// Ignored prefix, unquoted.
	pub ripre:  Option<BString>,
	/// Ignored suffix.
	pub isuf:   Option<BString>,
	/// The path prefix (`-p`).
	pub ppre:   Option<BString>,
	/// The path suffix (`-s`).
	pub psuf:   Option<BString>,
	/// Path prefix for opendir (`-W`).
	pub prpre:  Option<BString>,
	/// Prefix from `-P`.
	pub pre:    Option<BString>,
	/// Suffix from `-S`.
	pub suf:    Option<BString>,
	/// String to display (`-d`).
	pub disp:   Option<BString>,
	/// Closing quote to add automatically.
	pub autoq:  Option<BString>,
	/// [`cmf`] flags.
	pub flags:  u32,
	/// Places to put the brace prefixes (`nbrbeg` entries).
	pub brpl:   Option<Vec<i32>>,
	/// …and the suffixes (`nbrend` entries).
	pub brsl:   Option<Vec<i32>>,
	/// When to remove the suffix (`-r`).
	pub rems:   Option<BString>,
	/// Shell function for suffix removal (`-R`).
	pub remf:   Option<BString>,
	/// Length of the quote prefix.
	pub qipl:   i32,
	/// Length of the quote suffix.
	pub qisl:   i32,
	/// Group-relative number.
	pub rnum:   i32,
	/// Global number.
	pub gnum:   i32,
	/// `st_mode` of a stat (`lstat`).
	pub mode:   u32,
	/// `LIST_TYPES` character for `mode`, or 0.
	pub modec:  u8,
	/// `st_mode` following symlinks.
	pub fmode:  u32,
	/// `LIST_TYPES` character for `fmode`, or 0.
	pub fmodec: u8,
}

/// A group in [`Groups`] (zsh `Cmgroup` pointer).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct GId(pub u32);

/// A match inside a group's final array (zsh `Cmatch *` pointing into
/// `g->matches`): `i == matches.len()` is the array's `NULL` terminator.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MRef {
	/// The group.
	pub g: GId,
	/// Index into its [`Cmgroup::matches`].
	pub i: usize,
}

/// zsh `struct cmgroup`.
#[derive(Clone, Debug, Default)]
pub struct Cmgroup {
	/// The group's name (`-J`/`-V`).
	pub name:      Option<BString>,
	/// Previous on the list.
	pub prev:      Option<GId>,
	/// Next on the list.
	pub next:      Option<GId>,
	/// [`cgf`] flags.
	pub flags:     u32,
	/// Number of matches.
	pub mcount:    i32,
	/// The matches (after `makearrays`; zsh's NULL-terminated array).
	pub matches:   Vec<Cmatch>,
	/// Number of things to list.
	pub lcount:    i32,
	/// Number of line-displays.
	pub llcount:   i32,
	/// Things to list (`compadd -l`-style lists, `ylist`).
	pub ylist:     Option<Vec<BString>>,
	/// Number of explanation strings.
	pub ecount:    i32,
	/// Explanation strings (after `makearrays`).
	pub expls:     Vec<Cexpl>,
	/// Number of compctls used.
	pub ccount:    i32,
	/// Explanation strings while building.
	pub lexpls:    Vec<Cexpl>,
	/// Matches while building.
	pub lmatches:  Vec<Cmatch>,
	/// Matches without fignore while building.
	pub lfmatches: Vec<Cmatch>,
	/// Number of this group.
	pub num:       i32,
	/// Number of opened braces.
	pub nbrbeg:    i32,
	/// Number of closed braces.
	pub nbrend:    i32,
	/// New matches since the last `permmatches`.
	pub new:       bool,
	/// Listing: matches to list in columns.
	pub dcount:    i32,
	/// Listing: columns.
	pub cols:      i32,
	/// Listing: lines.
	pub lins:      i32,
	/// Listing: column width.
	pub width:     i32,
	/// Listing: column widths for `LIST_PACKED`.
	pub widths:    Option<Vec<i32>>,
	/// Listing: total length.
	pub totl:      i32,
	/// Listing: length of the shortest match.
	pub shortest:  i32,
	/// The permanent copy of this group.
	pub perm:      Option<GId>,
	/// zsh `lallccs`: the compctls used for this group (compctl's ids;
	/// `None` for unsorted groups).
	pub lallccs:   Option<Vec<usize>>,
}

/// The group arena (zsh's heap and permanent group allocations).
#[derive(Clone, Debug, Default)]
pub struct Groups {
	slots: Vec<Option<Cmgroup>>,
	free:  Vec<u32>,
}

impl Groups {
	/// Allocate `g`.
	pub fn alloc(&mut self, g: Cmgroup) -> GId {
		if let Some(i) = self.free.pop() {
			self.slots[i as usize] = Some(g);
			GId(i)
		} else {
			self.slots.push(Some(g));
			GId(u32::try_from(self.slots.len() - 1).unwrap_or(u32::MAX))
		}
	}

	/// Free `id` (zsh `freematches` of one group).
	pub fn free(&mut self, id: GId) {
		if let Some(s) = self.slots.get_mut(id.0 as usize)
			&& s.take().is_some()
		{
			self.free.push(id.0);
		}
	}

	/// The group `id`.
	///
	/// # Panics
	/// When `id` was freed (a use after free in the C sense).
	pub fn get(&self, id: GId) -> &Cmgroup {
		self.slots[id.0 as usize]
			.as_ref()
			.expect("live completion group")
	}

	/// The group `id`, mutably.
	///
	/// # Panics
	/// As [`Self::get`].
	pub fn get_mut(&mut self, id: GId) -> &mut Cmgroup {
		self.slots[id.0 as usize]
			.as_mut()
			.expect("live completion group")
	}

	/// The group `id`, `None` when it was freed (a stale reference zsh
	/// would dereference anyway).
	pub fn try_get(&self, id: GId) -> Option<&Cmgroup> {
		self.slots.get(id.0 as usize).and_then(Option::as_ref)
	}

	/// The match at `r`, `None` for the terminator or a freed group.
	pub fn try_mat(&self, r: MRef) -> Option<&Cmatch> {
		self.try_get(r.g).and_then(|g| g.matches.get(r.i))
	}

	/// The match at `r` (`None`: the terminator).
	pub fn mat(&self, r: MRef) -> Option<&Cmatch> {
		self.get(r.g).matches.get(r.i)
	}

	/// The match at `r`, mutably.
	pub fn mat_mut(&mut self, r: MRef) -> Option<&mut Cmatch> {
		self.get_mut(r.g).matches.get_mut(r.i)
	}

	/// The groups of the list starting at `head`, following `next`.
	pub fn list(&self, head: Option<GId>) -> impl Iterator<Item = GId> + '_ {
		std::iter::successors(head, |&g| self.get(g).next)
	}
}

// ---- matchers ------------------------------------------------------------

/// zsh `CMF_LINE` etc. (matcher flags, `cmatcher.flags`).
pub mod cmatcher_flags {
	/// Insert the string from the line, not from the word.
	pub const LINE: u32 = 1;
	/// Anchored on the left.
	pub const LEFT: u32 = 2;
	/// Anchored on the right.
	pub const RIGHT: u32 = 4;
	/// Interior (`x:` with both anchors).
	pub const INTER: u32 = 8;
}

/// zsh `struct cpattern`: one character position of a matcher pattern.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cpattern {
	/// `[...]` (zsh `CPAT_CCLASS`): the class, a metafied tokenized
	/// string as in normal patterns.
	CClass(BString),
	/// `[!...]` (`CPAT_NCLASS`).
	NClass(BString),
	/// `{...}` equivalence class (`CPAT_EQUIV`).
	Equiv(BString),
	/// `?` (`CPAT_ANY`).
	Any,
	/// A single character (`CPAT_CHAR`).
	Char(char),
}

/// zsh `struct cmatcher`: one `-M` spec element (immutable once parsed;
/// zsh's `refc` is the [`Arc`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cmatcher {
	/// Next matcher of the same spec.
	pub next:  Option<Arc<Self>>,
	/// [`cmatcher_flags`].
	pub flags: u32,
	/// What matches on the line.
	pub line:  Vec<Cpattern>,
	/// Length of the line pattern.
	pub llen:  i32,
	/// What matches in the word.
	pub word:  Vec<Cpattern>,
	/// Length of the word pattern, or -1 (`*`), -2 (`**`).
	pub wlen:  i32,
	/// Left anchor.
	pub left:  Vec<Cpattern>,
	/// Length of the left anchor.
	pub lalen: i32,
	/// Right anchor.
	pub right: Vec<Cpattern>,
	/// Length of the right anchor.
	pub ralen: i32,
}

/// zsh `struct cmlist`: a list of global matchers (`mstack`,
/// `bmatchers`, `compadd -M` stacking), shared tails as in C.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cmlist {
	/// Next one.
	pub next:    Option<Arc<Self>>,
	/// The matcher definition (`None`: an empty spec).
	pub matcher: Option<Arc<Cmatcher>>,
	/// The spec string.
	pub str:     BString,
}

// ---- clines ---------------------------------------------------------------

/// A cline in [`Clines`] (zsh `Cline` pointer).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Cl(pub u32);

/// zsh `CLF_*`.
pub mod clf {
	/// Missing.
	pub const MISS: u32 = 1;
	/// Different.
	pub const DIFF: u32 = 2;
	/// Suffix.
	pub const SUF: u32 = 4;
	/// Middle.
	pub const MID: u32 = 8;
	/// New.
	pub const NEW: u32 = 16;
	/// From the line.
	pub const LINE: u32 = 32;
	/// Joined.
	pub const JOIN: u32 = 64;
	/// Matched.
	pub const MATCHED: u32 = 128;
	/// Skip.
	pub const SKIP: u32 = 256;
}

/// zsh `struct cline`. C's `line`/`word`/`orig` are pointers into other
/// strings with a length; here they are owned copies of exactly the
/// `llen`/`wlen`/`olen` bytes (`None` for `NULL`), kept in step with the
/// lengths by the code that changes them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cline {
	/// Next on the list.
	pub next:   Option<Cl>,
	/// [`clf`] flags.
	pub flags:  u32,
	/// Line string.
	pub line:   Option<BString>,
	/// Its length.
	pub llen:   i32,
	/// Word string.
	pub word:   Option<BString>,
	/// Its length.
	pub wlen:   i32,
	/// Original string.
	pub orig:   Option<BString>,
	/// Its length.
	pub olen:   i32,
	/// zsh `slen`.
	pub slen:   i32,
	/// Prefix sub-list.
	pub prefix: Option<Cl>,
	/// Suffix sub-list.
	pub suffix: Option<Cl>,
	/// zsh `min`.
	pub min:    i32,
	/// zsh `max`.
	pub max:    i32,
}

/// The cline arena (zsh's heap clines).
#[derive(Clone, Debug, Default)]
pub struct Clines {
	slots: Vec<Cline>,
}

impl Clines {
	/// Allocate `c` (zsh `get_cline`'s allocation).
	pub fn alloc(&mut self, c: Cline) -> Cl {
		self.slots.push(c);
		Cl(u32::try_from(self.slots.len() - 1).unwrap_or(u32::MAX))
	}

	/// Drop everything (zsh's heap pop at the end of a completion).
	pub fn clear(&mut self) {
		self.slots.clear();
	}

	/// The node `c`.
	pub fn get(&self, c: Cl) -> &Cline {
		&self.slots[c.0 as usize]
	}

	/// The node `c`, mutably.
	pub fn get_mut(&mut self, c: Cl) -> &mut Cline {
		&mut self.slots[c.0 as usize]
	}
}

// ---- ambiguous / menu / list state ---------------------------------------

/// zsh `struct aminfo`: what the unambiguous string is made of (one for
/// normal matches, one with fignore ignored).
#[derive(Clone, Debug, Default)]
pub struct Aminfo {
	/// The first match.
	pub firstm: Option<Box<Cmatch>>,
	/// There was an exact match (zsh `exact`: 0, 1, 2).
	pub exact:  i32,
	/// The exact match.
	pub exactm: Option<Box<Cmatch>>,
	/// Number of matches.
	pub count:  i32,
	/// Unambiguous line string.
	pub line:   Option<Cl>,
}

/// zsh `struct menuinfo`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Menuinfo {
	/// Position in the group list.
	pub group:  Option<GId>,
	/// The match currently inserted.
	pub cur:    Option<MRef>,
	/// Where it begins on the line.
	pub pos:    i32,
	/// Length of the inserted string.
	pub len:    i32,
	/// End on the line.
	pub end:    i32,
	/// The cursor was at the end.
	pub we:     bool,
	/// Length of the suffix inserted.
	pub insc:   i32,
	/// We asked whether the list should be shown (0, 1, 2).
	pub asked:  i32,
	/// Prefix before a brace.
	pub prebr:  Option<BString>,
	/// Suffix after a brace.
	pub postbr: Option<BString>,
}

/// zsh `CAF_*` (`compadd`/`addmatches` flags).
pub mod caf {
	/// `-Q`: arguments already quoted.
	pub const QUOTE: u32 = 1;
	/// `-V`: don't sort.
	pub const NOSORT: u32 = 2;
	/// Without `-U`: do matching.
	pub const MATCH: u32 = 4;
	/// `-2`: don't deduplicate.
	pub const UNIQCON: u32 = 8;
	/// `-1`: deduplicate consecutive only.
	pub const UNIQALL: u32 = 16;
	/// `-a`/`-k`: array/assoc parameter names.
	pub const ARRAYS: u32 = 32;
	/// `-k`: assoc keys.
	pub const KEYS: u32 = 64;
	/// `-C`: `_all_matches`.
	pub const ALL: u32 = 128;
	/// `-o match`.
	pub const MATSORT: u32 = 256;
	/// `-o numeric`.
	pub const NUMSORT: u32 = 512;
	/// `-o reverse`.
	pub const REVSORT: u32 = 1024;
}

/// zsh `struct cadata`: `compadd`'s options for `addmatches`.
#[derive(Clone, Debug, Default)]
pub struct Cadata {
	/// Ignored prefix (`-i`).
	pub ipre:    Option<BString>,
	/// Ignored suffix (`-I`).
	pub isuf:    Option<BString>,
	/// Path prefix (`-p`).
	pub ppre:    Option<BString>,
	/// Path suffix (`-s`).
	pub psuf:    Option<BString>,
	/// Expanded path prefix (`-W`).
	pub prpre:   Option<BString>,
	/// Prefix to insert (`-P`).
	pub pre:     Option<BString>,
	/// Suffix to insert (`-S`).
	pub suf:     Option<BString>,
	/// Group name (`-J`/`-V`).
	pub group:   Option<BString>,
	/// Remove the suffix on these characters (`-r`).
	pub rems:    Option<BString>,
	/// Suffix removal function (`-R`).
	pub remf:    Option<BString>,
	/// Ignored suffixes (`-F`).
	pub ign:     Option<BString>,
	/// [`cmf`] flags (`-f`, `-q`, `-n`, …).
	pub flags:   u32,
	/// [`caf`] flags.
	pub aflags:  u32,
	/// Match spec parsed from `-M`.
	pub matcher: Option<Arc<Cmatcher>>,
	/// Explanation (`-X`).
	pub exp:     Option<BString>,
	/// Array to store matches in (`-A`).
	pub apar:    Option<BString>,
	/// Array to store originals in (`-O`).
	pub opar:    Option<BString>,
	/// Arrays to delete non-matches in (`-D`).
	pub dpar:    Vec<BString>,
	/// Array with display strings (`-d`).
	pub disp:    Option<BString>,
	/// Message shown unconditionally (`-x`).
	pub mesg:    Option<BString>,
	/// Number of dummy matches to add (`-E`).
	pub dummies: i32,
}

/// zsh `struct cldata`: list layout data.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cldata {
	/// Screen width.
	pub zterm_columns: i32,
	/// Screen height.
	pub zterm_lines:   i32,
	/// Value of `menuacc`.
	pub menuacc:       i32,
	/// No need to calculate anew.
	pub valid:         bool,
	/// Number of matches to list.
	pub nlist:         i32,
	/// Lines needed.
	pub nlines:        i32,
	/// There are hidden matches.
	pub hidden:        bool,
	/// Only explanations to print.
	pub onlyexpl:      i32,
	/// Hidden matches are shown.
	pub showall:       bool,
}

/// zsh `struct brinfo` (`zle_tricky.c)`: a brace on the line.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Brinfo {
	/// The text of the brace part.
	pub str:    BString,
	/// Position in the word.
	pub pos:    i32,
	/// Position in the quoted word.
	pub qpos:   i32,
	/// Position relative to the cursor.
	pub curpos: i32,
}

/// zsh `struct chdata`: what the listing and menu hooks get.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Chdata {
	/// The matches (group list head).
	pub matches: Option<GId>,
	/// Number of matches.
	pub num:     i32,
	/// Number of messages.
	pub nmesg:   i32,
	/// Current match.
	pub cur:     Option<MRef>,
}

/// zsh `FC_LINE`, `FC_INWORD` (`fromcomp`).
pub mod fc {
	/// `FC_LINE`.
	pub const LINE: u32 = 1;
	/// `FC_INWORD`.
	pub const INWORD: u32 = 2;
}

/// zsh `CM_SPACE`: columns between list columns.
pub const CM_SPACE: i32 = 2;
