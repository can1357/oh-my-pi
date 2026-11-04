//! The zsh line editor (zsh 5.9 `Src/Zle`): the editor state a vproc keeps
//! ([`Zle`]), the line being edited ([`Editor`]), and the modules that act
//! on them.
//!
//! ZLE runs inside the VM, never in the host: user widgets, hooks and
//! completion functions are shell functions run as frames of the vproc
//! that edits, so native code never re-enters shell code. Everything that
//! waits (a key, a widget function, a hook) is a step of the editor's task
//! stack ([`exec`]), driven by the interactive reader (`reader`), `vared`
//! and the `zle` builtin.
//!
//! State: [`Zle`] lives on its vproc ([`crate::bash::vm::proc::Vproc::zle`])
//! and is not imaged (a restored shell starts with zsh's default keymaps
//! and widgets, and no line in progress). A subshell starts with a copy
//! (zsh forks): keymaps and widgets are shared copy-on-write, the line in
//! progress is copied, the task stack is not.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

pub mod bindings;
pub mod bindkey;
pub mod builtin;
pub mod comp;
pub mod deltochar;
pub mod display;
pub mod exec;
pub mod hist;
pub mod keymap;
pub mod params;
pub mod reader;
pub mod refresh;
pub mod thingy;
pub mod tty;
pub mod undo;
pub mod utils;
pub mod vared;
pub mod widgets;

use std::{collections::VecDeque, sync::Arc};

use bstr::BString;

use crate::bash::{
	host::Timer,
	signal::Signal,
	vm::{Cx, Kernel, expand::Expander, proc::Vproc, zsh::params as zparams},
};

/// zsh `ZSH_INVALID_WCHAR_BASE`: a byte that is not part of a valid
/// character is kept in the line as this private-use character plus the
/// byte, so it converts back unchanged.
pub const INVALID_BASE: u32 = 0xe000;

/// The line character for byte `b` that does not decode.
pub const fn invalid_char(b: u8) -> char {
	// U+E000..=U+E0FF are valid scalar values.
	match char::from_u32(INVALID_BASE + b as u32) {
		Some(c) => c,
		None => char::REPLACEMENT_CHARACTER,
	}
}

/// The byte a [`invalid_char`] stands for, if `c` is one.
pub const fn invalid_byte(c: char) -> Option<u8> {
	let n = c as u32;
	if n >= INVALID_BASE && n <= INVALID_BASE + 255 {
		Some((n - INVALID_BASE) as u8)
	} else {
		None
	}
}

/// zsh `stringaszleline`: decode `s` (UTF-8 multibyte, the shell's
/// locale) into line characters; bytes that do not decode become
/// [`invalid_char`]s.
pub fn to_line(s: &[u8]) -> Vec<char> {
	let mut out = Vec::with_capacity(s.len());
	for chunk in s.utf8_chunks() {
		out.extend(chunk.valid().chars());
		out.extend(chunk.invalid().iter().map(|&b| invalid_char(b)));
	}
	out
}

/// zsh `zlelineasstring`: encode line characters back into bytes.
pub fn from_line(s: &[char]) -> BString {
	let mut out = Vec::with_capacity(s.len());
	let mut buf = [0u8; 4];
	for &c in s {
		match invalid_byte(c) {
			Some(b) => out.push(b),
			None => out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes()),
		}
	}
	BString::from(out)
}

/// Byte length of `s[..n]` once encoded ([`from_line`]): converts a
/// character offset into the byte offset zsh's metafied-line widgets use.
pub fn byte_len(s: &[char]) -> usize {
	s.iter()
		.map(|&c| {
			if invalid_byte(c).is_some() {
				1
			} else {
				c.len_utf8()
			}
		})
		.sum()
}

