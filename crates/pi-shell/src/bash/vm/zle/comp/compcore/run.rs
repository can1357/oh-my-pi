//! compcore.c: running a completion: `do_completion` (`zle_tricky.c`'s
//! entry once the line is metafied), the before/after hooks
//! (`before_complete`, `after_complete`), building the matches
//! (`makecomplist`) by calling the completion widget's function with the
//! completion parameters set up (`callcompfunc`) or through compctl.
//!
//! Everything that runs shell code or waits is continuation-passing
//! ([`K`]).

use bstr::BString;

use super::{
	super::{
		Comp, K, compctl, complete, complist,
		compresult::{
			do_allmatches, do_ambig_menu, do_ambiguous, do_menucmp, do_single, invalidate_list,
			suffix::fixsuffix,
		},
		qt, tricky,
		types::{Aminfo, Chdata, fc},
		with_ex,
	},
	begcmgroup, check_param, endcmgroup, freematches, multiquote, permmatches,
};
use crate::bash::{
	syntax::zsh::tok::untokenize,
	vm::{
		state,
		zle::{
			exec::{Await, Got, WResult, Zw, has_function, then},
			widgets::misc::self_insert,
		},
	},
	zshopt::ZshOpt,
};

/// zsh `strstr(s, w) != NULL`.
fn has(s: Option<&BString>, w: &[u8]) -> bool {
	s.is_some_and(|s| s.windows(w.len()).any(|x| x == w))
}

/// zsh `atoi`.
fn atoi(s: &[u8]) -> i32 {
	let s = s.trim_ascii_start();
	let (neg, s) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let n = s
		.iter()
		.take_while(|c| c.is_ascii_digit())
		.fold(0i64, |n, &d| (n * 10 + i64::from(d - b'0')) % (1 << 32));
	let n = if neg { -n } else { n };
	n as i32
}

/// zsh's `zlemetacs = 0; foredel(zlemetall); inststr(origline);
/// zlemetacs = origcs;`: the line as it was before completion.
fn restore_origline(c: &mut Comp) {
	c.line.cs = 0;
	let ll = c.line.ll();
	c.line.foredel(ll);
	let o = c.tricky.origline.clone().unwrap_or_default();
	c.line.inststrlen(&o, true);
	c.line.cs = usize::try_from(c.tricky.origcs).unwrap_or(0);
}

/// zsh's `unmetafy_line(); selfinsert(zlenoargs); metafy_line();`.
fn selfinsert_unmeta(zw: &mut Zw<'_, '_>) -> i32 {
	zw.zle.comp.line.unmetafy(zw.ed);
	let r = self_insert(zw.ed);
	zw.zle.comp.line.metafy(zw.ed);
	r
}

