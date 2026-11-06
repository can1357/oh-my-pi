//! The editor's display glue: what `zle_refresh.c` ([`super::refresh`])
//! needs from the shell (terminal capabilities, options, `$COLUMNS`,
//! prompts) and where its bytes go (SHTTY), plus the display widgets
//! (`clear-screen`, `redisplay`, `reset-prompt`), `zle -R`/`-I`, and the
//! widgets that read a key for display (`describe-key-briefly`,
//! `read-command`) or nest the editor (`recursive-edit`). During completion,
//! redisplay uses the working metafied line, not the saved editor text.

use std::sync::Arc;

use bstr::{BString, ByteSlice};

use super::{
	Editor, Zle,
	exec::{Await, Got, WResult, Zw, then},
	keymap::Bind,
	refresh::{self, Display, RefreshIn},
};
use crate::bash::{
	vm::{
		Cx, Kernel,
		builtins::{
			zsh_module,
			zsh_print::{prompt_env_ex, prompt_subst},
			zsh_prompt::{self, Cap, Expansion, NearColour, TermCaps},
		},
		expand::{Expander, X},
		proc::Vproc,
		state,
		zsh::{params, terminfo_db},
	},
	zshopt::ZshOpt,
};

/// The terminal capabilities of `$TERM` (zsh `init_term`), cached until
/// `$TERM` changes.
fn caps(ex: &mut Expander<'_, '_>, cache: &mut Option<(BString, Arc<TermCaps>)>) -> Arc<TermCaps> {
	let term = params::getsparam(ex, b"TERM")
		.ok()
		.flatten()
		.unwrap_or_default();
	if let Some((t, c)) = cache.as_ref()
		&& *t == term
	{
		return Arc::clone(c);
	}
	let get = |ex: &mut Expander<'_, '_>, n: &[u8]| params::getsparam(ex, n).ok().flatten();
	let terminfo = get(ex, b"TERMINFO");
	let dirs = get(ex, b"TERMINFO_DIRS");
	let home = get(ex, b"HOME");
	let env = terminfo_db::TermEnv {
		terminfo:      terminfo.as_deref().map(|v| v.as_slice()),
		terminfo_dirs: dirs.as_deref().map(|v| v.as_slice()),
		home:          home.as_deref().map(|v| v.as_slice()),
	};
	let c = Arc::new(TermCaps::load(&term, &env));
	*cache = Some((term, Arc::clone(&c)));
	c
}

/// Everything a refresh reads from the shell, owned so the editor can be
/// borrowed beside it.
struct Env {
	caps:             Arc<TermCaps>,
	columns:          i32,
	lines:            i32,
	singlelinezle:    bool,
	combiningchars:   bool,
	transientrprompt: bool,
	rprompt_indent:   i32,
	zle_highlight:    Option<Vec<BString>>,
	nearcolor:        Option<NearColour>,
	vicmd:            bool,
}

impl Env {
	fn input<'a>(&'a self, ed: &'a Editor) -> RefreshIn<'a> {
		RefreshIn {
			ed,
			term: &self.caps,
			columns: self.columns,
			lines: self.lines,
			singlelinezle: self.singlelinezle,
			combiningchars: self.combiningchars,
			transientrprompt: self.transientrprompt,
			rprompt_indent: self.rprompt_indent,
			zle_highlight: self.zle_highlight.as_deref(),
			nearcolor: self.nearcolor,
			pmpt_attr: ed.lprompt_attr,
			rpmpt_attr: ed.rprompt_attr,
			vicmd: self.vicmd,
			isearch: ed
				.ls
				.isearch_active
				.then(|| (to_i32(ed.ls.isearch.0), to_i32(ed.ls.isearch.1))),
			suffixlen: to_i32(ed.ls.suffixlen),
			postedit: None,
		}
	}
}

fn to_i32(n: usize) -> i32 {
	i32::try_from(n).unwrap_or(i32::MAX)
}