/// Widget flags (zsh `zle.h`: `WIDGET_*`, `ZLE_*`).
pub mod wflags {
	/// Internally implemented.
	pub const INT: u32 = 1 << 0;
	/// A completion widget (`zle -C`).
	pub const NCOMP: u32 = 1 << 1;
	/// Do not invalidate the completion list.
	pub const MENUCMP: u32 = 1 << 2;
	/// Yank after the cursor.
	pub const YANKAFTER: u32 = 1 << 3;
	/// Yank before the cursor.
	pub const YANKBEFORE: u32 = 1 << 4;
	/// A yank.
	pub const YANK: u32 = YANKAFTER | YANKBEFORE;
	/// A line-oriented movement.
	pub const LINEMOVE: u32 = 1 << 5;
	/// Reads further keys (a vi operator): wait if the key is a prefix.
	pub const VIOPER: u32 = 1 << 6;
	/// Keeps `lastcol` right.
	pub const LASTCOL: u32 = 1 << 7;
	/// A kill: consecutive kills append to the cut buffer.
	pub const KILL: u32 = 1 << 8;
	/// Do not remove an auto-added suffix.
	pub const KEEPSUFFIX: u32 = 1 << 9;
	/// Does not change `lastcmd`.
	pub const NOTCOMMAND: u32 = 1 << 10;
	/// Usable as the base of a completion widget.
	pub const ISCOMP: u32 = 1 << 11;
	/// Running.
	pub const INUSE: u32 = 1 << 12;
	/// Free when no longer running.
	pub const FREE: u32 = 1 << 13;
	/// Does not change the last widget (`LASTWIDGET`).
	pub const NOLAST: u32 = 1 << 14;
}

/// zsh `struct modifier`: the numeric argument and vi register prefix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Modifier {
	/// `MOD_*` flags ([`modflags`]).
	pub flags: u32,
	/// Repeat count.
	pub mult:  i64,
	/// Repeat count being typed.
	pub tmult: i64,
	/// vi register (0-35), with [`modflags::VIBUF`].
	pub vibuf: u32,
	/// Base of digit arguments.
	pub base:  u32,
}

impl Default for Modifier {
	/// zsh `initmodifier`.
	fn default() -> Self {
		Self { flags: 0, mult: 1, tmult: 1, vibuf: 0, base: 10 }
	}
}

/// `MOD_*` flags of a [`Modifier`].
pub mod modflags {
	/// A repeat count was given.
	pub const MULT: u32 = 1 << 0;
	/// A repeat count is being typed.
	pub const TMULT: u32 = 1 << 1;
	/// A vi register was selected.
	pub const VIBUF: u32 = 1 << 2;
	/// Append to the vi register.
	pub const VIAPP: u32 = 1 << 3;
	/// The last command was `neg-argument`.
	pub const NEG: u32 = 1 << 4;
	/// Discard text for the vi register (`"_`).
	pub const NULL: u32 = 1 << 5;
	/// Force character-wise movement.
	pub const CHAR: u32 = 1 << 6;
	/// Force line-wise movement.
	pub const LINE: u32 = 1 << 7;
}

/// zsh `struct cutbuffer`: killed text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CutBuffer {
	/// The text.
	pub buf:   Vec<char>,
	/// [`CUTBUFFER_LINE`]: whole lines (vi).
	pub flags: u32,
}

/// The cut buffer holds whole lines (vi line-wise kills).
pub const CUTBUFFER_LINE: u32 = 1;

/// Where `zleread` was called from (zsh `ZLCON_*`): `$CONTEXT`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Context {
	/// The first line of a command (`start`).
	#[default]
	LineStart,
	/// A continuation line (`cont`).
	LineCont,
	/// `vared` (`vared`).
	Vared,
}

impl Context {
	/// The `$CONTEXT` value.
	pub const fn name(self) -> &'static str {
		match self {
			Self::LineStart => "start",
			Self::LineCont => "cont",
			Self::Vared => "vared",
		}
	}
}

/// `zleread` flags (zsh `ZLRF_*`).
pub mod readflags {
	/// The line joins the history (`ZLRF_HISTORY`).
	pub const HISTORY: u32 = 1;
	/// Do not set up the terminal (`ZLRF_NOSETTY`, `vared -t`... ).
	pub const NOSETTY: u32 = 2;
	/// `ignoreeof`: EOF on an empty line does not end input.
	pub const IGNOREEOF: u32 = 4;
}

