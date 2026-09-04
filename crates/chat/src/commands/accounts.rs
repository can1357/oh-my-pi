//! Provider account slash commands: `/login`, `/logout`, `/setup`,
//! `/providers`, and `/pin`.
//!
//! Every command reads stored accounts and providers through the
//! [`Services`] seam and opens an observer-local panel
//! ([`crate::overlays::login`]) or answers with one notice; nothing here
//! touches the session DOM (ADR 0005).
//!
//! [`Services`]: crate::overlays::services::Services

use omp_con::ConError;
use omp_core::{Str, sf};
use omp_tui::Icon;

use super::{PaletteEntry, rest};
use crate::{
	actions::{HostAction, post},
	host::HostCommand,
	overlays::{
		Panel, PanelCall, PanelCx, PanelEvent, PanelOpener,
		login::{LoginDialog, LogoutSelector, ProviderMode, ProviderPicker},
		services::{AccountRow, Mutation, ProviderRow, SessionScope},
	},
};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] = &[
	PaletteEntry { name: "login", icon: Icon::Input },
	PaletteEntry { name: "logout", icon: Icon::Output },
	PaletteEntry { name: "setup", icon: Icon::Gear },
	PaletteEntry { name: "providers", icon: Icon::Gear },
	PaletteEntry { name: "pin", icon: Icon::Pin },
];

/// Shown when a manual OAuth callback arrives without a pending login flow.
const NO_PENDING_CALLBACK: &str = "No OAuth login is waiting for a manual callback.";
/// Shown when logout finds no stored credentials.
const NOTHING_TO_LOG_OUT: &str =
	"No stored provider credentials to log out. Remove env or config auth at its source.";

fn usage(message: &'static str) -> ConError {
	ConError::Usage(Str::new_static(message))
}

fn open(ctx: &omp_con::Ctx, opener: PanelOpener) -> omp_con::ConResult<()> {
	post(ctx, HostAction::Open(opener))
}

fn call(ctx: &omp_con::Ctx, call: PanelCall) -> omp_con::ConResult<()> {
	post(ctx, HostAction::Call(call))
}

fn boxed(panel: impl Panel + 'static) -> Box<dyn Panel> {
	Box::new(panel)
}

/// Opens the provider picker in `mode`; logout mode lists only providers
/// with stored accounts.
fn provider_picker(cx: &PanelCx<'_>, mode: ProviderMode) -> Result<Box<dyn Panel>, Str> {
	let providers = match mode {
		ProviderMode::Login => cx.services.providers().map_err(|error| sf!("{error}"))?,
		ProviderMode::Logout => logout_providers(cx)?,
	};
	Ok(boxed(ProviderPicker::open(providers, mode, cx.ui)))
}

/// Providers that hold at least one stored account, in catalog order.
fn logout_providers(cx: &PanelCx<'_>) -> Result<Vec<ProviderRow>, Str> {
	let accounts = cx.services.accounts().map_err(|error| sf!("{error}"))?;
	let mut providers: Vec<ProviderRow> = Vec::new();
	for account in &accounts {
		if providers
			.iter()
			.any(|provider| provider.id == account.provider)
		{
			continue;
		}
		providers.push(ProviderRow {
			id:        account.provider.clone(),
			name:      account.provider_name.clone(),
			oauth:     account.kind.as_str() == "oauth",
			logged_in: true,
		});
	}
	Ok(providers)
}

/// Opens the account selector for `provider`, or the provider picker when
/// more than one provider has stored accounts.
fn logout_panel(cx: &PanelCx<'_>, provider: Option<&str>) -> Result<Box<dyn Panel>, Str> {
	let accounts = cx.services.accounts().map_err(|error| sf!("{error}"))?;
	let Some(provider) = provider else {
		let providers = logout_providers(cx)?;
		return match providers.as_slice() {
			[] => Err(Str::new_static(NOTHING_TO_LOG_OUT)),
			[only] => Ok(boxed(LogoutSelector::open(only.name.clone(), accounts, cx.ui))),
			_ => Ok(boxed(ProviderPicker::open(providers, ProviderMode::Logout, cx.ui))),
		};
	};
	let rows: Vec<AccountRow> = accounts
		.into_iter()
		.filter(|account| account.provider == provider)
		.collect();
	let Some(first) = rows.first() else {
		let known = cx
			.services
			.providers()
			.map(|providers| providers.iter().any(|row| row.id == provider))
			.unwrap_or(false);
		return Err(if known {
			sf!("Logout skipped: no stored credentials for {provider}.")
		} else {
			sf!("Unknown OAuth provider: {provider}")
		});
	};
	let name = first.provider_name.clone();
	Ok(boxed(LogoutSelector::open(name, rows, cx.ui)))
}