/// Read what a refresh needs (zsh reads it from globals).
fn env(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, zle: &mut Zle, ed: &Editor) -> Env {
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
	let mut cache = zle.tty.as_mut().and_then(|t| t.caps.take());
	let caps = caps(&mut ex, &mut cache);
	if let Some(t) = zle.tty.as_mut() {
		t.caps = cache;
	}
	let (tcols, tlines) = zle.tty.as_ref().map_or((80, 24), |t| t.size);
	let num = |ex: &mut Expander<'_, '_>, n: &[u8]| {
		params::getsparam(ex, n)
			.ok()
			.flatten()
			.map(|v| params::parse_int(&v))
	};
	let tcols = if tcols > 0 {
		tcols as i64
	} else if caps.tccolumns > 0 {
		i64::from(caps.tccolumns)
	} else {
		80
	};
	let tlines = if tlines > 0 {
		tlines as i64
	} else if caps.tclines > 0 {
		i64::from(caps.tclines)
	} else {
		24
	};
	let columns = num(&mut ex, b"COLUMNS").filter(|&c| c > 0).unwrap_or(tcols);
	let lines = num(&mut ex, b"LINES").filter(|&c| c > 0).unwrap_or(tlines);
	let rprompt_indent = num(&mut ex, b"ZLE_RPROMPT_INDENT").unwrap_or(1);
	let zle_highlight = params::getaparam(&mut ex, b"zle_highlight").ok().flatten();
	let nearcolor = zsh_module::loaded(ex.cx.store, ex.vp, b"zsh/nearcolor")
		.unwrap_or(false)
		.then_some(crate::bash::vm::builtins::zsh_mod_nearcolor::getnearestcolor as NearColour);
	let mut opt = |o| state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, o).unwrap_or(false);
	Env {
		caps,
		columns: i32::try_from(columns).unwrap_or(80),
		lines: i32::try_from(lines).unwrap_or(24),
		singlelinezle: opt(ZshOpt::Singlelinezle),
		combiningchars: opt(ZshOpt::Combiningchars),
		transientrprompt: opt(ZshOpt::Transientrprompt),
		rprompt_indent: i32::try_from(rprompt_indent).unwrap_or(1),
		zle_highlight,
		nearcolor,
		vicmd: super::exec::invicmdmode(&zle.keymaps, ed),
	}
}

/// The `PROMPT_SUBST` and `%` steps of zsh's `promptexpand(raw, ns = 1)`
/// for the line editor: `lastval` is `%?`, `cmdstack` is `%_`.
///
/// # Errors
/// [`crate::bash::vm::expand::Stop::ZshSub`] when a command substitution
/// must run first (callers that can run it replay through the
/// expander's log), a store failure.
pub fn expand_prompt(
	ex: &mut Expander<'_, '_>,
	raw: &[u8],
	lastval: i32,
	cmdstack: &[&'static str],
) -> X<Expansion> {
	let mut opt = |o| state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, o);
	let (percent, bang, subst) =
		(opt(ZshOpt::Promptpercent)?, opt(ZshOpt::Promptbang)?, opt(ZshOpt::Promptsubst)?);
	let text = if subst {
		prompt_subst(ex, raw)?
	} else {
		raw.to_vec()
	};
	let site = ex.k.zsh_site(ex.cx, ex.vp, ex.line);
	let mut env = prompt_env_ex(ex, site, percent, bang)?;
	env.lastval = lastval;
	env.cmdstack = cmdstack.to_vec();
	Ok(zsh_prompt::promptexpand_ns(&text, &env))
}

/// zsh `reexpandprompt`: the prompts expanded again (`%?` as when the line
/// started). A prompt whose expansion would run a command substitution
/// keeps its old expansion: the editor cannot run one in the middle of a
/// widget.
fn reexpandprompt(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, ed: &mut Editor) {
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
	// zsh's `raw_lp`/`raw_rp` point at the prompt parameters: a value
	// assigned since the line started (a hook's `RPS1=…; zle
	// reset-prompt`) is what is expanded.
	if let Some((l, r)) = ed.prompt_params {
		ed.raw_lp = params::getsparam(&mut ex, l)
			.ok()
			.flatten()
			.unwrap_or_default();
		ed.raw_rp = r
			.and_then(|r| params::getsparam(&mut ex, r).ok().flatten())
			.unwrap_or_default();
	}
	if let Ok(e) = expand_prompt(&mut ex, &ed.raw_lp, ed.pre_zle_status, &[]) {
		ed.lprompt = e.text;
		ed.lprompt_attr = e.txtattr;
	}
	if let Ok(e) = expand_prompt(&mut ex, &ed.raw_rp, ed.pre_zle_status, &[]) {
		ed.rprompt = e.text;
		ed.rprompt_attr = e.txtattr;
	}
}