/// A `zle -F` handler: called when `fd` is readable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Watch {
	/// The fd (in the editing vproc's table).
	pub fd:     i32,
	/// The function or widget name.
	pub func:   BString,
	/// Called as a widget (`zle -Fw`).
	pub widget: bool,
}

/// The editor state of a vproc: what persists between lines (keymaps,
/// widgets, kill ring, buffer stack, `zle -F` handlers) and the line in
/// progress, if any.
pub struct Zle {
	/// The editor of the line being read (`zleactive`), `None` between
	/// lines.
	pub ed:           Option<Box<Editor>>,
	/// The keymaps (zsh `keymapnamtab`), shared copy-on-write.
	pub keymaps:      Arc<keymap::Keymaps>,
	/// The thingies and widgets (zsh `thingytab`), shared copy-on-write.
	pub widgets:      Arc<thingy::Widgets>,
	/// What the terminal shows (zsh `zle_refresh.c` state).
	pub display:      refresh::Display,
	/// The editing terminal, once opened.
	pub tty:          Option<tty::Tty>,
	/// zsh `cutbuf`: the last kill (`None`: never set).
	pub cutbuf:       Option<CutBuffer>,
	/// zsh `kring`: earlier kills, newest first.
	pub kring:        VecDeque<CutBuffer>,
	/// zsh `kringsize` (0 until the ring is first used).
	pub kring_size:   usize,
	/// zsh `kct`: the kill-ring entry the last `yank-pop` reached (`None`:
	/// the cut buffer).
	pub kct:          Option<usize>,
	/// vi registers `"a`–`"z`, `"0`–`"9` (zsh `vibuf`; `None`: unset).
	pub vibuf:        Vec<Option<CutBuffer>>,
	/// zsh `bufstack`: lines `push-line`, `print -z` and friends stacked
	/// for the next `zleread` (top last).
	pub bufstack:     Vec<BString>,
	/// zsh `kungetbuf` between lines: bytes read past the end of the last
	/// line's input, given to the next one.
	pub kunget:       VecDeque<u8>,
	/// zsh `stackcs`: the cursor the next line from the buffer stack gets.
	pub stack_cs:     Option<usize>,
	/// zsh `stackhist`: the history line the next one starts at.
	pub stack_hist:   Option<i64>,
	/// `zle -F` handlers, in the order they were added.
	pub watches:      Vec<Watch>,
	/// zsh `previous_search` / `$LASTSEARCH`.
	pub last_search:  BString,
	/// zsh `previous_aborted_search` / `$LASTABORTEDSEARCH`.
	pub last_aborted: BString,
	/// zsh `lastnamed`: the widget `execute-last-named-cmd` runs.
	pub lastnamed:    Option<BString>,
	/// The widget name the `execute-named-cmd` minibuffer read for the
	/// key reader (`None`: abandoned).
	pub named_result: Option<BString>,
	/// The history widgets' state kept between calls (zsh's statics in
	/// `zle_hist.c`).
	pub hsearch:      widgets::hist_search::SearchState,
	/// The interactive reader's state (root vproc of an interactive
	/// shell; never copied into subshells).
	pub reader:       Option<Box<reader::Reader>>,
	/// The completion state (zsh's completion globals).
	pub comp:         Box<comp::Comp>,
	/// vi mode state zsh keeps in globals (changes for
	/// `vi-repeat-change`, marks, the last find).
	pub vi:           widgets::vi::ViState,
}

impl Clone for Zle {
	/// The state a subshell starts with (zsh forks): the line in progress
	/// is copied without its pending tasks; the reader stays behind.
	fn clone(&self) -> Self {
		Self {
			ed:           self.ed.as_ref().map(|e| Box::new(e.fork())),
			keymaps:      Arc::clone(&self.keymaps),
			widgets:      Arc::clone(&self.widgets),
			display:      refresh::Display::default(),
			tty:          self.tty.clone(),
			cutbuf:       self.cutbuf.clone(),
			kring:        self.kring.clone(),
			kring_size:   self.kring_size,
			kct:          self.kct,
			vibuf:        self.vibuf.clone(),
			bufstack:     self.bufstack.clone(),
			kunget:       self.kunget.clone(),
			stack_cs:     self.stack_cs,
			stack_hist:   self.stack_hist,
			watches:      self.watches.clone(),
			last_search:  self.last_search.clone(),
			last_aborted: self.last_aborted.clone(),
			lastnamed:    self.lastnamed.clone(),
			named_result: None,
			hsearch:      self.hsearch.clone(),
			reader:       None,
			comp:         self.comp.clone(),
			vi:           self.vi.clone(),
		}
	}
}

