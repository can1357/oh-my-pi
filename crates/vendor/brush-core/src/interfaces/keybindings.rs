use std::{
	collections::HashMap,
	fmt::{self, Display, Formatter},
};

/// Represents an action that can be taken in response to a key sequence.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum KeyAction {
	/// Execute a shell command.
	ShellCommand(String),
	/// Execute an input "function".
	DoInputFunction(InputFunction),
	/// Execute a sequence of actions (in order).
	Sequence(Vec<Self>),
}

impl Display for KeyAction {
	fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
		match self {
			Self::ShellCommand(command) => write!(f, "shell command: {command}"),
			Self::DoInputFunction(function) => function.fmt(f),
			Self::Sequence(actions) => {
				write!(f, "sequence[")?;
				for (i, action) in actions.iter().enumerate() {
					if i > 0 {
						write!(f, ", ")?;
					}
					action.fmt(f)?;
				}
				write!(f, "]")
			},
		}
	}
}

/// Defines all input functions. Based on standard `readline` functions,
/// augmented with some `brush`-specific extensions.
#[derive(
	Clone,
	Debug,
	Eq,
	Hash,
	PartialEq,
	strum_macros::EnumString,
	strum_macros::Display,
	strum_macros::EnumIter,
	strum_macros::IntoStaticStr,
)]
#[strum(serialize_all = "kebab-case")]
#[expect(missing_docs)]
pub enum InputFunction {
	Abort,
	AcceptLine,
	AliasExpandLine,
	ArrowKeyPrefix,
	BackwardByte,
	BackwardChar,
	BackwardDeleteChar,
	BackwardKillLine,
	BackwardKillWord,
	BackwardWord,
	BashViComplete,
	BeginningOfHistory,
	BeginningOfLine,
	BracketedPasteBegin,
	BrushAcceptHint,
	BrushAcceptHintWord,
	CallLastKbdMacro,
	CapitalizeWord,
	CharacterSearch,
	CharacterSearchBackward,
	ClearDisplay,
	ClearScreen,
	Complete,
	CompleteCommand,
	CompleteFilename,
	CompleteHostname,
	CompleteIntoBraces,
	CompleteUsername,
	CompleteVariable,
	CopyBackwardWord,
	CopyForwardWord,
	CopyRegionAsKill,
	DabbrevExpand,
	DeleteChar,
	DeleteCharOrList,
	DeleteHorizontalSpace,
	DigitArgument,
	DisplayShellVersion,
	DoLowercaseVersion,
	DowncaseWord,
	DumpFunctions,
	DumpMacros,
	DumpVariables,
	DynamicCompleteHistory,
	EditAndExecuteCommand,
	EmacsEditingMode,
	EndKbdMacro,
	EndOfHistory,
	EndOfLine,
	ExchangePointAndMark,
	ExecuteNamedCommand,
	ExportCompletions,
	FetchHistory,
	ForwardBackwardDeleteChar,
	ForwardByte,
	ForwardChar,
	ForwardSearchHistory,
	ForwardWord,
	GlobCompleteWord,
	GlobExpandWord,
	GlobListExpansions,
	HistoryAndAliasExpandLine,
	HistoryExpandLine,
	HistorySearchBackward,
	HistorySearchForward,
	HistorySubstringSearchBackward,
	HistorySubstringSearchForward,
	InsertComment,
	InsertCompletions,
	InsertLastArgument,
	KillLine,
	KillRegion,
	KillWholeLine,
	KillWord,
	MagicSpace,
	MenuComplete,
	MenuCompleteBackward,
	NextHistory,
	NextScreenLine,
	NonIncrementalForwardSearchHistory,
	NonIncrementalForwardSearchHistoryAgain,
	NonIncrementalReverseSearchHistory,
	NonIncrementalReverseSearchHistoryAgain,
	OldMenuComplete,
	OperateAndGetNext,
	OverwriteMode,
	PossibleCommandCompletions,
	PossibleCompletions,
	PossibleFilenameCompletions,
	PossibleHostnameCompletions,
	PossibleUsernameCompletions,
	PossibleVariableCompletions,
	PreviousHistory,
	PreviousScreenLine,
	PrintLastKbdMacro,
	QuotedInsert,
	ReReadInitFile,
	RedrawCurrentLine,
	ReverseSearchHistory,
	RevertLine,
	SelfInsert,
	SetMark,
	ShellBackwardKillWord,
	ShellBackwardWord,
	ShellExpandLine,
	ShellForwardWord,
	ShellKillWord,
	ShellTransposeWords,
	SkipCsiSequence,
	SpellCorrectWord,
	StartKbdMacro,
	TabInsert,
	TildeExpand,
	TransposeChars,
	TransposeWords,
	TtyStatus,
	Undo,
	UniversalArgument,
	UnixFilenameRubout,
	UnixLineDiscard,
	UnixWordRubout,
	UpcaseWord,
	ViAppendEol,
	ViAppendMode,
	ViArgDigit,
	#[strum(serialize = "vi-bWord")]
	ViBWord,
	ViBackToIndent,
	ViBackwardBigword,
	ViBackwardWord,
	ViBword,
	ViChangeCase,
	ViChangeChar,
	ViChangeTo,
	ViCharSearch,
	ViColumn,
	ViComplete,
	ViDelete,
	ViDeleteTo,
	#[strum(serialize = "vi-eWord")]
	ViEWord,
	ViEditAndExecuteCommand,
	ViEditingMode,
	ViEndBigword,
	ViEndWord,
	ViEofMaybe,
	ViEword,
	#[strum(serialize = "vi-fWord")]
	ViFWord,
	ViFetchHistory,
	ViFirstPrint,
	ViForwardBigword,
	ViForwardWord,
	ViFword,
	ViGotoMark,
	ViInsertBeg,
	ViInsertionMode,
	ViMatch,
	ViMovementMode,
	ViNextWord,
	ViOverstrike,
	ViOverstrikeDelete,
	ViPrevWord,
	ViPut,
	ViRedo,
	ViReplace,
	ViRubout,
	ViSearch,
	ViSearchAgain,
	ViSetMark,
	ViSubst,
	ViTildeExpand,
	ViUndo,
	ViUnixWordRubout,
	ViYankArg,
	ViYankPop,
	ViYankTo,
	Yank,
	YankLastArg,
	YankNthArg,
	YankPop,
}