/// What a display step needs, with the editor state borrowed apart.
fn with_display(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	zle: &mut Zle,
	ed: &mut Editor,
	f: impl FnOnce(&mut Display, &RefreshIn<'_>, &mut Vec<u8>) -> Option<refresh::RefreshOut>,
) {
	if ed.clearlist {
		zle.display.clearlist = true;
		ed.clearlist = false;
	}
	let e = env(k, cx, vp, zle, ed);
	if zle.display.needs_reexpand(&e.caps) {
		reexpandprompt(k, cx, vp, ed);
	}
	let mut out = Vec::new();
	if std::mem::take(&mut ed.feep) {
		// zsh `zbeep`: the bell, unless `nobeep`.
		if state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Beep).unwrap_or(true) {
			out.push(0x07);
		}
	}
	// Completion edits its metafied line while the editor retains the
	// pre-completion text. Diagnostics can refresh before completion ends;
	// zsh displays the working line (including quotes already removed).
	let saved_line = zle.comp.line.s.as_ref().map(|s| {
		let raw = crate::bash::syntax::zsh::tok::unmetafy(s);
		let line = super::to_line(&raw);
		let char_pos = |pos: usize| {
			super::to_line(&crate::bash::syntax::zsh::tok::unmetafy(&s[..pos.min(s.len())])).len()
		};
		let cs = std::mem::replace(&mut ed.cs, char_pos(zle.comp.line.cs));
		let mark = std::mem::replace(&mut ed.mark, char_pos(zle.comp.line.mark));
		(std::mem::replace(&mut ed.line, line), cs, mark)
	});
	let r = {
		let input = e.input(ed);
		f(&mut zle.display, &input, &mut out)
	};
	if let Some((line, cs, mark)) = saved_line {
		ed.line = line;
		ed.cs = cs;
		ed.mark = mark;
	}
	if let Some(tty) = zle.tty.as_mut() {
		if r.is_some_and(|r| r.setterm) || !tty.raw {
			let flow =
				state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Flowcontrol).unwrap_or(true);
			tty.zsetterm(k, cx, flow);
		}
		tty.put(&out);
	}
}

/// The terminal capabilities of the editing shell's `$TERM`.
pub(super) fn term_caps(zw: &mut Zw<'_, '_>) -> Arc<TermCaps> {
	let mut log = Vec::new();
	let mut ex = Expander::new(zw.k, zw.cx, zw.vp, &mut log, false, 0);
	let mut cache = zw.zle.tty.as_mut().and_then(|t| t.caps.take());
	let c = caps(&mut ex, &mut cache);
	if let Some(t) = zw.zle.tty.as_mut() {
		t.caps = cache;
	}
	c
}

/// zsh `zrefresh()` for the editor running a native step.
pub fn refresh(zw: &mut Zw<'_, '_>) {
	show_msg(zw);
	let mut list = false;
	with_display(zw.k, zw.cx, zw.vp, zw.zle, zw.ed, |d, i, out| {
		let r = refresh::zrefresh(d, i, out);
		list = r.list;
		Some(r)
	});
	if list {
		list_then_refresh(zw);
	}
}

/// The tail of zsh's `zrefresh` when it lists completions: `inlist = 1;
/// listmatches(); inlist = 0; zrefresh();`. A lister that waits (a
/// question, `LISTPROMPT`) is left in [`Editor::pending_list`] for the
/// task stack, which finishes this tail when it is done.
fn list_then_refresh(zw: &mut Zw<'_, '_>) {
	zw.zle.display.inlist = true;
	match super::comp::listmatches(zw) {
		WResult::Done(_) => list_tail(zw),
		WResult::Await(what, cont) => zw.ed.pending_list = Some((what, Box::new(ListCont(cont)))),
	}
}