/// zsh `do_completion`: complete the word `s` (`incmd`: in command
/// position, `lst`: `zle_tricky.c`'s `COMP_*` kind) and do what
/// `compstate` says with the matches: insert one, the unambiguous
/// prefix, start menu completion, list. The line is metafied
/// ([`Comp::line`]). `k` gets zsh's return value.
pub fn do_completion(zw: &mut Zw<'_, '_>, s: BString, incmd: i32, lst: i32, k: K<i32>) -> WResult {
	let osl = zw.zle.display.showinglist;
	let recexact = zw.isset(ZshOpt::Recexact);
	let autolist = zw.isset(ZshOpt::Autolist);
	let bashautolist = zw.isset(ZshOpt::Bashautolist);
	let listambiguous = zw.isset(ZshOpt::Listambiguous);
	let alwayslastprompt = zw.isset(ZshOpt::Alwayslastprompt);
	let listrowsfirst = zw.isset(ZshOpt::Listrowsfirst);
	let listpacked = zw.isset(ZshOpt::Listpacked);
	let automenu = zw.isset(ZshOpt::Automenu);
	let alwaystoend = zw.isset(ZshOpt::Alwaystoend);
	let listmax = zw.getiparam(b"LISTMAX");
	let c = &mut *zw.zle.comp;
	// pushheap: groups begcmgroup allocates from here on are freed at
	// the end.
	c.core.heapgroups.clear();
	c.core.ainfo = None;
	c.core.fainfo = None;
	c.core.matchers.clear();
	let instring = u8::try_from(c.tricky.instring).unwrap_or(0);
	// Backslashes may need handling even when not in quotes.
	c.complete.compqstack = Some(BString::from(vec![if instring == qt::NONE {
		qt::BACKSLASH
	} else {
		instring
	}]));
	c.core.hasunqu = 0;
	c.core.useline = if c.tricky.wouldinstab != 0 {
		-1
	} else {
		i32::from(lst != tricky::COMP_LIST_COMPLETE)
	};
	c.core.useexact = i32::from(recexact);
	c.complete.compexactstr = Some(BString::default());
	c.core.uselist = if c.core.useline != 0 {
		if autolist && !bashautolist {
			if listambiguous { 3 } else { 2 }
		} else {
			0
		}
	} else {
		1
	};
	c.complete.comppatmatch = Some(BString::from(if c.tricky.useglob != 0 { "*" } else { "" }));
	let opm = c.complete.comppatmatch_gen;
	c.complete.comppatinsert = Some(BString::from("menu"));
	c.core.forcelist = 0;
	c.core.haspattern = 0;
	c.complete.complistmax = listmax;
	c.complete.complastprompt = Some(BString::from(if alwayslastprompt { "yes" } else { "" }));
	c.core.dolastprompt = 1;
	c.complete.complist = Some(BString::from(match (listrowsfirst, listpacked) {
		(true, true) => "packed rows",
		(true, false) => "rows",
		(false, true) => "packed",
		(false, false) => "",
	}));
	c.core.startauto = i32::from(automenu);
	c.core.movetoend = if i32::try_from(c.line.cs).ok() == Some(c.tricky.we) || alwaystoend {
		2
	} else {
		1
	};
	c.core.hasmatched = 0;
	c.core.hasunmatched = 0;
	c.core.minmlen = 1_000_000;
	c.core.maxmlen = -1;
	c.complete.compignored = 0;
	c.core.nmessages = 0;
	c.core.hasallmatch = 0;
	zw.zle.display.showinglist = 0;
	makecomplist(
		zw,
		s,
		incmd,
		lst,
		Box::new(move |zw, r| do_completion_result(zw, r, osl, opm, bashautolist, k)),
	)
}

/// The rest of [`do_completion`] once the matches are there.
fn do_completion_result(
	zw: &mut Zw<'_, '_>,
	mk: i32,
	osl: i32,
	opm: u32,
	bashautolist: bool,
	k: K<i32>,
) -> WResult {
	let c = &mut *zw.zle.comp;
	if mk != 0 {
		// Error condition: feeeeep().
		restore_origline(c);
		c.core.minfo.cur = None;
		zw.ed.clearlist = true;
		let ret = if c.core.useline < 0 {
			selfinsert_unmeta(zw)
		} else {
			1
		};
		return compend(zw, ret, k);
	}
	c.tricky.lastprebr = None;
	c.tricky.lastpostbr = None;
	if c
		.complete
		.comppatmatch
		.as_ref()
		.is_some_and(|p| !p.is_empty())
		&& c.complete.comppatmatch_gen != opm
	{
		c.core.haspattern = 1;
	}
	let (useline, uselist, nmatches, diffmatches) =
		(c.core.useline, c.core.uselist, c.core.nmatches, c.core.diffmatches);
	if c.core.iforcemenu != 0 {
		if nmatches != 0 {
			return do_ambig_menu(
				zw,
				Box::new(move |zw, ()| explain(zw, i32::from(zw.zle.comp.core.nmatches == 0), k)),
			);
		}
		return explain(zw, 1, k);
	}
	if useline < 0 {
		let ret = selfinsert_unmeta(zw);
		return explain(zw, ret, k);
	}
	if useline == 0 && uselist != 0 {
		// All this and the guy only wants to see the list, sigh.
		restore_origline(c);
		zw.zle.display.showinglist = -2;
		return explain(zw, 0, k);
	}
	if useline == 2 && nmatches > 1 {
		return do_allmatches(
			zw,
			1,
			Box::new(move |zw, ()| {
				zw.zle.comp.core.minfo.cur = None;
				if zw.zle.comp.core.forcelist != 0 {
					zw.zle.display.showinglist = -2;
				} else {
					invalidate_list(zw);
				}
				explain(zw, 0, k)
			}),
		);
	}
	if useline != 0 {
		if nmatches > 1 && diffmatches != 0 {
			// More than one match.
			return do_ambiguous(
				zw,
				Box::new(move |zw, ret| {
					let c = &zw.zle.comp;
					if zw.zle.display.showinglist == 0
						&& c.core.uselist != 0
						&& zw.zle.display.listshown != 0
						&& (c.tricky.usemenu == 2 || c.core.oldlist != 0)
					{
						zw.zle.display.showinglist = osl;
					}
					explain(zw, ret, k)
				}),
			);
		}
		if nmatches == 1 || (nmatches > 1 && diffmatches == 0) {
			// Only one match.
			let m = c
				.groups
				.list(c.core.amatches)
				.find(|&g| c.groups.get(g).mcount != 0)
				.and_then(|g| c.groups.get(g).matches.first().cloned())
				.expect("a group with the match");
			c.core.minfo.cur = None;
			c.core.minfo.asked = 0;
			return do_single(
				zw,
				m,
				Box::new(move |zw, ()| {
					if zw.zle.comp.core.forcelist != 0 {
						if zw.zle.comp.core.uselist != 0 {
							zw.zle.display.showinglist = -2;
						} else {
							zw.ed.clearlist = true;
						}
					} else {
						invalidate_list(zw);
					}
					explain(zw, 0, k)
				}),
			);
		}
		if c.core.nmessages != 0 && c.core.forcelist != 0 {
			if uselist != 0 {
				zw.zle.display.showinglist = -2;
			} else {
				zw.ed.clearlist = true;
			}
		}
		return explain(zw, 0, k);
	}
	invalidate_list(zw);
	let c = &mut *zw.zle.comp;
	c.tricky.lastambig = i32::from(bashautolist);
	if c.core.forcelist != 0 {
		zw.ed.clearlist = true;
	}
	restore_origline(c);
	explain(zw, 0, k)
}