/// `/pin` target: a session or a provider account.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PinTarget {
	/// Toggle the live session's pin.
	CurrentSession,
	/// Toggle a stored session's pin.
	Session(Str),
	/// Pin one provider account to the session.
	Account {
		/// Provider id.
		provider: Str,
		/// Account label or id; `None` picks the provider's only account.
		account:  Option<Str>,
	},
}

/// Toggles a session pin through the controller-owned mutation stream.
fn pin_session(cx: &PanelCx<'_>, id: Option<&str>) -> PanelEvent {
	let id = match id {
		Some(id) => Str::new(id),
		None => match cx.services.live_session_id() {
			Ok(id) => id,
			Err(error) => return PanelEvent::Notice(sf!("{error}")),
		},
	};
	let rows = match cx.services.sessions(SessionScope::Project) {
		Ok(rows) => rows,
		Err(error) => return PanelEvent::Notice(sf!("{error}")),
	};
	let Some(row) = rows.iter().find(|row| {
		row.id == id
			|| row.title.as_deref() == Some(id.as_str())
			|| row.path.file_stem().and_then(|stem| stem.to_str()) == Some(id.as_str())
	}) else {
		return PanelEvent::Notice(sf!("Session \"{id}\" not found."));
	};
	PanelEvent::Command(HostCommand::Service(Mutation::PinSession {
		id:     row.id.clone(),
		pinned: !row.pinned,
	}))
}

/// Pins one provider account through the controller-owned mutation stream.
fn pin_account(cx: &PanelCx<'_>, provider: &str, account: Option<&str>) -> PanelEvent {
	let accounts = match cx.services.accounts() {
		Ok(accounts) => accounts,
		Err(error) => return PanelEvent::Notice(sf!("{error}")),
	};
	let candidates: Vec<&AccountRow> = accounts
		.iter()
		.filter(|row| row.provider == provider)
		.collect();
	let chosen = match account {
		Some(account) => candidates
			.iter()
			.copied()
			.find(|row| row.label == account || row.id == account),
		None if candidates.len() == 1 => candidates.first().copied(),
		None => None,
	};
	let Some(row) = chosen else {
		return PanelEvent::Notice(match (account, candidates.len()) {
			(_, 0) => sf!("No stored accounts for {provider}."),
			(Some(account), _) => sf!("No {provider} account matches \"{account}\"."),
			(None, _) => sf!(
				"Choose one of the {} {provider} accounts: /pin {provider} <account>",
				candidates.len()
			),
		});
	};
	PanelEvent::Command(HostCommand::Service(Mutation::PinAccount {
		account: row.clone(),
		pinned:  true,
	}))
}

/// Parses `/pin [session id | <provider> [account]]`: a first word naming
/// a known provider selects the account form.
pub fn pin_target(words: Option<Str>, providers: &[ProviderRow]) -> PinTarget {
	let Some(words) = words else {
		return PinTarget::CurrentSession;
	};
	let text = words.as_str().trim();
	let (first, remainder) = text
		.split_once(char::is_whitespace)
		.map_or((text, ""), |(first, remainder)| (first, remainder.trim()));
	if providers.iter().any(|provider| provider.id == first) {
		return PinTarget::Account {
			provider: Str::new(first),
			account:  (!remainder.is_empty()).then(|| Str::new(remainder)),
		};
	}
	PinTarget::Session(Str::new(text))
}

