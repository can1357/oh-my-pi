//! zsh 5.9 `Src/Zle/compcore.c`: running a completion (`do_completion`,
//! `makecomplist`, `callcompfunc`), adding matches (`addmatches`,
//! `add_match_data`), groups, sorting and deduplication (`makearray`),
//! the permanent match lists (`permmatches`).

mod add;
mod perm;
mod run;
mod strings;

use std::{collections::HashMap, sync::Arc};

use bstr::BString;

pub use self::{
	add::{
		add_match_data, addexpl, addmatches, begcmgroup, curexpl_mut, endcmgroup, set_curexpl,
		ztat_paths,
	},
	perm::{freematches, matcheq, permmatches},
	run::{after_complete, before_complete, do_completion},
	strings::{
		check_param, comp_quoting_string, comp_str, ctokenize, get_user_var, multiquote,
		set_comp_sep, tildequote,
	},
};
use super::types::{Aminfo, Cexpl, Cldata, Cmatcher, Cmlist, GId, Menuinfo};

/// compcore.c's globals.
#[derive(Clone, Debug, Default)]
pub struct State {
	/// zsh `useexact`.
	pub useexact:     i32,
	/// zsh `useline`.
	pub useline:      i32,
	/// zsh `uselist`.
	pub uselist:      i32,
	/// zsh `forcelist`.
	pub forcelist:    i32,
	/// zsh `startauto`.
	pub startauto:    i32,
	/// zsh `iforcemenu`.
	pub iforcemenu:   i32,
	/// zsh `dolastprompt`.
	pub dolastprompt: i32,
	/// zsh `oldlist`.
	pub oldlist:      i32,
	/// zsh `oldins`.
	pub oldins:       i32,
	/// zsh `origlpre`.
	pub origlpre:     i32,
	/// zsh `origlsuf`.
	pub origlsuf:     i32,
	/// zsh `lenchanged`.
	pub lenchanged:   i32,
	/// zsh `movetoend`.
	pub movetoend:    i32,
	/// zsh `insmnum`.
	pub insmnum:      i32,
	/// zsh `insspace`.
	pub insspace:     i32,
	/// zsh `minfo`.
	pub minfo:        Menuinfo,
	/// zsh `menuacc`.
	pub menuacc:      i32,
	/// zsh `hasunqu`.
	pub hasunqu:      i32,
	/// zsh `useqbr`.
	pub useqbr:       i32,
	/// zsh `brpcs`.
	pub brpcs:        i32,
	/// zsh `brscs`.
	pub brscs:        i32,
	/// zsh `ispar`.
	pub ispar:        i32,
	/// zsh `linwhat`.
	pub linwhat:      i32,
	/// zsh `parpre`.
	pub parpre:       Option<BString>,
	/// zsh `parflags`.
	pub parflags:     i32,
	/// zsh `mflags`.
	pub mflags:       i32,
	/// zsh `parq`.
	pub parq:         i32,
	/// zsh `eparq`.
	pub eparq:        i32,
	/// zsh `ipre`.
	pub ipre:         Option<BString>,
	/// zsh `ripre`.
	pub ripre:        Option<BString>,
	/// zsh `isuf`.
	pub isuf:         Option<BString>,
	/// zsh `lastmatches`.
	pub lastmatches:  Option<GId>,
	/// zsh `pmatches`.
	pub pmatches:     Option<GId>,
	/// zsh `amatches`.
	pub amatches:     Option<GId>,
	/// zsh `lmatches`.
	pub lmatches:     Option<GId>,
	/// zsh `lastlmatches`.
	pub lastlmatches: Option<GId>,
	/// zsh `hasoldlist`.
	pub hasoldlist:   i32,
	/// zsh `hasperm`.
	pub hasperm:      i32,
	/// zsh `hasallmatch`.
	pub hasallmatch:  i32,
	/// zsh `newmatches`.
	pub newmatches:   i32,
	/// zsh `permmnum`.
	pub permmnum:     i32,
	/// zsh `permgnum`.
	pub permgnum:     i32,
	/// zsh `lastpermmnum`.
	pub lastpermmnum: i32,
	/// zsh `lastpermgnum`.
	pub lastpermgnum: i32,
	/// zsh `nmatches`.
	pub nmatches:     i32,
	/// zsh `smatches`.
	pub smatches:     i32,
	/// zsh `diffmatches`.
	pub diffmatches:  i32,
	/// zsh `nmessages`.
	pub nmessages:    i32,
	/// zsh `onlyexpl`.
	pub onlyexpl:     i32,
	/// zsh `listdat`.
	pub listdat:      Cldata,
	/// zsh `ispattern`.
	pub ispattern:    i32,
	/// zsh `haspattern`.
	pub haspattern:   i32,
	/// zsh `hasmatched`.
	pub hasmatched:   i32,
	/// zsh `hasunmatched`.
	pub hasunmatched: i32,
	/// zsh `mgroup`: the group matches are added to.
	pub mgroup:       Option<GId>,
	/// zsh `mnum`.
	pub mnum:         i32,
	/// zsh `unambig_mnum`.
	pub unambig_mnum: i32,
	/// zsh `maxmlen`.
	pub maxmlen:      i32,
	/// zsh `minmlen`.
	pub minmlen:      i32,
	/// zsh `curexpl`: the explanation being built (added to the group's
	/// `lexpls` by `addexpl`).
	pub curexpl:      Option<Cexpl>,
	/// zsh `mstack`.
	pub mstack:       Option<Arc<Cmlist>>,
	/// zsh `bmatchers`.
	pub bmatchers:    Option<Arc<Cmlist>>,
	/// zsh `matchers`.
	pub matchers:     Vec<Arc<Cmatcher>>,
	/// zsh `ainfo`.
	pub ainfo:        Option<Box<Aminfo>>,
	/// zsh `fainfo`.
	pub fainfo:       Option<Box<Aminfo>>,
	/// zsh `fromcomp`.
	pub fromcomp:     i32,
	/// zsh `lastend`.
	pub lastend:      i32,
	/// zsh `oldmenucmp` (static).
	pub oldmenucmp:   i32,
	/// zsh `parwb` (static).
	pub parwb:        i32,
	/// zsh `parwe` (static).
	pub parwe:        i32,
	/// zsh `paroffs` (static).
	pub paroffs:      i32,
	/// `permmatches`' static `fi`: the permanent lists hold only the
	/// matches `fignore` had ignored.
	pub fi:           i32,
	/// Where [`Self::curexpl`] went when `addexpl` put it on a group's
	/// `lexpls` (zsh's list holds the same `Cexpl`, so later counts go
	/// there): the group and index. Read it through [`curexpl_mut`].
	pub curexpl_at:   Option<(GId, usize)>,
	/// The groups allocated on zsh's heap during this completion
	/// (`begcmgroup`): freed by `do_completion`'s `popheap`.
	pub heapgroups:   Vec<GId>,
	/// `stat`s for `add_match_data` (zsh `ztat(pb, …)`), filled by
	/// `compadd` before it calls `addmatches`: metafied path →
	/// (`lstat` mode, `stat` mode), full `st_mode`; `None`/missing: failed.
	pub ztat_cache:   HashMap<BString, (Option<u32>, Option<u32>)>,
}
