//! Terminal multiplexer registry: how omp recognizes each multiplexer that may
//! host the process and the facts it adapts to inside one.
//!
//! Classification precedence: explicit session markers (`session` tier) are
//! authoritative; a `tmux`/`screen` `TERM` prefix comes next because TERM can
//! survive when the markers are stripped (`sudo` without -E, `su`,
//! env-sanitizing launchers/ssh); outer applications (`outerApp` tier, Orca)
//! rank last so a multiplexer running inside them wins.

use super::{Env, Platform, tmux};

/// Terminal multiplexers omp recognizes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Multiplexer {
	Herdr,
	Tmux,
	Screen,
	Zellij,
	Cmux,
	Wmux,
	Orca,
}

impl Multiplexer {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Herdr => "herdr",
			Self::Tmux => "tmux",
			Self::Screen => "screen",
			Self::Zellij => "zellij",
			Self::Cmux => "cmux",
			Self::Wmux => "wmux",
			Self::Orca => "orca",
		}
	}

	pub fn parse(name: &str) -> Option<Self> {
		REGISTRY
			.iter()
			.map(|module| module.id)
			.find(|id| id.as_str() == name)
	}

	pub fn module(self) -> &'static Module {
		REGISTRY
			.iter()
			.find(|module| module.id == self)
			.expect("every multiplexer has a registry entry")
	}

	/// Whether an explicit session marker identifies this multiplexer. TERM is
	/// intentionally excluded: it is a classification fallback, not proof that
	/// a particular session owns the current grid.
	pub fn is_inside(self, env: &Env) -> bool {
		match self {
			// Identity vars survive env-sanitizing launchers that drop HERDR_ENV.
			// Client-only socket, binary, session, and config overrides are not
			// proof that this process runs inside a pane.
			Self::Herdr => {
				env.get("HERDR_ENV") == Some("1")
					|| env.set("HERDR_PANE_ID")
					|| env.set("HERDR_TAB_ID")
					|| env.set("HERDR_WORKSPACE_ID")
			},
			Self::Tmux => env.set("TMUX"),
			Self::Screen => env.set("STY"),
			Self::Zellij => env.set("ZELLIJ"),
			// CMUX_SOCKET_PATH is a CLI socket override and can be set outside a
			// CMUX terminal.
			Self::Cmux => {
				env.set("CMUX_WORKSPACE_ID")
					|| env.set("CMUX_SURFACE_ID")
					|| env.set("CMUX_REMOTE_TRANSPORT")
			},
			// WMUX_CLI / WMUX_PIPE are CLI path overrides and can be set outside a
			// wmux terminal.
			Self::Wmux => env.get("WMUX") == Some("1") || env.set("WMUX_SURFACE_ID"),
			Self::Orca => {
				let set = |key| env.get(key).is_some_and(|value| !value.trim().is_empty());
				set("ORCA_PANE_KEY") && set("ORCA_WORKTREE_ID")
			},
		}
	}
}

/// Classification tier. `Session` markers outrank the TERM fallback;
/// `OuterApp` hosts rank below it so a multiplexer nested inside them still
/// wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Precedence {
	Session,
	OuterApp,
}

/// Notification delivery tier, tried in this order so the innermost target
/// wins: a `Pane` notifier addresses the exact pane through the multiplexer's
/// CLI, a `Surface` notifier addresses the containing app surface, and an
/// `InBand` notifier rewrites the terminal's own notification sequence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum NotifierTier {
	Pane,
	Surface,
	InBand,
}

/// OSC 8 handling inside a multiplexer session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HyperlinkPolicy {
	/// The multiplexer draws and opens links itself, so links work whatever
	/// the outer terminal supports, unless another session with a hyperlink
	/// policy sits in the path.
	Render,
	/// Never forwards OSC 8; its session anywhere in the path disables links.
	Drop,
	/// Forwards OSC 8 once it self-reports
	/// (`TERM_PROGRAM`/`TERM_PROGRAM_VERSION`) at least `major.minor`; older or
	/// unreported versions stay off.
	Forward { term_program: &'static str, major: u32, minor: u32 },
}

/// A multiplexer that answers OSC 11 from a cached copy of the outer
/// terminal's background color.
#[derive(Clone, Copy, Debug)]
pub struct BackgroundColorCache {
	/// Wrap a query so it reaches the outer terminal and refreshes the cache.
	pub passthrough: fn(&str) -> String,
	/// How long the multiplexer needs to store the outer reply before the
	/// cache is re-read.
	pub settle_ms:   f64,
}

