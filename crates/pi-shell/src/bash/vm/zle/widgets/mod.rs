//! The builtin widgets (zsh 5.9 `Src/Zle/iwidgets.list`): the table the
//! widget registry is built from ([`BUILTINS`], zsh's order and flags)
//! and the native implementations, grouped as zsh's sources group them.
//!
//! Each widget module has the widget functions ([`WidgetFn`]s, named as
//! zsh's C functions) and, where the widget only edits the line, the
//! function over [`super::Editor`] (and [`super::Zle`]) it runs, which the
//! tests drive directly.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

pub mod args;
pub mod edit;
pub mod hist_search;
pub mod isearch;
pub mod misc;
pub mod motion;
pub mod named;
pub mod stack;
pub mod textobjects;
pub mod vi;
pub mod vi_edit;
pub mod vi_move;
pub mod word;
pub mod yank;

use super::{
	comp::tricky,
	display,
	exec::WidgetFn,
	hist,
	wflags::{
		ISCOMP, KEEPSUFFIX, KILL, LASTCOL, LINEMOVE, MENUCMP, NOLAST, NOTCOMMAND, VIOPER, YANKAFTER,
		YANKBEFORE,
	},
};

/// A builtin widget: an entry of zsh's `iwidgets.list`.
#[derive(Clone, Copy, Debug)]
pub struct Builtin {
	/// The canonical name (also bound as `.name`, immortal).
	pub name:  &'static str,
	/// Its `ZLE_*` flags ([`super::wflags`]); the registry adds
	/// [`super::wflags::INT`].
	pub flags: u32,
	/// The implementation; `None` for widgets not ported yet (running one
	/// fails loudly).
	pub func:  Option<WidgetFn>,
}

/// One table entry.
const fn b(name: &'static str, flags: u32, func: Option<WidgetFn>) -> Builtin {
	Builtin { name, flags, func }
}