impl Zle {
	/// zsh's `zsh/zle` boot: default keymaps (`main` linked to `viins`
	/// when `main_vi`), the builtin widgets, empty kill ring.
	pub fn new(main_vi: bool) -> Self {
		Self {
			ed:           None,
			keymaps:      Arc::new(keymap::Keymaps::new(main_vi)),
			widgets:      Arc::new(thingy::Widgets::default()),
			display:      refresh::Display::default(),
			tty:          None,
			cutbuf:       None,
			kring:        VecDeque::new(),
			kring_size:   0,
			kct:          None,
			vibuf:        vec![None; 36],
			bufstack:     Vec::new(),
			kunget:       VecDeque::new(),
			stack_cs:     None,
			stack_hist:   None,
			watches:      Vec::new(),
			last_search:  BString::default(),
			last_aborted: BString::default(),
			lastnamed:    None,
			named_result: None,
			hsearch:      widgets::hist_search::SearchState::default(),
			reader:       None,
			comp:         Box::default(),
			vi:           widgets::vi::ViState::default(),
		}
	}
}

/// The editor state of `vp`, created (zsh's `zsh/zle` boot) on first use:
/// `main` is linked to `viins` when `$VISUAL` (else `$EDITOR`) says vi
/// (zsh `default_bindings`).
pub fn zle_mut<'v>(k: &mut Kernel, cx: &mut Cx<'_>, vp: &'v mut Vproc) -> &'v mut Zle {
	if vp.zle.is_none() {
		let mut log = Vec::new();
		let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
		let visual = zparams::getsparam(&mut ex, b"VISUAL").ok().flatten();
		let editor = zparams::getsparam(&mut ex, b"EDITOR").ok().flatten();
		let vi = keymap::default_main_vi(
			visual.as_deref().map(|v| &v[..]),
			editor.as_deref().map(|v| &v[..]),
		);
		// zsh `setup_` of zsh/zle: the bracketed-paste strings (global).
		let bpaste = [BString::from("\x1b[?2004h"), BString::from("\x1b[?2004l")];
		let _ = zparams::assignaparam(&mut ex, b"zle_bracketed_paste", bpaste.to_vec(), 0);
		if let Err(err) = crate::bash::vm::builtins::zsh_module::ensure_loaded(k, cx, vp, b"zsh/zle")
		{
			k.fail(err);
		}
		vp.zle = Some(Box::new(Zle::new(vi)));
	}
	vp.zle.as_deref_mut().expect("just created")
}

/// The line editor is reading a line in `vp` (zsh `zleactive`).
pub fn active(vp: &Vproc) -> bool {
	vp.zle.as_ref().is_some_and(|z| z.ed.is_some())
}

/// The line being edited in `vp`, if any.
pub fn editor(vp: &Vproc) -> Option<&Editor> {
	vp.zle.as_ref()?.ed.as_deref()
}

/// The line being edited in `vp`, mutable.
pub fn editor_mut(vp: &mut Vproc) -> Option<&mut Editor> {
	vp.zle.as_mut()?.ed.as_deref_mut()
}