/// Everything omp needs to recognize one terminal multiplexer and adapt to it.
#[derive(Debug)]
pub struct Module {
	pub id: Multiplexer,
	pub precedence: Precedence,
	/// Every environment variable [`Multiplexer::is_inside`] reads.
	pub session_env_keys: &'static [&'static str],
	/// Lowercase TERM prefix that identifies the multiplexer when its session
	/// markers were stripped.
	pub term_prefix: Option<&'static str>,
	/// The multiplexer owns the screen grid: rendering takes the multiplexer
	/// path (no scrollback rebuild, anchored resize, skipped probes).
	pub owns_screen_grid: bool,
	/// Routes notifications the multiplexer would otherwise swallow.
	pub notifier: Option<NotifierTier>,
	/// OSC 8 policy inside a session; unset defers to the outer terminal.
	pub hyperlinks: Option<HyperlinkPolicy>,
	/// The pane's VTE honors DEC 2026 even when DECRQM is unanswered or reports
	/// the mode unrecognized (status 0): synchronized output starts on inside a
	/// session, and an unrecognized report does not turn it off.
	pub honors_synchronized_output: bool,
	/// Tracks DEC 2004 per pane and forwards paste markers only while it is
	/// set, yet may leave DECRQM 2004 unanswered, so bracketed paste is
	/// reasserted without waiting for a DECRPM confirmation.
	pub gates_bracketed_paste: bool,
	/// The session does not reveal whether its client renders graphics while
	/// outer-terminal identity variables leak in, so images and Kitty
	/// placeholders stay off unless the user forces them.
	pub images_require_override: bool,
	/// Platforms where the multiplexer breaks OSC 11 passthrough, so host
	/// appearance is used instead.
	pub background_query_broken_on: &'static [Platform],
	/// Present when OSC 11 replies come from a cache an explicit refresh must
	/// update first.
	pub background_color_cache: Option<BackgroundColorCache>,
	/// Expands REP into identical styled cells, so destructive replays
	/// REP-encode their padding.
	pub expands_rep_padding: bool,
	/// Expires a synchronized update after a deadline, so large rebuild
	/// replays renew DEC 2026 as they stream.
	pub expires_synchronized_output: bool,
	/// Restoring the alternate buffer schedules a redraw that ends a
	/// synchronized update early, so a synchronized resize rebuild stays on
	/// the main buffer.
	pub alt_restore_ends_synchronized_output: bool,
	/// May grow its grid before SIGWINCH reaches the app, so a rebuild-mode
	/// grow whose full viewport no longer reaches the bottom replays history.
	pub grows_before_sigwinch: bool,
}

impl Module {
	const fn new(id: Multiplexer, session_env_keys: &'static [&'static str]) -> Self {
		Self {
			id,
			precedence: Precedence::Session,
			session_env_keys,
			term_prefix: None,
			owns_screen_grid: true,
			notifier: None,
			hyperlinks: None,
			honors_synchronized_output: false,
			gates_bracketed_paste: false,
			images_require_override: false,
			background_query_broken_on: &[],
			background_color_cache: None,
			expands_rep_padding: false,
			expires_synchronized_output: false,
			alt_restore_ends_synchronized_output: false,
			grows_before_sigwinch: false,
		}
	}

	pub fn is_inside(&self, env: &Env) -> bool {
		self.id.is_inside(env)
	}
}