omp_con::cmd! {
	/// Logs in to a provider: `/login [provider|redirect URL]`.
	login(?provider: Str) = |ctx, args| {
		match rest(args, 0) {
			None => open(ctx, PanelOpener::new(|cx| provider_picker(cx, ProviderMode::Login))),
			Some(arg) if arg.contains("://") => {
				call(ctx, PanelCall::new(|_cx| PanelEvent::Notice(Str::new_static(NO_PENDING_CALLBACK))))
			},
			Some(provider) => open(ctx, PanelOpener::new(move |cx| {
				let flow = cx.services.login(provider.as_str()).map_err(|error| sf!("{error}"))?;
				Ok(boxed(LoginDialog::open(flow, cx.ui)))
			})),
		}
	};

	/// Logs out of a provider account: `/logout [provider]`.
	logout(?provider: Str) = |ctx, args| {
		let provider = rest(args, 0);
		open(ctx, PanelOpener::new(move |cx| logout_panel(cx, provider.as_deref())))
	};

	/// Opens provider setup: `/setup [providers]`.
	setup(?section: Str) = |ctx, args| {
		match rest(args, 0).as_deref().map(str::to_ascii_lowercase).as_deref() {
			None | Some("providers") => {
				open(ctx, PanelOpener::new(|cx| provider_picker(cx, ProviderMode::Login)))
			},
			Some(_) => Err(usage("Usage: /setup [providers]")),
		}
	};

	/// Opens provider setup (alias of `setup`).
	providers() = |ctx, _args| {
		open(ctx, PanelOpener::new(|cx| provider_picker(cx, ProviderMode::Login)))
	};

	/// Pins a session at the top of the resume list, or a provider account: `/pin [session id | <provider> [account]]`.
	pin(?target: Str, ?account: Str) = |ctx, args| {
		let words = rest(args, 0);
		call(ctx, PanelCall::new(move |cx| {
			let providers = cx.services.providers().unwrap_or_default();
			match pin_target(words.clone(), &providers) {
				PinTarget::CurrentSession => pin_session(cx, None),
				PinTarget::Session(id) => pin_session(cx, Some(id.as_str())),
				PinTarget::Account { provider, account } => {
					pin_account(cx, provider.as_str(), account.as_deref())
				},
			}
		}))
	};
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;

	fn provider(id: &'static str) -> ProviderRow {
		ProviderRow {
			id:        Str::new_static(id),
			name:      Str::new_static(id),
			oauth:     true,
			logged_in: false,
		}
	}

	#[test]
	fn pin_target_distinguishes_sessions_from_provider_accounts() {
		let providers = [provider("anthropic")];
		assert_eq!(pin_target(None, &providers), PinTarget::CurrentSession);
		assert_eq!(pin_target(Some(sf!("01J0ABC")), &providers), PinTarget::Session(sf!("01J0ABC")));
		assert_eq!(pin_target(Some(sf!("anthropic")), &providers), PinTarget::Account {
			provider: sf!("anthropic"),
			account:  None,
		});
		assert_eq!(
			pin_target(Some(sf!("anthropic  me@example.com")), &providers),
			PinTarget::Account { provider: sf!("anthropic"), account: Some(sf!("me@example.com")) }
		);
	}

	#[test]
	fn account_commands_are_registered_with_pi_descriptions() {
		let con = Arc::new(omp_con::CtxBuilder::default().build());
		let roster = crate::autocomplete::slash::roster(&con);
		for (name, description, icon) in [
			("login", "Logs in to a provider", Icon::Input),
			("logout", "Logs out of a provider account", Icon::Output),
			("setup", "Opens provider setup", Icon::Gear),
			("providers", "Opens provider setup (alias of `setup`)", Icon::Gear),
			("pin", "Pins a session at the top of the resume list", Icon::Pin),
		] {
			let command = roster
				.iter()
				.find(|command| command.name() == name)
				.unwrap_or_else(|| panic!("`{name}` is registered"));
			assert!(
				command.description().starts_with(description),
				"{name}: {}",
				command.description()
			);
			assert_eq!(crate::commands::palette_icon(name), Some(icon), "{name}");
		}
	}
}