/// After the listing: `inlist = 0`, redisplay, then the list's lines kept
/// (zsh's `if (showinglist == -1) showinglist = nlnct;` after the inner
/// `zrefresh()`: done before it, the trashed display's reset would turn
/// the count into `-2` and list again forever).
fn list_tail(zw: &mut Zw<'_, '_>) {
	zw.zle.display.inlist = false;
	refresh(zw);
	zw.zle.display.list_done();
}

/// A waiting lister: [`list_tail`] once it is done.
struct ListCont(Box<dyn super::exec::Cont>);

impl super::exec::Cont for ListCont {
	fn resume(self: Box<Self>, zw: &mut Zw<'_, '_>, got: super::exec::Got) -> WResult {
		match self.0.resume(zw, got) {
			WResult::Done(s) => {
				list_tail(zw);
				WResult::Done(s)
			},
			WResult::Await(what, cont) => WResult::Await(what, Box::new(Self(cont))),
		}
	}
}

/// zsh `showmsg`'s display part for the message queued in
/// [`Editor::msg`]: the display is given up, the message printed below
/// it (an owed beep first: zsh writes the bell unbuffered), and with
/// `ALWAYS_LAST_PROMPT` the cursor goes back up to the line, which the
/// next refresh then reuses.
pub fn show_msg(zw: &mut Zw<'_, '_>) {
	let Some(msg) = zw.ed.msg.take() else {
		return;
	};
	// The bell goes after the display is given up (zsh writes it
	// unbuffered between the two).
	let feep = std::mem::take(&mut zw.ed.feep);
	trashzle(zw);
	let alwayslast = zw.isset(ZshOpt::Alwayslastprompt);
	let usezle = zw.isset(ZshOpt::Zle);
	let mut log = Vec::new();
	let caps = {
		let mut ex = Expander::new(zw.k, zw.cx, zw.vp, &mut log, false, 0);
		let mut cache = zw.zle.tty.as_mut().and_then(|t| t.caps.take());
		let c = caps(&mut ex, &mut cache);
		if let Some(t) = zw.zle.tty.as_mut() {
			t.caps = cache;
		}
		c
	};
	let columns = zw
		.getsparam(b"COLUMNS")
		.map(|c| params::parse_int(&c))
		.filter(|&c| c > 0)
		.unwrap_or(80);
	let clearflag = usezle && caps.termflags == 0 && alwayslast;
	let mut out = Vec::new();
	if feep && zw.isset(ZshOpt::Beep) {
		out.push(0x07);
	}
	let mut up: i64 = 0;
	let mut cc: i64 = 0;
	for line in msg.split(|&c| c == b'\n').enumerate() {
		if line.0 > 0 {
			out.push(b'\n');
			up += 1 + cc / columns;
			cc = 0;
		}
		out.extend_from_slice(line.1);
		cc += line
			.1
			.chars()
			.map(|c| i64::from(crate::bash::vm::zsh::wcwidth::wcwidth(c).max(0)))
			.sum::<i64>();
	}
	up += cc / columns;
	if clearflag {
		out.push(b'\r');
		let ct = up + i64::from(zw.zle.display.nlnct);
		tcmultout(&caps, &mut out, Cap::Up, Cap::MultUp, ct);
	} else {
		out.push(b'\n');
	}
	zw.zle.display.showinglist = 0;
	zw.zle.display.clearflag = clearflag;
	if let Some(t) = zw.zle.tty.as_mut() {
		t.put(&out);
	}
}

/// zsh `tcmultout(cap, multcap, ct)`: move with the counted capability
/// when it is shorter, else repeat the single one.
pub(super) fn tcmultout(caps: &TermCaps, out: &mut Vec<u8>, cap: Cap, multcap: Cap, ct: i64) {
	if ct <= 0 {
		return;
	}
	let n = usize::try_from(ct).unwrap_or(0);
	if caps.tccan(multcap) && (!caps.tccan(cap) || caps.tclen(multcap) <= caps.tclen(cap) * n) {
		if let Some(s) = caps.tcstr[multcap as usize].as_deref() {
			let arg = i32::try_from(ct).unwrap_or(i32::MAX);
			out.extend_from_slice(&terminfo_db::tputs(&terminfo_db::tgoto(s, arg, arg)));
		}
	} else if caps.tccan(cap) {
		for _ in 0..n {
			out.extend_from_slice(&caps.tputs(cap));
		}
	}
}