/// A signal delivered to the root vproc `vp` (`Shell::deliver`, before its
/// trap and default handling): `true` when the line editor consumed it.
/// `SIGWINCH` marks the size to be read again (and returns `false`: a
/// `WINCH` trap still runs); `SIGINT` without a trap abandons the line
/// being read (zsh's `errflag |= ERRFLAG_INT`, `$?` 130). (`TMOUT` is a
/// timer of the reader's, not `SIGALRM`.)
pub fn signal(vp: &mut Vproc, sig: Signal, trapped: bool) -> bool {
	let Some(z) = vp.zle.as_deref_mut() else {
		return false;
	};
	let consumed = match sig {
		Signal::Winch => {
			if let Some(r) = z.reader.as_deref_mut() {
				r.winch = true;
			}
			if let Some(ed) = z.ed.as_deref_mut() {
				ed.winch = true;
			}
			false
		},
		Signal::Int if !trapped => match z.ed.as_deref_mut() {
			Some(ed) => {
				ed.aborted = true;
				ed.interrupted = true;
				// Shell code running for the editor (a widget function) is
				// interrupted as any command is; the line goes after it.
				ed.in_widget == 0
			},
			None => z.reader.as_deref_mut().is_some_and(|r| {
				let reading = r.reading();
				if reading {
					r.interrupted = true;
				}
				reading
			}),
		},
		_ => false,
	};
	if consumed || sig == Signal::Winch {
		vp.blocked = None;
	}
	consumed
}