/// The end of [`do_completion`]: list the explanation strings if needed.
fn explain(zw: &mut Zw<'_, '_>, ret: i32, k: K<i32>) -> WResult {
	let c = &mut *zw.zle.comp;
	if zw.zle.display.showinglist == 0
		&& c.tricky.validlist != 0
		&& c.tricky.usemenu != 2
		&& c.core.uselist != 0
		&& (c.core.nmatches != 1 || c.core.diffmatches != 0)
		&& c.core.useline >= 0
		&& c.core.useline != 2
		&& (c.core.oldlist == 0 || zw.zle.display.listshown == 0)
	{
		c.core.onlyexpl = 3;
		zw.zle.display.showinglist = -2;
	}
	compend(zw, ret, k)
}

/// zsh's `compend:` label: drop the matchers used, clamp the cursor,
/// `popheap()` (the heap groups and clines of this completion go).
fn compend(zw: &mut Zw<'_, '_>, ret: i32, k: K<i32>) -> WResult {
	let c = &mut *zw.zle.comp;
	c.core.matchers.clear();
	c.line.cs = c.line.cs.min(c.line.ll());
	for g in std::mem::take(&mut c.core.heapgroups) {
		c.groups.free(g);
	}
	c.core.mgroup = None;
	c.core.curexpl = None;
	c.core.curexpl_at = None;
	c.core.ainfo = None;
	c.core.fainfo = None;
	c.clines.clear();
	c.matcher.freecl = None;
	k(zw, ret)
}