/// zsh `trashzle()`: the line shown as it is, the cursor below it, the
/// terminal back in its normal modes (unless `ZLRF_NOSETTY`).
pub fn trashzle(zw: &mut Zw<'_, '_>) {
	if zw.ed.msg.is_some() {
		// zsh `showmsg` gave the display up already.
		show_msg(zw);
		return;
	}
	if zw.zle.display.trashedzle {
		return;
	}
	with_display(zw.k, zw.cx, zw.vp, zw.zle, zw.ed, |d, i, out| {
		refresh::trashzle(d, i, out);
		None
	});
	if zw.ed.flags & super::readflags::NOSETTY == 0
		&& let Some(tty) = zw.zle.tty.as_mut()
	{
		tty.settyinfo(zw.k, zw.cx);
	}
}

/// Run `f` on the vproc's editor with its state taken apart.
fn on_editor(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, f: impl FnOnce(&mut Zw<'_, '_>)) {
	let Some(mut zle) = vp.zle.take() else {
		return;
	};
	if let Some(mut ed) = zle.ed.take() {
		{
			let mut zw = Zw { k, cx, vp: &mut *vp, zle: &mut zle, ed: &mut ed, args: &[] };
			f(&mut zw);
		}
		zle.ed = Some(ed);
	}
	vp.zle = Some(zle);
}

/// `zle -R [-c] [status]` (zsh `bin_zle_refresh` without a list): show
/// `status` in the status line for this refresh and redisplay.
pub fn zle_refresh(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	status: Option<&[u8]>,
	clear: bool,
) {
	on_editor(k, cx, vp, |zw| {
		let saved = zw.ed.statusline.take();
		let ocl = zw.zle.display.clearlist;
		if let Some(s) = status.filter(|s| !s.is_empty()) {
			zw.ed.statusline = Some(BString::from(s));
		}
		if clear {
			zw.zle.display.clearlist = true;
			if status.is_none() {
				zw.zle.display.listshown = 1;
			}
			zw.zle.display.lastlistlen = 0;
		}
		refresh(zw);
		zw.zle.display.clearlist = ocl;
		zw.ed.statusline = saved;
		if let Some(tty) = zw.zle.tty.as_mut() {
			let _ = tty.flush(zw.k);
		}
	});
}

/// Output that comes while a line is being edited (zsh's asynchronous
/// job notices with `NOTIFY`): the display is given up, `bytes` written
/// to the terminal, and the line drawn again below them. `false` when no
/// line is being edited (or shell code runs for the editor), and the
/// caller writes the bytes itself.
pub fn print_above(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, bytes: &[u8]) -> bool {
	let editing = super::editor(vp)
		.is_some_and(|ed| ed.in_widget == 0 && ed.tasks.iter().any(|s| s.root.is_some()));
	if !editing || vp.zle.as_ref().is_none_or(|z| z.tty.is_none()) {
		return false;
	}
	on_editor(k, cx, vp, |zw| {
		trashzle(zw);
		if let Some(t) = zw.zle.tty.as_mut() {
			t.put(bytes);
		}
		refresh(zw);
		if let Some(t) = zw.zle.tty.as_mut() {
			let _ = t.flush(zw.k);
		}
	});
	true
}

/// zsh `zwarning`'s `ZLE_CMD_TRASH`: a diagnostic while the editor is
/// active, its standard error a terminal, gives the display up first (the
/// next refresh draws the line again).
pub fn trash_for_message(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	let live = vp
		.zle
		.as_ref()
		.is_some_and(|z| z.ed.is_some() && !z.display.trashedzle);
	if !live
		|| vp.fds.get(2).and_then(crate::bash::fd::FdRef::kind)
			!= Some(crate::bash::fs::FileKind::Tty)
	{
		return;
	}
	on_editor(k, cx, vp, |zw| {
		trashzle(zw);
		if let Some(tty) = zw.zle.tty.as_mut() {
			let _ = tty.flush(zw.k);
		}
	});
}

