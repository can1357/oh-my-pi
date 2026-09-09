#![doc = include_str!("../README.md")]
#![warn(missing_docs)]
//!
//! The crate covers terminal lifecycle and capability detection, including
//! graphics protocol support and desktop notifications.

extern crate self as omp_tui;

/// Time-driven animation primitives: easing, tweens, and frame cycles.
pub mod anim;
/// Packaged assets.
pub mod assets;
mod color;
mod component;
/// Built-in layout, text, navigation, data, and input components.
pub mod components;
mod context;
mod debug;
mod editcore;
mod escape;
mod frame;
/// Word-local fuzzy matching shared by filterable lists.
pub mod fuzzy;
mod graphics;
mod icons;
/// Image format dimension probing without full decodes.
pub mod imagefmt;
mod imagereg;
mod input;
mod iterm2;
mod kitty;
pub mod latex;
pub mod markdown;
mod markup;
mod notify;
mod overlay;
/// Terminal protocol, dropped-path, and native clipboard paste handling.
pub mod paste;
mod props;
mod pump;
mod renderer;
mod rich;
mod runtime;
/// Raytraced braille scenes.
///
/// Provides vector math, an orbit camera, and a rasterizer.
pub mod scene;
/// CPU fragment-shader effects packed into half-block cells.
pub mod shader;
mod sixel;
/// Elastic speculative transcript slots and delivery transactions.
pub mod slots;
pub mod spelling;
pub mod syntax;
mod terminal;
#[doc(hidden)]
pub mod test_support;
mod theme;
mod tty;
/// Stable controlling-terminal identity helpers.
pub mod ttyid;
mod ui;
/// Parent-process watchdogs for terminal-owning applications.
pub mod watchdog;

pub use color::{CssColor, SystemColor};
pub use component::{
	Cached, Component, ElementFactory, Elements, EventCtx, Flow, Hit, HitTag, IntoChildren,
	IntoComponent, PaintCtx, Slot, next_slot,
};
pub use components::{
	ButtonVariant, DiffActionKind, DiffBuildOptions, DiffDocument, DiffPane, DiffPaneState,
	DiffPatchTarget, DiffSelection, DiffTarget, DiffWhitespaceMode, ViewMode,
};
pub use context::{Appearance, Charset, Graphics, Grid, JamoWidth, Theme, UiContext};
pub use debug::{FramePngError, frame_ansi, frame_png, frame_text, respond_debug_query};
pub use editcore::{
	BufferOutcome, Command, CommandArgument, CompletionEdit, EditBuffer, EditOutcome, Editor,
	EditorCompletion, EditorCompletion as Completion, EditorOptions, Picker, PickerRow,
	SlashCommands, Suggestion, SuggestionDisplay, SuggestionList, Suggestions, TabAction, VisualRow,
};
pub use frame::{
	Cell, CellContent, Color, Decor, DecorFill, DecorKind, Frame, Gradient, LinkId, Rect, RowMark,
	Size, Style, StyleSpec, Underline, with_link_url,
};
pub use graphics::{
	NotifyProtocol, ProbeParser, ProbeResults, TerminalCaps, TerminalId, TerminalPlatform, detect,
	detect_from, negotiate, negotiate_async, probe_terminal,
};
pub use icons::Icon;
pub use imagefmt::ImageFormat;
/// Returns registered PNG bytes for renderer-side image upload.
pub use imagereg::bytes as image_bytes;
/// Registers immutable renderer-local image bytes under an opaque TML source.
pub use imagereg::register as register_image_source;
/// Installs an application resolver for one `<img src>` URI scheme.
pub use imagereg::{
	SourceResolver as ImageSourceResolver, register_scheme as register_image_scheme,
};
pub use input::{
	Chord, InputDecoder, InputEvent, Key, KeyEvent, Keymap, Mods, Mouse, MouseButton, MouseReport,
	TerminalResponse, UiEvent, decode_keys,
};
pub use markup::{
	Border, Dim, MarkupOrigin, ParseError, parse_component_with_origin, parse_with_origin,
};
pub use notify::{
	Notification, NotificationAction, NotificationBuilder, NotificationSound, Urgency, notify,
	notify_desktop,
};
/// Builds a component tree from declarative markup.
pub use omp_macros::dom;
pub use overlay::{Layer, OverlayAnchor, OverlayBand, OverlayId, OverlayMargin, OverlayOptions};
pub use paste::{Pasted, PastedImage};
pub use props::{Prop, PropValue, Props};
pub use pump::{DebugOp, DebugQuery, TerminalEvent};
pub use renderer::{DeliveryError, OutputState, PaintStats, Renderer, file_link_target};
pub use rich::{
	Clip, Measure, Pipeline, Prefix, Prefixed, Restyle, RichSink, RichText, Rows, Tee, Wrap,
	cell_width, decompose,
};
pub use runtime::{App, AppEnv, AppEvent, AppOptions, ImageLoader, UiHandle, is_core_chord};
pub use spelling::{SpellingAssist, SpellingFeatures, SpellingResult, TypoRange};
pub use terminal::{AltScreenUse, CursorStyle, Progress, Terminal, TerminalOptions};
pub use theme::{
	JsonTheme, LoadedTheme, ThemeCatalog, ThemeError, ThemeLoadError, ThemeWarning,
	session_accent_color,
};
pub use tty::{TtyOut, overridden as tty_overridden};
pub use ui::Ui;