/// zsh `before_complete` (runs before the line is metafied): go on with
/// a menu completion in progress (`k` gets 1: done), else maybe move the
/// cursor back after the last inserted string and start automenu (0).
pub fn before_complete(zw: &mut Zw<'_, '_>, lst: i32, k: K<i32>) -> WResult {
	let bashautolist = zw.isset(ZshOpt::Bashautolist);
	let c = &mut *zw.zle.comp;
	c.core.oldmenucmp = c.tricky.menucmp;
	if c.tricky.showagain != 0 && c.tricky.validlist != 0 {
		zw.zle.display.showinglist = -2;
	}
	c.tricky.showagain = 0;
	// A menu completion in progress.
	if c.core.minfo.cur.is_some() && c.tricky.menucmp != 0 && lst != tricky::COMP_LIST_EXPAND {
		return do_menucmp(zw, lst, Box::new(|zw, ()| k(zw, 1)));
	}
	if c.core.minfo.cur.is_some()
		&& c.tricky.menucmp != 0
		&& c.tricky.validlist != 0
		&& lst == tricky::COMP_LIST_COMPLETE
	{
		zw.zle.display.showinglist = -2;
		c.core.onlyexpl = 0;
		c.core.listdat.valid = false;
		return k(zw, 1);
	}
	// Back to the position after the string the last completion inserted.
	if u32::try_from(c.core.fromcomp).unwrap_or(0) & fc::INWORD != 0 {
		zw.ed.cs = usize::try_from(c.core.lastend)
			.unwrap_or(0)
			.min(zw.ed.line.len());
	}
	// Start a menu completion (automenu)?
	if c.core.startauto != 0 && c.tricky.lastambig != 0 && (!bashautolist || c.tricky.lastambig == 2)
	{
		c.tricky.usemenu = 2;
	}
	k(zw, 0)
}

/// zsh `after_complete`: when a menu completion just started, run
/// zsh/complist's `MENUSTARTHOOK` (menu selection). `dat1` is zsh's
/// `dat[1]`; `k` gets its new value.
pub fn after_complete(zw: &mut Zw<'_, '_>, dat1: i32, k: K<i32>) -> WResult {
	let c = &zw.zle.comp;
	if !(c.tricky.menucmp != 0 && c.core.oldmenucmp == 0) {
		return k(zw, dat1);
	}
	let cdat = Chdata {
		matches: c.core.amatches,
		num:     c.core.nmatches,
		nmesg:   c.core.nmessages,
		cur:     None,
	};
	let after = move |zw: &mut Zw<'_, '_>, ret: i32| {
		if ret == 0 {
			return k(zw, dat1);
		}
		let c = &mut *zw.zle.comp;
		c.tricky.menucmp = 0;
		c.core.menuacc = 0;
		c.core.minfo.cur = None;
		if ret >= 2 {
			fixsuffix(c, zw.ed);
			let c = &mut *zw.zle.comp;
			restore_origline(c);
			if ret == 2 {
				zw.ed.clearlist = true;
				invalidate_list(zw);
			}
		}
		k(zw, 0)
	};
	if complist::active(zw) {
		complist::domenuselect(zw, Some(cdat), Box::new(after))
	} else {
		after(zw, 0)
	}
}