/// Represents a sequence of keys.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum KeySequence {
	/// Strokes that make up the sequence.
	Strokes(Vec<KeyStroke>),
	/// Raw bytes that were used to generate this sequence.
	Bytes(Vec<Vec<u8>>),
}

impl Display for KeySequence {
	fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
		match self {
			Self::Strokes(strokes) => {
				for stroke in strokes {
					stroke.fmt(f)?;
				}
			},
			Self::Bytes(bytes) => {
				for byte in bytes.iter().flatten() {
					if !byte.is_ascii_control() {
						write!(f, "{}", *byte as char)?;
					} else if *byte == b'\x1b' {
						write!(f, r"\e")?;
					} else if *byte >= 0x01 && *byte <= 0x1a {
						// Control characters: display as \C-<letter>
						let letter = (b'a' + (*byte - 1)) as char;
						write!(f, r"\C-{letter}")?;
					} else {
						write!(f, r"\x{byte:02x}")?;
					}
				}
			},
		}

		Ok(())
	}
}

impl From<KeyStroke> for KeySequence {
	/// Creates a new key sequence with a single stroke.
	fn from(value: KeyStroke) -> Self {
		Self::Strokes(vec![value])
	}
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
/// Represents a single key press.
pub struct KeyStroke {
	/// Alt key was pressed.
	pub alt:     bool,
	/// Control key was pressed.
	pub control: bool,
	/// Shift key was pressed.
	pub shift:   bool,
	/// Primary key pressed.
	pub key:     Key,
}

impl Display for KeyStroke {
	fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
		if self.alt {
			write!(f, "\\e")?;
		}
		if self.control {
			write!(f, "\\C-")?;
		}
		if self.shift {
			// TODO(input): Figure out what to do here or if the key encodes the
			// shift in it.
		}
		self.key.fmt(f)
	}
}

impl From<Key> for KeyStroke {
	/// Creates a new key stroke with a single key.
	fn from(value: Key) -> Self {
		Self { alt: false, control: false, shift: false, key: value }
	}
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
/// Represents a single key.
pub enum Key {
	/// A simple character key.
	Character(char),
	/// Backspace key.
	Backspace,
	/// Enter key.
	Enter,
	/// Left arrow key.
	Left,
	/// Right arrow key.
	Right,
	/// Up arrow key.
	Up,
	/// Down arrow key.
	Down,
	/// Home key.
	Home,
	/// End key.
	End,
	/// Page up key.
	PageUp,
	/// Page down key.
	PageDown,
	/// Tab key.
	Tab,
	/// Shift + Tab key.
	BackTab,
	/// Delete key.
	Delete,
	/// Insert key.
	Insert,
	/// F key.
	F(u8),
	/// Escape key.
	Escape,
}

impl Display for Key {
	fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
		match self {
			Self::Character(c @ ('\\' | '\"' | '\'')) => write!(f, "\\{c}")?,
			Self::Character(c) => write!(f, "{c}")?,
			Self::Backspace => write!(f, "Backspace")?,
			Self::Enter => write!(f, "Enter")?,
			Self::Left => write!(f, "Left")?,
			Self::Right => write!(f, "Right")?,
			Self::Up => write!(f, "Up")?,
			Self::Down => write!(f, "Down")?,
			Self::Home => write!(f, "Home")?,
			Self::End => write!(f, "End")?,
			Self::PageUp => write!(f, "PageUp")?,
			Self::PageDown => write!(f, "PageDown")?,
			Self::Tab => write!(f, "Tab")?,
			Self::BackTab => write!(f, "BackTab")?,
			Self::Delete => write!(f, "Delete")?,
			Self::Insert => write!(f, "Insert")?,
			Self::F(n) => write!(f, "F{n}")?,
			Self::Escape => write!(f, "Esc")?,
		}

		Ok(())
	}
}

/// Encapsulates the shell's interaction with key bindings for input.
pub trait KeyBindings: Send {
	/// Retrieves current bindings.
	fn get_current(&self) -> HashMap<KeySequence, KeyAction>;

	/// Tries to find a binding for an untranslated byte sequence.
	fn get_untranslated(&self, bytes: &[u8]) -> Option<&KeyAction>;

	/// Sets or updates a binding.
	///
	/// # Arguments
	///
	/// * `seq` - The key sequence to bind.
	/// * `action` - The action to bind to the sequence.
	fn bind(&mut self, seq: KeySequence, action: KeyAction) -> Result<(), std::io::Error>;

	/// Unbinds a key sequence. Returns true if a binding was removed.
	///
	/// # Arguments
	///
	/// * `seq` - The key sequence to unbind.
	fn try_unbind(&mut self, seq: KeySequence) -> bool;

	/// Defines a macro that remaps a key sequence to another key sequence.
	///
	/// # Arguments
	///
	/// * `seq` - The key sequence to bind the macro to.
	/// * `target` - The sequence that makes up the macro.
	fn define_macro(&mut self, seq: KeySequence, target: KeySequence) -> Result<(), std::io::Error>;

	/// Retrieves all defined macros.
	fn get_macros(&self) -> HashMap<KeySequence, KeySequence>;
}