/// Every multiplexer omp recognizes, in classification order within each
/// precedence tier. Adding a multiplexer means adding its module here.
pub static REGISTRY: [Module; 7] = [
	Module {
		// Herdr multiplexes panes like tmux but swallows bare OSC 9 / OSC 99 and
		// has no DCS passthrough envelope, and its bell relay does not flag a
		// backgrounded tab — so without its CLI a backgrounded pane gets no
		// signal at all that the agent finished or is waiting for input.
		notifier: Some(NotifierTier::Pane),
		// Herdr hides the outer terminal (`TERM=xterm-256color`, no
		// `TERM_PROGRAM`), but renders OSC 8 in its own grid and opens links
		// itself on Ctrl+click.
		hyperlinks: Some(HyperlinkPolicy::Render),
		// The pane VTE is libghostty and suppresses compositing while DEC 2026
		// is set. Without sync, CUP-diff paints and split write(2) chunks
		// composite as dirty-row patches: the live viewport tears, its top
		// frozen while only the bottom refreshes.
		honors_synchronized_output: true,
		// The pane marker does not prove the client enabled Herdr's
		// experimental Kitty renderer, and leaked outer-terminal identities
		// cannot either.
		images_require_override: true,
		..Module::new(Multiplexer::Herdr, &[
			"HERDR_ENV",
			"HERDR_PANE_ID",
			"HERDR_TAB_ID",
			"HERDR_WORKSPACE_ID",
		])
	},
	Module {
		term_prefix: Some("tmux"),
		// tmux swallows bare OSCs; passthrough preserves the toast and BEL flags
		// the pane.
		notifier: Some(NotifierTier::InBand),
		// tmux 3.4 stores OSC 8 as a cell attribute and forwards it to outer
		// terminals whose `terminal-features` include `hyperlinks`; it
		// self-reports via TERM_PROGRAM/TERM_PROGRAM_VERSION since 3.2a.
		hyperlinks: Some(HyperlinkPolicy::Forward {
			term_program: "tmux",
			major:        3,
			minor:        4,
		}),
		// An explicit appearance refresh passes OSC 11 to the outer terminal,
		// then re-reads tmux's cache once it has consumed the reply.
		background_color_cache: Some(BackgroundColorCache {
			passthrough: tmux::wrap_passthrough,
			settle_ms:   100.0,
		}),
		// tmux drops paste markers for a pane whose own DEC 2004 flag another
		// writer cleared, and only answers DECRQM 2004 since 3.6.
		gates_bracketed_paste: true,
		expands_rep_padding: true,
		// tmux expires synchronized output after one second.
		expires_synchronized_output: true,
		alt_restore_ends_synchronized_output: true,
		grows_before_sigwinch: true,
		..Module::new(Multiplexer::Tmux, &["TMUX"])
	},
	Module {
		term_prefix: Some("screen"),
		// GNU screen never gained OSC 8 support, so a screen layer anywhere in
		// the path vetoes hyperlinks, even under a nested tmux.
		hyperlinks: Some(HyperlinkPolicy::Drop),
		..Module::new(Multiplexer::Screen, &["STY"])
	},
	Module {
		// Zellij drops OSCs and has no DCS passthrough; a bare BEL raises its
		// bell flag.
		notifier: Some(NotifierTier::InBand),
		// Zellij currently breaks OSC 11 passthrough on macOS, so
		// terminal-derived appearance cannot be trusted there.
		background_query_broken_on: &[Platform::Darwin],
		..Module::new(Multiplexer::Zellij, &["ZELLIJ"])
	},
	Module {
		// Workspace/socket state alone is not enough: only the injected surface
		// UUID identifies the pane that should receive the notification.
		notifier: Some(NotifierTier::Surface),
		..Module::new(Multiplexer::Cmux, &[
			"CMUX_WORKSPACE_ID",
			"CMUX_SURFACE_ID",
			"CMUX_REMOTE_TRANSPORT",
		])
	},
	// wmux is a Windows multiplexer (Electron + xterm.js) modeled on
	// cmux/herdr that repaints its pane in place.
	Module::new(Multiplexer::Wmux, &["WMUX", "WMUX_SURFACE_ID"]),
	// Orca is an xterm.js-based IDE whose terminals expose paired
	// pane/worktree IDs. It is recognized for launches, but it ranks below
	// nested multiplexers and keeps the direct-terminal render path it used
	// before it was recognized.
	Module {
		precedence: Precedence::OuterApp,
		owns_screen_grid: false,
		..Module::new(Multiplexer::Orca, &["ORCA_PANE_KEY", "ORCA_WORKTREE_ID"])
	},
];

/// Every environment variable multiplexer classification reads, including the
/// TERM fallback.
pub fn env_keys() -> impl Iterator<Item = &'static str> {
	REGISTRY
		.iter()
		.flat_map(|module| module.session_env_keys.iter().copied())
		.chain(["TERM"])
}

/// Every multiplexer whose explicit session markers are present, in registry
/// order. Nested sessions all appear; TERM is not consulted.
pub fn sessions(env: &Env) -> impl Iterator<Item = &'static Module> + '_ {
	REGISTRY.iter().filter(move |module| module.is_inside(env))
}

/// The multiplexer TERM names, whether or not its session markers survived.
pub fn for_term(env: &Env) -> Option<&'static Module> {
	let term = env.get("TERM").unwrap_or_default().to_ascii_lowercase();
	REGISTRY.iter().find(|module| {
		module
			.term_prefix
			.is_some_and(|prefix| term.starts_with(prefix))
	})
}

/// Registry entry for the multiplexer hosting the current process, or `None`
/// for a direct terminal.
pub fn classify(env: &Env) -> Option<&'static Module> {
	let in_tier = |tier| {
		REGISTRY
			.iter()
			.find(|module| module.precedence == tier && module.is_inside(env))
	};
	in_tier(Precedence::Session)
		.or_else(|| for_term(env))
		.or_else(|| in_tier(Precedence::OuterApp))
}