/// zsh `callcompfunc`: call the completion widget's function `func`
/// with the completion special parameters set from the line state, then
/// read back what it left in `compstate`.
#[allow(clippy::too_many_lines, reason = "a direct port of zsh's callcompfunc")]
pub fn callcompfunc(zw: &mut Zw<'_, '_>, s: BString, func: BString, k: K<()>) -> WResult {
	if !has_function(zw, &func) {
		return k(zw, ());
	}
	let automenu = zw.isset(ZshOpt::Automenu);
	let completeinword = zw.isset(ZshOpt::Completeinword);
	let listpacked = zw.isset(ZshOpt::Listpacked);
	let listrowsfirst = zw.isset(ZshOpt::Listrowsfirst);
	let varedarg = zw.ed.varedarg.clone();
	let listshown = zw.zle.display.listshown;
	let s = s.to_vec();
	// Quoting and the prefix/suffix need the shell's options.
	fn q(ex: &mut crate::bash::vm::expand::Expander<'_, '_>, c: &Comp, t: &[u8]) -> BString {
		let mut t = if c.core.linwhat == tricky::IN_MATH {
			t.to_vec()
		} else {
			multiquote(ex, c, t, false).to_vec()
		};
		untokenize(&mut t);
		BString::from(t)
	}
	let (prefix, suffix) = with_ex(zw, |ex, c| {
		if completeinword {
			let o = usize::try_from(c.tricky.offs).unwrap_or(0).min(s.len());
			(q(ex, c, &s[..o]), q(ex, c, &s[o..]))
		} else {
			(q(ex, c, &s), BString::default())
		}
	});
	let c = &mut *zw.zle.comp;
	let icf = c.incompfunc;
	// zsh saves comprpms/compkpms: which params and keys exist.
	let saved = (c.complete.runset, c.complete.kunset, c.complete.kgone, c.complete.extra.clone());
	let rset = complete::CP_ALLREALS;
	let mut kset = complete::CP_ALLKEYS
		& !(complete::CP_PARAMETER
			| complete::CP_REDIRECT
			| complete::CP_QUOTE
			| complete::CP_QUOTING
			| complete::CP_EXACTSTR
			| complete::CP_OLDLIST
			| complete::CP_OLDINS
			| if c.tricky.useglob != 0 {
				0
			} else {
				complete::CP_PATMATCH
			});
	match varedarg {
		Some(v) => {
			c.complete.compvared = Some(v);
			kset |= complete::CP_VARED;
		},
		None => c.complete.compvared = Some(BString::default()),
	}
	if c
		.complete
		.complastprompt
		.as_ref()
		.is_none_or(|p| p.is_empty())
	{
		kset &= !complete::CP_LASTPROMPT;
	}
	let mut aadd = 0usize;
	let mut usea = true;
	let mut parameter: BString = BString::default();
	let mut redirect: BString = BString::default();
	let context: &str = if c.core.ispar != 0 {
		if c.core.ispar == 2 {
			"brace_parameter"
		} else {
			"parameter"
		}
	} else if c.core.linwhat == tricky::IN_PAR {
		"assign_parameter"
	} else if c.core.linwhat == tricky::IN_MATH {
		usea = false;
		if c.tricky.insubscr != 0 {
			if let Some(v) = &c.tricky.varname {
				parameter = v.clone();
				kset |= complete::CP_PARAMETER;
			}
			"subscript"
		} else {
			"math"
		}
	} else if c.tricky.lincmd != 0 {
		if c.tricky.insubscr != 0 {
			kset |= complete::CP_PARAMETER;
			"subscript"
		} else {
			"command"
		}
	} else if c.tricky.linredir != 0 {
		if let Some(r) = &c.tricky.rdstr {
			redirect = r.clone();
		}
		kset |= complete::CP_REDIRECT;
		"redirect"
	} else if c.core.linwhat == tricky::IN_ENV {
		parameter = c.tricky.varname.clone().unwrap_or_default();
		kset |= complete::CP_PARAMETER;
		if c.tricky.clwpos == 0 {
			c.tricky.clwpos = 1;
			c.tricky.clwnum = 2;
			c.tricky.clwords.resize(2, BString::default());
			c.tricky.clwords[1] = BString::from(s.clone());
		}
		aadd = 1;
		if c.tricky.linarr != 0 {
			"array_value"
		} else {
			"value"
		}
	} else if c.core.linwhat == tricky::IN_COND {
		"condition"
	} else if c.tricky.cmdstr.is_some() {
		"command"
	} else {
		kset |= complete::CP_PARAMETER;
		if let Some(w) = c.tricky.clwords.first() {
			parameter = w.clone();
		}
		aadd = 1;
		"value"
	};
	c.complete.compcontext = Some(BString::from(context));
	c.complete.compwords = if usea && (aadd == 0 || !c.tricky.clwords.is_empty()) {
		c.tricky
			.clwords
			.iter()
			.skip(aadd)
			.map(|w| {
				let mut w = w.to_vec();
				untokenize(&mut w);
				BString::from(w)
			})
			.collect()
	} else {
		Vec::new()
	};
	c.complete.compredirs = c.tricky.rdstrs.clone();
	let mut p = parameter.to_vec();
	untokenize(&mut p);
	c.complete.compparameter = Some(p.into());
	c.complete.compredirect = Some(redirect);
	let instring = u8::try_from(c.tricky.instring).unwrap_or(0);
	let (quote, quoting): (&str, &str) = if instring > qt::BACKSLASH {
		kset |= complete::CP_QUOTE | complete::CP_QUOTING;
		match instring {
			qt::SINGLE => ("'", "single"),
			qt::DOUBLE => ("\"", "double"),
			qt::DOLLARS => ("$'", "dollars"),
			_ => ("", ""),
		}
	} else if c.tricky.inbackt != 0 {
		kset |= complete::CP_QUOTE | complete::CP_QUOTING;
		("`", "backtick")
	} else {
		("", "")
	};
	c.complete.compquote = Some(quote.into());
	c.complete.compquoting = Some(quoting.into());
	c.complete.compprefix = Some(prefix.clone());
	c.complete.compsuffix = Some(suffix.clone());
	c.complete.complastprefix = Some(prefix);
	c.complete.complastsuffix = Some(suffix);
	if c.core.parwb < 0 {
		c.complete.compiprefix = Some(BString::default());
		c.complete.compisuffix = Some(BString::default());
	} else {
		let line = c.line.bytes();
		let cut = |a: i32, b: i32| {
			let a = usize::try_from(a).unwrap_or(0).min(line.len());
			let b = usize::try_from(b).unwrap_or(0).min(line.len()).max(a);
			BString::from(&line[a..b])
		};
		c.complete.compiprefix = Some(cut(c.core.parwb, c.tricky.wb));
		c.complete.compisuffix = Some(cut(c.tricky.we, c.core.parwe));
		c.tricky.wb = c.core.parwb;
		c.tricky.we = c.core.parwe;
		c.tricky.offs = c.core.paroffs;
	}
	c.complete.compqiprefix = Some(c.tricky.qipre.clone().unwrap_or_default());
	c.complete.compqisuffix = Some(c.tricky.qisuf.clone().unwrap_or_default());
	let l = |s: &Option<BString>| s.as_ref().map_or(0, |s| s.len());
	c.core.origlpre = i32::try_from(
		l(&c.complete.compqiprefix) + l(&c.complete.compiprefix) + l(&c.complete.compprefix),
	)
	.unwrap_or(i32::MAX);
	c.core.origlsuf = i32::try_from(
		l(&c.complete.compqisuffix) + l(&c.complete.compisuffix) + l(&c.complete.compsuffix),
	)
	.unwrap_or(i32::MAX);
	c.core.lenchanged = 0;
	c.complete.compcurrent = if usea {
		i64::from(c.tricky.clwpos) + 1 - i64::try_from(aadd).unwrap_or(0)
	} else {
		0
	};
	let mut complist: Vec<u8> = match c.core.uselist {
		1 => b"list".to_vec(),
		2 => b"autolist".to_vec(),
		3 => b"ambiguous".to_vec(),
		_ => {
			kset &= !complete::CP_LIST;
			Vec::new()
		},
	};
	if listpacked {
		complist.extend_from_slice(b" packed");
	}
	if listrowsfirst {
		complist.extend_from_slice(b" rows");
	}
	c.complete.complist = Some(complist.into());
	let insert: &str = if c.core.useline != 0 {
		match c.tricky.usemenu {
			0 => {
				if automenu {
					"automenu-unambiguous"
				} else {
					"unambiguous"
				}
			},
			1 => "menu",
			2 => "automenu",
			_ => "",
		}
	} else {
		kset &= !complete::CP_INSERT;
		""
	};
	c.complete.compinsert = Some(if c.core.useline < 0 {
		BString::from(format!("tab {insert}"))
	} else {
		BString::from(insert)
	});
	if c.core.useexact != 0 {
		c.complete.compexact = Some("accept".into());
	} else {
		c.complete.compexact = Some(BString::default());
		kset &= !complete::CP_EXACT;
	}
	c.complete.comptoend = Some(
		if c.core.movetoend == 1 {
			"single"
		} else {
			"match"
		}
		.into(),
	);
	if c.core.hasoldlist != 0 && c.core.lastpermmnum != 0 {
		c.complete.compoldlist = Some(if listshown != 0 { "shown" } else { "yes" }.into());
		kset |= complete::CP_OLDLIST;
		match c
			.core
			.minfo
			.cur
			.and_then(|r| c.groups.mat(r))
			.map(|m| m.gnum)
		{
			Some(gnum) if c.core.minfo.cur.is_some() => {
				c.complete.compoldins = Some(gnum.to_string().into());
				kset |= complete::CP_OLDINS;
			},
			_ => c.complete.compoldins = Some(BString::default()),
		}
	} else {
		c.complete.compoldlist = Some(BString::default());
		c.complete.compoldins = Some(BString::default());
	}
	c.incompfunc = 1;
	complete::makecompparams(c);
	complete::comp_setunset(
		c,
		rset,
		!rset & complete::CP_ALLREALS,
		kset,
		!kset & complete::CP_ALLKEYS,
	);
	let args = c.tricky.cfargs.clone();
	// makezleparams(1): the editor's parameters, read-only; no xtrace
	// for the function.
	zw.ed.in_widget += 1;
	let oxt = zw.isset(ZshOpt::Xtrace);
	let _ = state::set_zsh_option(&mut zw.k.root, zw.cx.store, zw.vp, ZshOpt::Xtrace, false);
	then(Await::Command { name: func, args }, move |zw, got| {
		let _ = state::set_zsh_option(&mut zw.k.root, zw.cx.store, zw.vp, ZshOpt::Xtrace, oxt);
		zw.ed.in_widget = zw.ed.in_widget.saturating_sub(1);
		zw.ed.lastcmd = 0;
		let bashlist_automenu = automenu;
		let c = &mut *zw.zle.comp;
		c.tricky.cfret = match got {
			Got::Status(s) => s,
			_ => 0,
		};
		c.incompfunc = icf;
		readback(c, bashlist_automenu);
		(c.complete.runset, c.complete.kunset, c.complete.kgone, c.complete.extra) = saved;
		k(zw, ())
	})
}