/// The line being edited and everything `zleread` keeps while it runs
/// (zsh's `zleline`, `zlecs`, `mark`, `zmod`, `lastcmd`, …).
pub struct Editor {
	/// zsh `zleline`: the line, one character per element.
	pub line:                Vec<char>,
	/// zsh `zlecs`: the cursor (a character index, `0..=line.len()`).
	pub cs:                  usize,
	/// zsh `mark`.
	pub mark:                usize,
	/// zsh `region_active`: 0 none, 1 character-wise, 2 line-wise.
	pub region_active:       u8,
	/// `$region_highlight` entries (user ones; zsh `region_highlights`
	/// past the special ones).
	pub region_highlights:   Vec<refresh::RegionHighlight>,
	/// `$CONTEXT`.
	pub context:             Context,
	/// [`readflags`].
	pub flags:               u32,
	/// zsh `isfirstln`: the first line of a command (EOF on an empty
	/// line ends input).
	pub isfirstln:           bool,
	/// The bytes of the key sequence of the widget running (`$KEYS`).
	pub keybuf:              Vec<u8>,
	/// zsh `lastchar`: the last byte read (`-1`: none, end of input).
	pub lastchar:            i32,
	/// zsh `lastchar_wide`: the last character read, when the bytes made
	/// a whole character (zsh `lastchar_wide_valid`).
	pub lastchar_wide:       Option<char>,
	/// zsh `zmod`.
	pub zmod:                Modifier,
	/// zsh `prefixflag`: the widget just run was a prefix (digit
	/// argument, register): `zmod` is kept for the next one.
	pub prefixflag:          bool,
	/// zsh `lastcmd`: the flags of the last widget run.
	pub lastcmd:             u32,
	/// zsh `bindk`: the widget running (`$WIDGET`).
	pub bindk:               Option<BString>,
	/// zsh `lbindk`: the last widget run (`$LASTWIDGET`).
	pub lbindk:              Option<BString>,
	/// zsh `insmode`: insert (not overwrite).
	pub insmode:             bool,
	/// zsh `done`: the line is accepted.
	pub done:                bool,
	/// zsh `eofsent`: EOF on an empty line.
	pub eofsent:             bool,
	/// zsh `errflag` within the editor: the line is abandoned
	/// (`send-break`, an interrupt, an input error).
	pub aborted:             bool,
	/// The line was abandoned by `SIGINT` (zsh `ERRFLAG_INT`).
	pub interrupted:         bool,
	/// Reading the terminal failed (zsh `getbyte`'s end of file or
	/// `error on TTY read`): the shell exits.
	pub tty_error:           Option<std::io::ErrorKind>,
	/// The terminal was resized: read its size and redisplay.
	pub winch:               bool,
	/// zsh `histline`: the history event being edited.
	pub histline:            i64,
	/// zsh `statusline` (`zle -M`, isearch prompts).
	pub statusline:          Option<BString>,
	/// `$PREDISPLAY`.
	pub predisplay:          Vec<char>,
	/// `$POSTDISPLAY`.
	pub postdisplay:         Vec<char>,
	/// The left prompt as expanded (`promptexpand` with markers), and
	/// the text it came from (re-expanded by `reset-prompt`).
	pub lprompt:             Vec<u8>,
	/// The right prompt, likewise.
	pub rprompt:             Vec<u8>,
	/// zsh `pmpt_attr`: the attributes the left prompt leaves on.
	pub lprompt_attr:        u64,
	/// zsh `rpmpt_attr`: the attributes the right prompt leaves on.
	pub rprompt_attr:        u64,
	/// The unexpanded left prompt (zsh `raw_lp`).
	pub raw_lp:              BString,
	/// The unexpanded right prompt (zsh `raw_rp`).
	pub raw_rp:              BString,
	/// The parameters the prompts come from (`PS1`/`RPS1`, `PS2`/`RPS2`),
	/// read again when the prompts are (zsh's `raw_lp`/`raw_rp` point at
	/// them; the right one only when it was set as the line started);
	/// `None` for prompts given as text (`vared -p`/`-r`).
	pub prompt_params:       Option<(&'static [u8], Option<&'static [u8]>)>,
	/// zsh `pre_zle_status`: `$?` when the line started (prompts show it).
	pub pre_zle_status:      i32,
	/// zsh `curkeymapname`: the keymap selected (`$KEYMAP`).
	pub keymap:              BString,
	/// zsh `localkeymap`: a keymap consulted before it, if any.
	pub localkeymap:         Option<BString>,
	/// Bytes to read before the terminal's (zsh `kungetbuf`): `bindkey
	/// -s` strings, `zle -U`, keys a widget gave back. Front first.
	pub unget:               VecDeque<u8>,
	/// zsh `keytimeout` (`$KEYTIMEOUT` when the line started, 1/100 s).
	pub keytimeout:          i64,
	/// The armed `KEYTIMEOUT` timer while a key sequence waits for its
	/// next byte.
	pub key_timer:           Option<Box<dyn Timer>>,
	/// The timer for the first zsh/sched event while a key is waited for,
	/// with the event time (epoch seconds) it was armed for.
	pub sched_timer:         Option<(i64, Box<dyn Timer>)>,
	/// The bytes a `read` builtin running in a widget has taken from the
	/// editor's input so far (kept while it waits; [`builtin::read_bytes`]).
	pub read_acc:            Option<Vec<u8>>,
	/// zsh `yankb`/`yanke`: the text the last yank inserted.
	pub yank:                (usize, usize),
	/// zsh `yanklast`: the last widget was a yank (`$YANK_ACTIVE`).
	pub yanklast:            bool,
	/// zsh `zle_recursive`: `recursive-edit` depth.
	pub recursive:           u32,
	/// zsh `vared` argument: the parameter being edited.
	pub varedarg:            Option<BString>,
	/// What `vared` restores when its edit ends.
	pub vared:               Option<Box<vared::VaredState>>,
	/// zsh `use_exit_printed`: ZLE showed the `ignoreeof` message.
	pub use_exit_printed:    bool,
	/// A beep is owed (zsh `handlefeep`): written at the next refresh.
	pub feep:                bool,
	/// A message `showmsg` gave, printed below the line before the next
	/// display update (zsh prints it at once).
	pub msg:                 Option<BString>,
	/// Hook widgets owed by native code (`zle-history-line-set`,
	/// `zle-keymap-select` with its argument): run by the core after the
	/// native step returns.
	pub hooks:               Vec<(BString, Option<BString>)>,
	/// zsh `hgetline()`: the earlier lines of the command being continued,
	/// handed to `push-line-or-edit`/`push-input` (which take it).
	pub hline:               Option<BString>,
	/// The undo history (zsh `changes`, `curchange`, …).
	pub undo:                undo::Undo,
	/// Per-line widget state (zsh `lastcol`, `vilinerange`, …).
	pub ls:                  utils::LineState,
	/// Shell functions running for this editor (`zle` from a widget
	/// function: zsh `sfcontext == SFC_WIDGET`).
	pub in_widget:           u32,
	/// zsh's `zle_text` of history entries: the edits made to each history
	/// line shown, by event number (dropped when the line ends, zsh
	/// `forget_edits`).
	pub hist_edits:          std::collections::HashMap<i64, BString>,
	/// zsh `clearlist`: the completion list below the line is to go at the
	/// next refresh.
	pub clearlist:           bool,
	/// The task stack ([`exec`]); never copied.
	pub(crate) tasks:        Vec<exec::Slot>,
	/// The answer the top task gets next ([`exec`]).
	pub(crate) got:          Option<exec::Got>,
	/// A completion listing zrefresh started that waits (zsh's
	/// `listmatches()` inside `zrefresh` asking a question): the task
	/// stack runs it next ([`exec::Task::Native`]).
	pub(crate) pending_list: Option<(exec::Await, Box<dyn exec::Cont>)>,
}