/// True when the classified multiplexer owns the current screen grid.
pub fn is_inside_any(env: &Env) -> bool {
	classify(env).is_some_and(|module| module.owns_screen_grid)
}

/// Whether OSC 11 background replies are trusted on this platform. Any active
/// session that breaks the query on `platform` makes the entire path
/// untrusted; TERM-only classification does not identify an active session.
pub fn background_query_trusted(env: &Env, platform: Platform) -> bool {
	!sessions(env).any(|module| module.background_query_broken_on.contains(&platform))
}

/// Notifiers of the active sessions, innermost tier first: a pane inside a
/// surface must receive its own signal before the containing surface,
/// followed by in-band rewrites. Registry order breaks ties within a tier.
pub fn notifiers(env: &Env) -> Vec<(Multiplexer, NotifierTier)> {
	let mut notifiers: Vec<_> = sessions(env)
		.filter_map(|module| module.notifier.map(|tier| (module.id, tier)))
		.collect();
	notifiers.sort_by_key(|&(_, tier)| tier);
	notifiers
}

#[cfg(test)]
mod tests {
	use super::*;

	fn inside(id: Multiplexer, pairs: &[(&str, &str)]) -> bool {
		id.is_inside(&Env::of(pairs))
	}

	fn classified(pairs: &[(&str, &str)]) -> Option<&'static str> {
		classify(&Env::of(pairs)).map(|module| module.id.as_str())
	}

	#[test]
	fn herdr_session_identity_ignores_client_only_settings() {
		assert!(inside(Multiplexer::Herdr, &[("HERDR_ENV", "1")]));
		for key in ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"] {
			assert!(inside(Multiplexer::Herdr, &[(key, "x")]));
			assert!(!inside(Multiplexer::Herdr, &[(key, "")]));
		}
		for (key, value) in [
			("HERDR_ENV", "0"),
			("HERDR_SOCKET_PATH", "/tmp/x"),
			("HERDR_BIN_PATH", "/usr/bin/herdr"),
			("HERDR_SESSION", "s1"),
			("HERDR_CONFIG_PATH", "/tmp/herdr.toml"),
			("HERDR_CLIENT_SOCKET_PATH", "/tmp/client.sock"),
		] {
			assert!(!inside(Multiplexer::Herdr, &[(key, value)]), "{key}={value}");
		}
	}

	#[test]
	fn explicit_markers_exclude_term_fallbacks() {
		assert!(inside(Multiplexer::Tmux, &[("TMUX", "/tmp/tmux,1,0")]));
		assert!(inside(Multiplexer::Screen, &[("STY", "1234.pts-0.host")]));
		assert!(inside(Multiplexer::Zellij, &[("ZELLIJ", "0")]));
		assert!(inside(Multiplexer::Cmux, &[("CMUX_WORKSPACE_ID", "workspace")]));
		assert!(inside(Multiplexer::Cmux, &[("CMUX_SURFACE_ID", "surface")]));
		assert!(inside(Multiplexer::Cmux, &[("CMUX_REMOTE_TRANSPORT", "ssh")]));
		assert!(!inside(Multiplexer::Cmux, &[("CMUX_SOCKET_PATH", "/tmp/cmux.sock")]));
		assert!(!inside(Multiplexer::Tmux, &[("TERM", "tmux-256color")]));
		assert_eq!(classified(&[("TERM", "tmux-256color")]), Some("tmux"));
	}

	#[test]
	fn wmux_markers_but_not_cli_overrides() {
		assert!(inside(Multiplexer::Wmux, &[("WMUX", "1")]));
		assert!(inside(Multiplexer::Wmux, &[("WMUX_SURFACE_ID", "3f2a")]));
		assert!(!inside(Multiplexer::Wmux, &[("WMUX", "0")]));
		assert!(!inside(Multiplexer::Wmux, &[("WMUX_SURFACE_ID", "")]));
		assert!(!inside(Multiplexer::Wmux, &[("WMUX_CLI", "C:/wmux/wmux.exe")]));
		assert!(!inside(Multiplexer::Wmux, &[("WMUX_PIPE", r"\\.\pipe\wmux")]));
		for pairs in [&[("WMUX", "1")][..], &[("WMUX_SURFACE_ID", "3f2a")]] {
			assert!(is_inside_any(&Env::of(pairs)));
		}
		for pairs in
			[&[("WMUX", "0")][..], &[("WMUX_SURFACE_ID", "")], &[("WMUX_CLI", "C:/wmux/wmux.exe")]]
		{
			assert!(!is_inside_any(&Env::of(pairs)));
		}
	}

	#[test]
	fn orca_requires_both_nonempty_markers() {
		let pane = ("ORCA_PANE_KEY", "tab-1:12345678-1234-1234-1234-123456789abc");
		let worktree = ("ORCA_WORKTREE_ID", "worktree-1");
		assert!(inside(Multiplexer::Orca, &[pane, worktree]));
		for pairs in [
			&[pane][..],
			&[worktree],
			&[("ORCA_PANE_KEY", ""), worktree],
			&[pane, ("ORCA_WORKTREE_ID", "")],
			&[("ORCA_PANE_KEY", " "), worktree],
			&[pane, ("ORCA_WORKTREE_ID", " ")],
			&[("TERM_PROGRAM", "orca")],
		] {
			assert!(!inside(Multiplexer::Orca, pairs), "{pairs:?}");
		}
	}

	#[test]
	fn env_keys_and_names() {
		let keys: Vec<_> = env_keys().collect();
		assert_eq!(keys.first(), Some(&"HERDR_ENV"));
		assert_eq!(keys.last(), Some(&"TERM"));
		assert!(
			keys.contains(&"TMUX") && keys.contains(&"STY") && keys.contains(&"ORCA_WORKTREE_ID")
		);
		for module in &REGISTRY {
			assert_eq!(Multiplexer::parse(module.id.as_str()), Some(module.id));
		}
		assert_eq!(Multiplexer::parse("byobu"), None);
	}

	#[test]
	fn nested_precedence_and_term_only_classification() {
		assert_eq!(classified(&[("HERDR_PANE_ID", "p1"), ("TMUX", "session")]), Some("herdr"));
		assert_eq!(classified(&[("TMUX", "session"), ("STY", "screen")]), Some("tmux"));
		assert_eq!(classified(&[("STY", "screen"), ("ZELLIJ", "session")]), Some("screen"));
		assert_eq!(classified(&[("TERM", "screen-256color")]), Some("screen"));
		assert!(is_inside_any(&Env::of(&[("HERDR_PANE_ID", "p1")])));
	}

	#[test]
	fn orca_ranks_after_nested_multiplexers_and_keeps_the_direct_path() {
		let orca = [
			("ORCA_PANE_KEY", "tab-1:12345678-1234-1234-1234-123456789abc"),
			("ORCA_WORKTREE_ID", "worktree-1"),
		];
		let with = |extra: (&'static str, &'static str)| {
			let mut pairs = orca.to_vec();
			pairs.push(extra);
			Env::of(&pairs)
		};
		assert_eq!(classified(&orca), Some("orca"));
		assert!(!is_inside_any(&Env::of(&orca)));
		assert_eq!(classify(&with(("TMUX", "session"))).map(|m| m.id), Some(Multiplexer::Tmux));
		assert!(is_inside_any(&with(("TMUX", "session"))));
		assert_eq!(classify(&with(("ZELLIJ", "session"))).map(|m| m.id), Some(Multiplexer::Zellij));
		assert_eq!(classify(&with(("TERM", "tmux-256color"))).map(|m| m.id), Some(Multiplexer::Tmux));
		assert_eq!(
			classify(&with(("TERM", "screen-256color"))).map(|m| m.id),
			Some(Multiplexer::Screen)
		);
		assert_eq!(classified(&[("TERM_PROGRAM", "orca")]), None);
		assert_eq!(classified(&orca[..1]), None);
		assert_eq!(classified(&orca[1..]), None);
	}

	#[test]
	fn zellij_untrusts_the_background_query_on_macos_only() {
		let env = Env::of(&[("ZELLIJ", "0")]);
		assert!(!background_query_trusted(&env, Platform::Darwin));
		assert!(background_query_trusted(&env, Platform::Linux));
		// TERM-only classification is not an active session.
		assert!(background_query_trusted(&Env::of(&[("TERM", "screen")]), Platform::Darwin));
	}

	#[test]
	fn notifiers_run_innermost_tier_first() {
		let env = Env::of(&[
			("TMUX", "t"),
			("ZELLIJ", "0"),
			("CMUX_SURFACE_ID", "s"),
			("HERDR_PANE_ID", "p"),
		]);
		let ids: Vec<_> = notifiers(&env).into_iter().map(|(id, _)| id).collect();
		assert_eq!(ids, [
			Multiplexer::Herdr,
			Multiplexer::Cmux,
			Multiplexer::Tmux,
			Multiplexer::Zellij
		]);
	}
}