/// The end of [`callcompfunc`]: what `compstate` says now.
fn readback(c: &mut Comp, automenu: bool) {
	c.core.startauto = 0;
	let cl = &c.complete.complist;
	c.core.uselist = match cl {
		None => 0,
		Some(l) if l.starts_with(b"list") => 1,
		Some(l) if l.starts_with(b"auto") => 2,
		Some(l) if l.starts_with(b"ambig") => 3,
		Some(_) => 0,
	};
	c.core.forcelist = i32::from(has(cl.as_ref(), b"force"));
	c.core.onlyexpl = if cl.is_some() {
		i32::from(has(cl.as_ref(), b"expl")) | (i32::from(has(cl.as_ref(), b"messages")) << 1)
	} else {
		0
	};
	match c.complete.compinsert.clone() {
		None => c.core.useline = 0,
		Some(ins) if has(Some(&ins), b"tab") => c.core.useline = -1,
		Some(ins) if ins == "unambig" || ins == "unambiguous" || ins == "automenu-unambiguous" => {
			c.core.useline = 1;
			c.tricky.usemenu = 0;
		},
		Some(ins) if ins == "all" => {
			c.core.useline = 2;
			c.tricky.usemenu = 0;
		},
		Some(ins) if ins.first().is_some_and(u8::is_ascii_digit) => {
			c.core.useline = 1;
			c.tricky.usemenu = 3;
			c.core.insmnum = atoi(&ins);
			c.core.insspace = i32::from(ins.last() == Some(&b' '));
		},
		Some(ins) => {
			if ins.starts_with(b"menu") {
				c.core.useline = 1;
				c.tricky.usemenu = 1;
			} else if ins.starts_with(b"auto") {
				c.core.useline = 1;
				c.tricky.usemenu = 2;
			} else {
				c.core.useline = 0;
				c.tricky.usemenu = 0;
				// An emptied compstate[insert] never inserts the
				// unambiguous prefix: the next tab may start the menu.
				c.core.startauto = i32::from(automenu);
				c.tricky.lastambig = i32::from(automenu);
			}
			if c.core.useline != 0
				&& let Some(p) = ins.iter().position(|&ch| ch == b':')
			{
				c.core.insmnum = atoi(&ins[p + 1..]);
			}
		},
	}
	let ins = &c.complete.compinsert;
	c.core.startauto = i32::from(
		c.core.startauto != 0
			|| ins.as_ref().is_some_and(|i| i == "automenu-unambiguous")
			|| (c.tricky.bashlistfirst != 0 && automenu && ins.as_ref().is_none_or(|i| i.is_empty())),
	);
	c.core.useexact = i32::from(c.complete.compexact.as_ref().is_some_and(|e| e == "accept"));
	c.core.movetoend = match &c.complete.comptoend {
		None => 0,
		Some(t) if t.is_empty() => 0,
		Some(t) if t == "single" => 1,
		Some(t) if t == "always" => 3,
		Some(_) => 2,
	};
	c.core.oldlist = i32::from(
		c.core.hasoldlist != 0 && c.complete.compoldlist.as_ref().is_some_and(|o| o == "keep"),
	);
	c.core.oldins = i32::from(
		c.core.hasoldlist != 0
			&& c.core.minfo.cur.is_some()
			&& c.complete.compoldins.as_ref().is_some_and(|o| o == "keep"),
	);
}