/// Every builtin widget, in `iwidgets.list` order. zsh has no function
/// for `accept-search`, `execute-named-cmd` and `execute-last-named-cmd`
/// (`isearch` and `getkeycmd` act on the names); run as widgets they
/// beep, as zsh's `execzlefunc` does for a widget without a function
/// ([`misc::nullwidget`]).
pub static BUILTINS: &[Builtin] = &[
	b("accept-and-hold", 0, Some(misc::acceptandhold)),
	b("accept-and-infer-next-history", 0, Some(hist_search::acceptandinfernexthistory)),
	b("accept-and-menu-complete", MENUCMP | KEEPSUFFIX, Some(tricky::acceptandmenucomplete)),
	b("accept-line", 0, Some(misc::acceptline)),
	b("accept-line-and-down-history", 0, Some(edit::acceptlineanddownhistory)),
	b("accept-search", 0, Some(misc::nullwidget)),
	b("argument-base", MENUCMP | KEEPSUFFIX | LASTCOL | NOTCOMMAND, Some(args::argumentbase)),
	b("auto-suffix-remove", NOTCOMMAND, Some(misc::handlesuffix)),
	b("auto-suffix-retain", KEEPSUFFIX | NOTCOMMAND, Some(misc::handlesuffix)),
	b("backward-char", 0, Some(motion::backwardchar)),
	b("backward-delete-char", KEEPSUFFIX, Some(misc::backwarddeletechar)),
	b("backward-delete-word", KEEPSUFFIX, Some(word::backwarddeleteword)),
	b("backward-kill-line", KILL | KEEPSUFFIX, Some(misc::backwardkillline)),
	b("backward-kill-word", KILL | KEEPSUFFIX, Some(word::backwardkillword)),
	b("backward-word", 0, Some(word::backwardword)),
	b("beep", 0, Some(misc::beep)),
	b("beginning-of-buffer-or-history", LINEMOVE, Some(motion::beginningofbufferorhistory)),
	b("beginning-of-history", 0, Some(hist::beginning_of_history)),
	b("beginning-of-line", 0, Some(motion::beginningofline)),
	b("beginning-of-line-hist", 0, Some(motion::beginningoflinehist)),
	b("bracketed-paste", MENUCMP | KEEPSUFFIX | YANKBEFORE, Some(yank::bracketedpaste)),
	b("capitalize-word", 0, Some(word::capitalizeword)),
	b("clear-screen", MENUCMP | KEEPSUFFIX | LASTCOL | NOTCOMMAND, Some(display::clear_screen)),
	b("complete-word", MENUCMP | KEEPSUFFIX | ISCOMP, Some(tricky::completeword)),
	b("copy-prev-word", KEEPSUFFIX, Some(edit::copyprevword)),
	b("copy-prev-shell-word", KEEPSUFFIX, Some(edit::copyprevshellword)),
	b("copy-region-as-kill", KEEPSUFFIX, Some(yank::copyregionaskill)),
	b("deactivate-region", 0, Some(edit::deactivateregion)),
	b("delete-char", KEEPSUFFIX, Some(misc::deletechar)),
	b("delete-char-or-list", MENUCMP | KEEPSUFFIX | ISCOMP, Some(tricky::deletecharorlist)),
	b("delete-word", KEEPSUFFIX, Some(word::deleteword)),
	b("describe-key-briefly", MENUCMP | KEEPSUFFIX | LASTCOL, Some(display::describe_key_briefly)),
	b("digit-argument", MENUCMP | KEEPSUFFIX | LASTCOL | NOTCOMMAND, Some(args::digitargument)),
	b("down-case-word", 0, Some(word::downcaseword)),
	b("down-history", 0, Some(hist::down_history)),
	b("down-line", LINEMOVE | LASTCOL, Some(motion::downline)),
	b("down-line-or-history", LINEMOVE | LASTCOL, Some(hist::down_line_or_history)),
	b("down-line-or-search", LINEMOVE | LASTCOL, Some(hist_search::downlineorsearch)),
	b("emacs-backward-word", 0, Some(word::emacsbackwardword)),
	b("emacs-forward-word", 0, Some(word::emacsforwardword)),
	b("end-of-buffer-or-history", LINEMOVE, Some(motion::endofbufferorhistory)),
	b("end-of-history", 0, Some(hist::end_of_history)),
	b("end-of-line", 0, Some(motion::endofline)),
	b("end-of-line-hist", 0, Some(motion::endoflinehist)),
	b("end-of-list", MENUCMP | KEEPSUFFIX | LASTCOL, Some(tricky::endoflist)),
	b("exchange-point-and-mark", 0, Some(motion::exchangepointandmark)),
	b("execute-last-named-cmd", 0, Some(misc::nullwidget)),
	b("execute-named-cmd", 0, Some(misc::nullwidget)),
	b("expand-cmd-path", 0, Some(tricky::expandcmdpath)),
	b("expand-history", 0, Some(edit::expandhistory)),
	b("expand-or-complete", MENUCMP | KEEPSUFFIX | ISCOMP, Some(tricky::expandorcomplete)),
	b(
		"expand-or-complete-prefix",
		MENUCMP | KEEPSUFFIX | ISCOMP,
		Some(tricky::expandorcompleteprefix),
	),
	b("expand-word", 0, Some(tricky::expandword)),
	b("forward-char", 0, Some(motion::forwardchar)),
	b("forward-word", 0, Some(word::forwardword)),
	b("get-line", 0, Some(stack::zgetline)),
	b("gosmacs-transpose-chars", 0, Some(edit::gosmacstransposechars)),
	b("history-beginning-search-backward", 0, Some(hist_search::historybeginningsearchbackward)),
	b("history-beginning-search-forward", 0, Some(hist_search::historybeginningsearchforward)),
	b("history-incremental-search-backward", 0, Some(isearch::historyincrementalsearchbackward)),
	b("history-incremental-search-forward", 0, Some(isearch::historyincrementalsearchforward)),
	b(
		"history-incremental-pattern-search-backward",
		0,
		Some(isearch::historyincrementalpatternsearchbackward),
	),
	b(
		"history-incremental-pattern-search-forward",
		0,
		Some(isearch::historyincrementalpatternsearchforward),
	),
	b("history-search-backward", 0, Some(hist_search::historysearchbackward)),
	b("history-search-forward", 0, Some(hist_search::historysearchforward)),
	b("infer-next-history", 0, Some(hist_search::infernexthistory)),
	b("insert-last-word", MENUCMP | KEEPSUFFIX, Some(hist_search::insertlastword)),
	b("kill-buffer", KILL | KEEPSUFFIX, Some(misc::killbuffer)),
	b("kill-line", KILL | KEEPSUFFIX, Some(misc::killline)),
	b("kill-region", KILL | KEEPSUFFIX, Some(yank::killregion)),
	b("kill-whole-line", KILL | KEEPSUFFIX, Some(misc::killwholeline)),
	b("kill-word", KILL | KEEPSUFFIX, Some(word::killword)),
	b("list-choices", MENUCMP | KEEPSUFFIX | LASTCOL | ISCOMP, Some(tricky::listchoices)),
	b("list-expand", MENUCMP | KEEPSUFFIX | LASTCOL, Some(tricky::listexpand)),
	b("magic-space", KEEPSUFFIX | MENUCMP, Some(misc::magicspace)),
	b("menu-complete", MENUCMP | KEEPSUFFIX | ISCOMP, Some(tricky::menucomplete)),
	b("menu-expand-or-complete", MENUCMP | KEEPSUFFIX | ISCOMP, Some(tricky::menuexpandorcomplete)),
	b("neg-argument", MENUCMP | KEEPSUFFIX | LASTCOL | NOTCOMMAND, Some(args::negargument)),
	b("overwrite-mode", 0, Some(misc::overwritemode)),
	b("pound-insert", 0, Some(edit::poundinsert)),
	b("push-input", 0, Some(stack::pushinput)),
	b("push-line", 0, Some(stack::pushline)),
	b("push-line-or-edit", 0, Some(stack::pushlineoredit)),
	b("put-replace-selection", KEEPSUFFIX, Some(vi_edit::putreplaceselection)),
	b("quoted-insert", MENUCMP | KEEPSUFFIX, Some(misc::quotedinsert)),
	b("quote-line", 0, Some(edit::quoteline)),
	b("quote-region", 0, Some(edit::quoteregion)),
	b("read-command", NOTCOMMAND, Some(display::read_command)),
	b("recursive-edit", MENUCMP | KEEPSUFFIX | LASTCOL, Some(display::recursive_edit)),
	b("redisplay", MENUCMP | KEEPSUFFIX | LASTCOL, Some(display::redisplay)),
	b("redo", KEEPSUFFIX, Some(misc::redo)),
	b(
		"reset-prompt",
		MENUCMP | KEEPSUFFIX | LASTCOL | NOTCOMMAND | NOLAST,
		Some(display::reset_prompt),
	),
	b("reverse-menu-complete", MENUCMP | KEEPSUFFIX | ISCOMP, Some(tricky::reversemenucomplete)),
	b("run-help", MENUCMP | KEEPSUFFIX | LASTCOL, Some(edit::processcmd)),
	b("select-a-word", KEEPSUFFIX, Some(textobjects::selectword)),
	b("select-in-word", KEEPSUFFIX, Some(textobjects::selectword)),
	b("select-a-blank-word", KEEPSUFFIX, Some(textobjects::selectword)),
	b("select-in-blank-word", KEEPSUFFIX, Some(textobjects::selectword)),
	b("select-a-shell-word", KEEPSUFFIX, Some(textobjects::selectargument)),
	b("select-in-shell-word", KEEPSUFFIX, Some(textobjects::selectargument)),
	b("self-insert", MENUCMP | KEEPSUFFIX, Some(misc::selfinsert)),
	b("self-insert-unmeta", MENUCMP | KEEPSUFFIX, Some(misc::selfinsertunmeta)),
	b("send-break", 0, Some(misc::sendbreak)),
	b("set-mark-command", MENUCMP | KEEPSUFFIX | LASTCOL, Some(motion::setmarkcommand)),
	b("split-undo", MENUCMP | KEEPSUFFIX | LASTCOL | NOTCOMMAND, Some(misc::splitundo)),
	b("spell-word", 0, Some(tricky::spellword)),
	b("set-local-history", LASTCOL, Some(hist_search::setlocalhistory)),
	b("transpose-chars", 0, Some(misc::transposechars)),
	b("transpose-words", 0, Some(word::transposewords)),
	b("undefined-key", 0, Some(misc::undefinedkey)),
	b("undo", KEEPSUFFIX, Some(misc::undo)),
	b(
		"universal-argument",
		MENUCMP | KEEPSUFFIX | LASTCOL | NOTCOMMAND,
		Some(args::universalargument),
	),
	b("up-case-word", 0, Some(word::upcaseword)),
	b("up-history", 0, Some(hist::up_history)),
	b("up-line", LINEMOVE | LASTCOL, Some(motion::upline)),
	b("up-line-or-history", LINEMOVE | LASTCOL, Some(hist::up_line_or_history)),
	b("up-line-or-search", LINEMOVE | LASTCOL, Some(hist_search::uplineorsearch)),
	b("vi-add-eol", 0, Some(vi::viaddeol)),
	b("vi-add-next", 0, Some(vi::viaddnext)),
	b("vi-backward-blank-word", 0, Some(vi_move::vibackwardblankword)),
	b("vi-backward-char", 0, Some(vi_move::vibackwardchar)),
	b("vi-backward-delete-char", KEEPSUFFIX, Some(vi_edit::vibackwarddeletechar)),
	b("vi-backward-kill-word", KEEPSUFFIX, Some(vi_edit::vibackwardkillword)),
	b("vi-backward-word", 0, Some(vi_move::vibackwardword)),
	b("vi-backward-word-end", 0, Some(vi_move::vibackwardwordend)),
	b("vi-backward-blank-word-end", 0, Some(vi_move::vibackwardblankwordend)),
	b("vi-beginning-of-line", 0, Some(vi_move::vibeginningofline)),
	b("vi-caps-lock-panic", LASTCOL, Some(vi_edit::vicapslockpanic)),
	b("vi-change", LASTCOL | VIOPER, Some(vi::vichange_widget)),
	b("vi-change-eol", 0, Some(vi::vichangeeol)),
	b("vi-change-whole-line", 0, Some(vi::vichangewholeline)),
	b("vi-cmd-mode", 0, Some(vi::vicmdmode)),
	b("vi-delete", KEEPSUFFIX | LASTCOL | VIOPER, Some(vi::videlete)),
	b("vi-delete-char", KEEPSUFFIX, Some(vi_edit::videletechar)),
	b("vi-digit-or-beginning-of-line", 0, Some(vi_edit::vidigitorbeginningofline)),
	b("vi-down-case", LASTCOL | VIOPER, Some(vi::vidowncase)),
	b("vi-down-line-or-history", LINEMOVE, Some(vi_move::vidownlineorhistory)),
	b("vi-end-of-line", LASTCOL, Some(vi_move::viendofline)),
	b("vi-fetch-history", LINEMOVE, Some(hist_search::vifetchhistory)),
	b("vi-find-next-char", 0, Some(vi_move::vifindnextchar)),
	b("vi-find-next-char-skip", 0, Some(vi_move::vifindnextcharskip)),
	b("vi-find-prev-char", 0, Some(vi_move::vifindprevchar)),
	b("vi-find-prev-char-skip", 0, Some(vi_move::vifindprevcharskip)),
	b("vi-first-non-blank", 0, Some(vi_move::vifirstnonblank)),
	b("vi-forward-blank-word", 0, Some(vi_move::viforwardblankword)),
	b("vi-forward-blank-word-end", 0, Some(vi_move::viforwardblankwordend)),
	b("vi-forward-char", 0, Some(vi_move::viforwardchar)),
	b("vi-forward-word", 0, Some(vi_move::viforwardword)),
	b("vi-forward-word-end", 0, Some(vi_move::viforwardwordend)),
	b("vi-goto-column", 0, Some(vi_move::vigotocolumn)),
	b("vi-goto-mark", 0, Some(vi_move::vigotomark)),
	b("vi-goto-mark-line", LINEMOVE, Some(vi_move::vigotomarkline)),
	b("vi-history-search-backward", 0, Some(hist_search::vihistorysearchbackward)),
	b("vi-history-search-forward", 0, Some(hist_search::vihistorysearchforward)),
	b("vi-indent", LASTCOL | VIOPER, Some(vi::viindent)),
	b("vi-insert", 0, Some(vi::viinsert)),
	b("vi-insert-bol", 0, Some(vi::viinsertbol)),
	b("vi-join", 0, Some(vi_edit::vijoin)),
	b("vi-kill-eol", KEEPSUFFIX, Some(vi_edit::vikilleol)),
	b("vi-kill-line", KEEPSUFFIX, Some(vi_edit::vikillline)),
	b("vi-match-bracket", 0, Some(vi_move::vimatchbracket)),
	b("vi-open-line-above", 0, Some(vi::viopenlineabove)),
	b("vi-open-line-below", 0, Some(vi::viopenlinebelow)),
	b("vi-oper-swap-case", LASTCOL | VIOPER, Some(vi::vioperswapcase)),
	b("vi-pound-insert", 0, Some(vi_edit::vipoundinsert)),
	b("vi-put-after", YANKAFTER | KEEPSUFFIX, Some(vi_edit::viputafter)),
	b("vi-put-before", YANKBEFORE | KEEPSUFFIX, Some(vi_edit::viputbefore)),
	b("vi-quoted-insert", MENUCMP | KEEPSUFFIX, Some(vi_edit::viquotedinsert)),
	b("vi-repeat-change", 0, Some(vi::virepeatchange)),
	b("vi-repeat-find", 0, Some(vi_move::virepeatfind)),
	b("vi-repeat-search", 0, Some(hist_search::virepeatsearch)),
	b("vi-replace", 0, Some(vi::vireplace)),
	b("vi-replace-chars", 0, Some(vi_edit::vireplacechars)),
	b("vi-rev-repeat-find", 0, Some(vi_move::virevrepeatfind)),
	b("vi-rev-repeat-search", 0, Some(hist_search::virevrepeatsearch)),
	b("vi-set-buffer", MENUCMP | KEEPSUFFIX | LASTCOL, Some(vi_edit::visetbuffer)),
	b("vi-set-mark", MENUCMP | KEEPSUFFIX | LASTCOL, Some(vi_move::visetmark)),
	b("vi-substitute", 0, Some(vi::visubstitute)),
	b("vi-swap-case", LASTCOL, Some(vi_edit::viswapcase)),
	b("vi-undo-change", KEEPSUFFIX, Some(vi_edit::viundochange)),
	b("vi-unindent", LASTCOL | VIOPER, Some(vi::viunindent)),
	b("vi-up-case", LASTCOL | VIOPER, Some(vi::viupcase)),
	b("vi-up-line-or-history", LINEMOVE, Some(vi_move::viuplineorhistory)),
	b("vi-yank", LASTCOL | VIOPER, Some(vi::viyank)),
	b("vi-yank-eol", 0, Some(vi_edit::viyankeol)),
	b("vi-yank-whole-line", 0, Some(vi_edit::viyankwholeline)),
	b("visual-line-mode", MENUCMP | LASTCOL, Some(vi_move::visuallinemode)),
	b("visual-mode", MENUCMP | LASTCOL, Some(vi_move::visualmode)),
	b("what-cursor-position", MENUCMP | KEEPSUFFIX | LASTCOL, Some(misc::whatcursorposition)),
	b("where-is", MENUCMP | KEEPSUFFIX | LASTCOL, Some(named::whereis)),
	b("which-command", MENUCMP | KEEPSUFFIX | LASTCOL, Some(edit::processcmd)),
	b("yank", YANKBEFORE | KEEPSUFFIX, Some(yank::yank)),
	b("yank-pop", KEEPSUFFIX | NOTCOMMAND, Some(yank::yankpop)),
];

/// The builtin widget named `name` (without the immortal dot).
pub fn builtin(name: &str) -> Option<&'static Builtin> {
	BUILTINS.iter().find(|b| b.name == name)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn table_matches_iwidgets_list() {
		assert_eq!(BUILTINS.len(), 193);
		assert_eq!(BUILTINS[0].name, "accept-and-hold");
		assert_eq!(BUILTINS[192].name, "yank-pop");
		let y = builtin("yank").map(|b| b.flags);
		assert_eq!(y, Some(YANKBEFORE | KEEPSUFFIX));
		let k = builtin("kill-line").map(|b| b.flags);
		assert_eq!(k, Some(KILL | KEEPSUFFIX));
		assert!(builtin("self-insert").is_some_and(|b| b.func.is_some()));
		assert!(builtin("no-such-widget").is_none());
	}
}