/// `zle -I` (zsh `bin_zle_invalidate`): give the display up for output;
/// the next refresh redraws the line.
pub fn invalidate(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	on_editor(k, cx, vp, |zw| {
		let was = zw.zle.display.trashedzle;
		trashzle(zw);
		if let Some(tty) = zw.zle.tty.as_mut() {
			if !was && zw.ed.flags & super::readflags::NOSETTY != 0 {
				tty.settyinfo(zw.k, zw.cx);
			}
			tty.fetch = true;
			let _ = tty.flush(zw.k);
		}
	});
}

/// The `clear-screen` widget (zsh `clearscreen`).
pub fn clear_screen(zw: &mut Zw<'_, '_>) -> WResult {
	with_display(zw.k, zw.cx, zw.vp, zw.zle, zw.ed, |d, i, out| {
		refresh::clearscreen(d, i, out);
		None
	});
	reexpandprompt(zw.k, zw.cx, zw.vp, zw.ed);
	WResult::Done(0)
}

/// The `redisplay` widget (zsh `redisplay`).
pub fn redisplay(zw: &mut Zw<'_, '_>) -> WResult {
	with_display(zw.k, zw.cx, zw.vp, zw.zle, zw.ed, |d, i, out| {
		refresh::redisplay(d, i, out);
		None
	});
	WResult::Done(0)
}

/// The `reset-prompt` widget (zsh `resetprompt`).
pub fn reset_prompt(zw: &mut Zw<'_, '_>) -> WResult {
	reexpandprompt(zw.k, zw.cx, zw.vp, zw.ed);
	redisplay(zw)
}

/// The `read-command` widget (zsh `readcommand`): the next key command's
/// widget name in `$REPLY`.
pub fn read_command(_zw: &mut Zw<'_, '_>) -> WResult {
	then(Await::Key, |zw, got| {
		let Got::Key(Some(name)) = got else {
			return WResult::Done(1);
		};
		let r = zw.params(|ex| params::assignsparam(ex, b"REPLY", &name, 0));
		WResult::Done(i32::from(r.is_err()))
	})
}

/// The `describe-key-briefly` widget (zsh `describekeybriefly`).
pub fn describe_key_briefly(zw: &mut Zw<'_, '_>) -> WResult {
	if zw.ed.statusline.is_some() {
		return WResult::Done(1);
	}
	zw.zle.display.clearlist = true;
	zw.ed.statusline = Some(BString::from("Describe key briefly: _"));
	refresh(zw);
	let visual = super::exec::invicmdmode(&zw.zle.keymaps, zw.ed)
		&& zw.ed.region_active != 0
		&& zw.zle.keymaps.exists(b"visual");
	if visual {
		zw.ed.localkeymap = Some(BString::from("visual"));
	}
	then(Await::Key, |zw, got| {
		zw.ed.localkeymap = None;
		zw.ed.statusline = None;
		let seq = zw.ed.keybuf.clone();
		if seq.is_empty() {
			return WResult::Done(1);
		}
		let mut msg = BString::from(super::utils::bindztrdup(&seq, false));
		msg.extend_from_slice(b" is ");
		let bound = zw.zle.keymaps.lookup(&zw.ed.keymap, &seq).cloned();
		match (bound, got) {
			(Some(Bind::Str(s)), _) => msg.extend_from_slice(&super::utils::bindztrdup(&s, false)),
			(_, Got::Key(Some(name))) => msg.extend_from_slice(&super::utils::nicedup(&name)),
			_ => msg.extend_from_slice(b"undefined-key"),
		}
		super::utils::showmsg(zw.ed, &msg);
		WResult::Done(0)
	})
}

/// The `recursive-edit` widget (zsh `recursiveedit`): edit in a nested
/// core loop until a widget ends it (`accept-line`, `send-break`); 1 when
/// it ended in an error.
pub fn recursive_edit(zw: &mut Zw<'_, '_>) -> WResult {
	zw.ed.recursive += 1;
	refresh(zw);
	then(Await::Recursive, |zw, _| {
		zw.ed.recursive = zw.ed.recursive.saturating_sub(1);
		let err = zw.ed.aborted;
		zw.ed.aborted = false;
		zw.ed.done = false;
		zw.ed.eofsent = false;
		WResult::Done(i32::from(err))
	})
}