/// zsh `makecomplist`: build the matches for the word `s`: through the
/// completion widget's function ([`callcompfunc`]) or, without one,
/// zsh/compctl's `COMPCTLMAKEHOOK`. `k` gets non-zero on error (no
/// matches).
pub fn makecomplist(zw: &mut Zw<'_, '_>, s: BString, incmd: i32, lst: i32, k: K<i32>) -> WResult {
	let mult = i32::try_from(zw.mult()).unwrap_or(1);
	let compctl_loaded = compctl::loaded(zw);
	let c = &mut *zw.zle.comp;
	let (owb, owe, ooffs) = (c.tricky.wb, c.tricky.we, c.tricky.offs);
	let compfunc = c.tricky.compfunc.clone();
	let mut s = s.to_vec();
	// Inside $...?
	let mut parwb = -1;
	if compfunc.is_some() {
		let mut t = s.clone();
		if let Some(b) = check_param(c, &mut t, false, false) {
			s = t[b..].to_vec();
			parwb = owb;
			c.core.parwe = owe;
			c.core.paroffs = ooffs;
		}
	}
	c.core.parwb = parwb;
	c.core.linwhat = c.tricky.inwhat;
	let Some(cf) = compfunc else {
		if !compctl_loaded {
			// No COMPCTLMAKEHOOK functions: dat.lst unchanged.
			return k(zw, lst);
		}
		return compctl::make(
			zw,
			BString::from(s),
			incmd,
			lst,
			Box::new(move |zw, r| {
				compctl::cleanup(&mut zw.zle.comp);
				k(zw, r)
			}),
		);
	};
	let (onm, odm) = (c.core.nmatches, c.core.diffmatches);
	c.core.bmatchers = None;
	c.core.mstack = None;
	c.core.ainfo = Some(Box::<Aminfo>::default());
	c.core.fainfo = Some(Box::<Aminfo>::default());
	c.matcher.freecl = None;
	if c.tricky.validlist == 0 {
		c.tricky.lastambig = 0;
	}
	c.core.amatches = None;
	c.core.mnum = 0;
	c.core.unambig_mnum = -1;
	c.core.isuf = None;
	c.core.insmnum = mult;
	c.core.oldlist = 0;
	c.core.oldins = 0;
	begcmgroup(c, Some(b"default"), 0);
	c.tricky.menucmp = 0;
	c.core.menuacc = 0;
	c.core.newmatches = 0;
	c.core.onlyexpl = 0;
	callcompfunc(
		zw,
		BString::from(s),
		cf,
		Box::new(move |zw, ()| {
			let compctl_loaded = compctl::loaded(zw);
			let c = &mut *zw.zle.comp;
			endcmgroup(c, None);
			// Needed for compcall.
			if compctl_loaded {
				compctl::cleanup(c);
			}
			if c.core.oldlist != 0 {
				c.core.nmatches = onm;
				c.core.diffmatches = odm;
				c.tricky.validlist = 1;
				c.core.amatches = c.core.lastmatches;
				c.core.lmatches = c.core.lastlmatches;
				if let Some(p) = c.core.pmatches.take() {
					freematches(c, Some(p), true);
					c.core.hasperm = 0;
				}
				return k(zw, 0);
			}
			if let Some(l) = c.core.lastmatches.take() {
				freematches(c, Some(l), true);
			}
			with_ex(zw, |ex, c| permmatches(ex, c, 1));
			let c = &mut *zw.zle.comp;
			c.core.amatches = c.core.pmatches;
			c.core.lastpermmnum = c.core.permmnum;
			c.core.lastpermgnum = c.core.permgnum;
			c.core.lastmatches = c.core.pmatches;
			c.core.lastlmatches = c.core.lmatches;
			c.core.pmatches = None;
			c.core.hasperm = 0;
			c.core.hasoldlist = 1;
			if (c.core.nmatches != 0 || c.core.nmessages != 0) && !zw.ed.aborted {
				c.tricky.validlist = 1;
				return k(zw, 0);
			}
			k(zw, 1)
		}),
	)
}
