#![warn(missing_docs)]
//! Projection-only interactive actor over the OMP session patch stream.

/// Observer-local exact-account usage refresh lifecycle.
pub mod account_usage;
/// Console commands the interactive actor executes locally.
pub mod actions;
/// Composer autocomplete providers.
pub mod autocomplete;
/// Typed tool cards.
pub mod cards;
/// Codex quota-reset celebration detector.
pub mod celebrate;
/// Boot chrome: welcome banner, status band, composer shell.
pub mod chrome;
/// Slash-command registry (`cmd!` declarations + palette metadata).
pub mod commands;
/// Observer-local composer.
pub mod composer;
/// External editor resolution and temporary-draft round trips.
pub mod editor;
/// Observer-local extension and hook status feed.
pub mod extension_status;
/// Journal-derived tool-card gallery.
pub mod gallery;
/// Live git branch/dirty facts for the status band.
pub mod gitwatch;
/// Durable, searchable prompt history.
pub mod history;
/// Interactive terminal actor.
pub mod host;
/// Terminal input and command bindings.
pub mod input;
/// Renderer-faithful Markdown facts (the hyperlinks a message draws).
pub mod markdown;
/// Bounded, typed normalization for composer-staged media.
pub mod media;
/// Transcript notices, maintenance dividers, usage rows, and the vocalizer.
pub mod notices;
/// Desktop notifications on turn completion, error, and pending questions.
pub mod notify;
/// Observer-local overlays.
pub mod overlays;
/// Pure session-DOM transcript projection.
pub mod project;
/// Agent reactions: an emoji line opening a reply badges the prompt before it.
pub mod reaction;
/// Presentation and interaction setting convars.
pub mod settings;
/// Composer status band.
pub mod status_band;
/// DOM-derived status values.
pub mod status_line;
/// Reasoning text prepared for display (prose-only filter).
pub mod thinking;
/// Retained transcript ledger and observer-local transcript facts.
pub mod transcript;
/// Welcome banner.
pub mod welcome;

pub use actions::{HostAction, HostMailbox, SttFailureKind, SttUiEvent};
pub use chrome::ModelBadge;
pub use extension_status::{ExtensionStatus, ExtensionStatuses};
pub use host::{
	CtrlCAction, Host, HostCommand, HostError, HostOptions, InitialPanel, LocalFacts, NativeEffect,
	NativeHost, NativeOverlay, PendingInputGate, UpEvent, ctrl_c_action, render_surface,
};
pub use overlays::{ModelRow, PickerEvent};
pub use project::{BlockKind, BlockView, block_views};