impl Editor {
	/// A fresh line (zsh `zleread` before its first key).
	pub fn new(context: Context, flags: u32) -> Self {
		Self {
			line: Vec::new(),
			cs: 0,
			mark: 0,
			region_active: 0,
			region_highlights: Vec::new(),
			context,
			flags,
			isfirstln: context != Context::LineCont,
			keybuf: Vec::new(),
			lastchar: -1,
			lastchar_wide: None,
			zmod: Modifier::default(),
			prefixflag: false,
			lastcmd: 0,
			bindk: None,
			lbindk: None,
			insmode: true,
			done: false,
			eofsent: false,
			aborted: false,
			interrupted: false,
			tty_error: None,
			winch: false,
			histline: 0,
			statusline: None,
			predisplay: Vec::new(),
			postdisplay: Vec::new(),
			lprompt: Vec::new(),
			rprompt: Vec::new(),
			lprompt_attr: 0,
			rprompt_attr: 0,
			raw_lp: BString::default(),
			raw_rp: BString::default(),
			prompt_params: None,
			pre_zle_status: 0,
			keymap: BString::from("main"),
			localkeymap: None,
			unget: VecDeque::new(),
			keytimeout: 40,
			key_timer: None,
			sched_timer: None,
			read_acc: None,
			yank: (0, 0),
			yanklast: false,
			recursive: 0,
			varedarg: None,
			vared: None,
			use_exit_printed: false,
			feep: false,
			msg: None,
			hooks: Vec::new(),
			hline: None,
			undo: undo::Undo::new(&[], 0),
			ls: utils::LineState::new(),
			in_widget: 0,
			hist_edits: std::collections::HashMap::new(),
			clearlist: false,
			tasks: Vec::new(),
			got: None,
			pending_list: None,
		}
	}

	/// The copy a subshell of a widget sees: the line and its state,
	/// without pending input or tasks.
	pub fn fork(&self) -> Self {
		let mut e = Self::new(self.context, self.flags);
		e.line.clone_from(&self.line);
		e.cs = self.cs;
		e.mark = self.mark;
		e.region_active = self.region_active;
		e.region_highlights.clone_from(&self.region_highlights);
		e.isfirstln = self.isfirstln;
		e.keybuf.clone_from(&self.keybuf);
		e.lastchar = self.lastchar;
		e.lastchar_wide = self.lastchar_wide;
		e.zmod = self.zmod;
		e.prefixflag = self.prefixflag;
		e.lastcmd = self.lastcmd;
		e.bindk.clone_from(&self.bindk);
		e.lbindk.clone_from(&self.lbindk);
		e.insmode = self.insmode;
		e.histline = self.histline;
		e.statusline.clone_from(&self.statusline);
		e.predisplay.clone_from(&self.predisplay);
		e.postdisplay.clone_from(&self.postdisplay);
		e.lprompt.clone_from(&self.lprompt);
		e.lprompt_attr = self.lprompt_attr;
		e.rprompt_attr = self.rprompt_attr;
		e.rprompt.clone_from(&self.rprompt);
		e.raw_lp.clone_from(&self.raw_lp);
		e.raw_rp.clone_from(&self.raw_rp);
		e.prompt_params = self.prompt_params;
		e.pre_zle_status = self.pre_zle_status;
		e.keymap.clone_from(&self.keymap);
		e.localkeymap.clone_from(&self.localkeymap);
		e.keytimeout = self.keytimeout;
		e.yank = self.yank;
		e.yanklast = self.yanklast;
		e.recursive = self.recursive;
		e.varedarg.clone_from(&self.varedarg);
		e.undo = undo::Undo::new(&self.line, self.cs);
		e.in_widget = self.in_widget;
		e
	}
}
