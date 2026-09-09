//! Account panels: the in-place login dialog, the `/logout` account selector,
//! and the provider picker behind `/login`, `/setup`, `/providers`, and
//! `/logout` without a provider.
//!
//! Every panel is observer-local (ADR 0005): the login dialog only relays
//! [`LoginFlow`] channel traffic, the logout selector posts a typed mutation
//! to the controller, and a chosen provider becomes a console line
//! (`login <id>`) so the dialog opens through the one command stream
//! (ADR 0014).

use std::time::Duration;

use omp_core::{Str, StrMut, sf};
use omp_tui::{Frame, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent, dom};

use super::{
	Outcome, Panel, PanelAnchor, PanelEvent, PanelNote,
	services::{AccountRow, LoginEvent, LoginFlow, Mutation, ProviderRow},
};
use crate::host::HostCommand;

/// Poll cadence while a flow or deletion is pending.
const POLL: Duration = Duration::from_millis(100);
/// Maximum visible provider or account rows.
pub const LOGOUT_SELECTOR_MAX_VISIBLE: usize = 10;
const INPUT_ID: &str = "login-input";
const LIST_ID: &str = "providers";
const CANCEL_HINT: &str = "(Escape to cancel)";
const SUBMIT_HINT: &str = "(Escape to cancel, Enter to submit)";
const CLOSE_HINT: &str = "(Enter or Escape to close)";
const CLICK_HINT: &str = if cfg!(target_os = "macos") {
	"Cmd+click to open"
} else {
	"Ctrl+click to open"
};
const LAUNCHED_HINT: &str = "If your browser didn't open, follow the link above.";
const DEVICE_HINT: &str = "Enter the code at the link above.";
const LOGOUT_HINT: &str = "↑/↓ select · ↵ log out account · Esc cancel";
const LOGOUT_EMPTY: &str = "No stored accounts to log out";
const PROVIDER_LOGIN_HINT: &str = "↑/↓ providers · Enter login · type to search · Esc close";
const PROVIDER_LOGOUT_HINT: &str =
	"↑/↓ providers · Enter choose account · type to search · Esc close";
const NO_LOGIN_PROVIDERS: &str = "No OAuth providers available";
const NO_LOGOUT_PROVIDERS: &str = "No stored provider credentials to log out";
/// Border, title rule, hint, and blank rows around a list.
const FRAME_ROWS: u16 = 6;

/// Where the user completes authorization in the browser.
enum Location {
	Url { url: Str, launched: bool },
	DeviceCode { code: Str, url: Str },
}

/// In-place provider login: status line, the
/// authorization URL or device code, and a paste input once the driver
/// asks for one. Esc cancels the flow; the settled outcome stays on screen
/// until Enter or Esc closes the dialog.
pub struct LoginDialog {
	flow:      LoginFlow,
	status:    Str,
	location:  Option<Location>,
	prompt:    Option<Str>,
	outcome:   Option<Result<Str, Str>>,
	value:     Str,
	next_wake: Option<Duration>,
	ui:        Ui,
	ctx:       UiContext,
	width:     u16,
}

impl LoginDialog {
	/// Opens the dialog over a started flow.
	#[must_use]
	pub fn open(flow: LoginFlow, ctx: &UiContext) -> Self {
		let status = sf!("Logging in to {}…", flow.provider_name);
		let mut dialog = Self {
			flow,
			status,
			location: None,
			prompt: None,
			outcome: None,
			value: Str::default(),
			next_wake: Some(Duration::ZERO),
			ui: Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx: ctx.clone(),
			width: 0,
		};
		dialog.rebuild(80);
		dialog
	}

	/// The settled outcome: the success message or the failure.
	#[must_use]
	pub fn outcome(&self) -> Option<Result<&str, &str>> {
		self
			.outcome
			.as_ref()
			.map(|outcome| outcome.as_ref().map(Str::as_str).map_err(Str::as_str))
	}

	/// Whether the driver is waiting for pasted input.
	#[must_use]
	pub const fn prompting(&self) -> bool {
		self.prompt.is_some()
	}

	fn apply(&mut self, event: LoginEvent) {
		match event {
			LoginEvent::OpenUrl { url, launched } => {
				// Device flows follow the code with a pre-filled URL; keep the
				// code visible for browsers that do not carry it over.
				self.location = Some(match self.location.take() {
					Some(Location::DeviceCode { code, .. }) => Location::DeviceCode { code, url },
					_ => Location::Url { url, launched },
				});
				self.status = sf!("Waiting for {} authorization…", self.flow.provider_name);
			},
			LoginEvent::DeviceCode { code, verification_url } => {
				self.location = Some(Location::DeviceCode { code, url: verification_url });
				self.status = sf!("Waiting for {} authorization…", self.flow.provider_name);
			},
			LoginEvent::Prompt { label } => {
				self.prompt = Some(label);
				self.value = Str::default();
			},
			LoginEvent::Info(message) => self.status = message,
		}
	}

	fn submit(&mut self) -> PanelEvent {
		if self.outcome.is_some() {
			return PanelEvent::Close;
		}
		if self.prompt.take().is_some() {
			self.sync_value();
			let _ = self.flow.input.send(self.value.clone());
			self.value = Str::default();
			self.rebuild(self.width);
		}
		PanelEvent::Consumed
	}

	fn cancel(&mut self) -> PanelEvent {
		if self.outcome.is_none() {
			let _ = self.flow.cancel.send(());
			self.outcome = Some(Err(Str::new_static("Login cancelled")));
			self.next_wake = None;
		}
		PanelEvent::Close
	}

	fn sync_value(&mut self) {
		if let Some(value) = self.ui.values()[INPUT_ID].as_str() {
			self.value = Str::new(value);
		}
	}

	fn rebuild(&mut self, width: u16) {
		self.width = width;
		let title = sf!("Login to {}", self.flow.provider_name);
		let status = self.status.clone();
		let location = self.location.as_ref().map(|location| match location {
			Location::Url { url, launched } => (Some((url.clone(), *launched)), None),
			Location::DeviceCode { code, url } => (None, Some((code.clone(), url.clone()))),
		});
		let outcome = self.outcome.clone();
		let prompt = self.prompt.clone();
		let value = self.value.clone();
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					<text wrap>{status}</text>
					if let Some((url, device)) = location {
						<hr border=round/>
						if let Some((url, launched)) = url {
							<md>{url}</md>
							<text fg=muted>{CLICK_HINT}</text>
							if launched { <text fg=muted wrap>{LAUNCHED_HINT}</text> }
						}
						if let Some((code, url)) = device {
							<row gap=1>
								<pre fg=muted>{"code"}</pre>
								<pre bold fg=accent>{code}</pre>
							</row>
							<md>{url}</md>
							<text fg=muted wrap>{DEVICE_HINT}</text>
						}
					}
					<hr border=round/>
					match outcome {
						Some(Ok(message)) => {
							<text fg=ok wrap>{message}</text>
							<text fg=muted>{CLOSE_HINT}</text>
						},
						Some(Err(message)) => {
							<text fg=err wrap>{message}</text>
							<text fg=muted>{CLOSE_HINT}</text>
						},
						None => {
							if let Some(label) = prompt {
								<text wrap>{label}</text>
								<input id={INPUT_ID} value={value} submit placeholder="Paste code or URL"/>
								<text fg=muted>{SUBMIT_HINT}</text>
							} else {
								<text fg=muted>{CANCEL_HINT}</text>
							}
						},
					}
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, width, self.ctx.clone());
		if self.prompt.is_some() && self.outcome.is_none() {
			self.ui.focus_first();
		}
	}
}

impl Panel for LoginDialog {
	fn id(&self) -> &'static str {
		"login"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc | Key::Ctrl('c') => self.cancel(),
			Key::Enter => self.submit(),
			_ if self.prompt.is_some() && self.outcome.is_none() => match self.ui.handle_key(key) {
				UiEvent::Cancel => self.cancel(),
				UiEvent::Submit => self.submit(),
				_ => {
					self.sync_value();
					PanelEvent::Consumed
				},
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		if self.prompt.is_none() || self.outcome.is_some() {
			return PanelEvent::Ignored;
		}
		match self.ui.handle_paste(text) {
			UiEvent::Submit => self.submit(),
			_ => {
				self.sync_value();
				PanelEvent::Consumed
			},
		}
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		if self.prompt.is_none() || self.outcome.is_some() {
			return PanelEvent::Consumed;
		}
		match self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods)
		{
			UiEvent::Cancel => self.cancel(),
			UiEvent::Submit => self.submit(),
			_ => {
				self.sync_value();
				PanelEvent::Consumed
			},
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width {
			self.sync_value();
			self.rebuild(viewport.width);
		}
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		if self.outcome.is_some() {
			self.next_wake = None;
			return false;
		}
		let mut changed = false;
		while let Ok(event) = self.flow.events.try_recv() {
			self.apply(event);
			changed = true;
		}
		match self.flow.done.try_recv() {
			Ok(Ok(message)) => {
				self.outcome = Some(Ok(message));
				self.prompt = None;
			},
			Ok(Err(error)) => {
				self.outcome = Some(Err(sf!("{error}")));
				self.prompt = None;
			},
			Err(flume::TryRecvError::Disconnected) => {
				self.outcome =
					Some(Err(sf!("Login to {} ended without a result", self.flow.provider_name)));
				self.prompt = None;
			},
			Err(flume::TryRecvError::Empty) => {},
		}
		if self.outcome.is_some() {
			self.next_wake = None;
			changed = true;
		} else {
			self.next_wake = Some(now + POLL);
		}
		if changed {
			self.sync_value();
			self.rebuild(self.width);
		}
		changed
	}

	fn next_wake(&self) -> Option<Duration> {
		self.next_wake
	}
}

/// Escapes text for a double-quoted console argument (`omp_con` script
/// quoting: `\"`, `\\`, `\n`, `\t`).
fn escape_quoted(text: &str) -> Str {
	let mut out = StrMut::with_capacity(text.len() + 8);
	for ch in text.chars() {
		match ch {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\t' => out.push_str("\\t"),
			_ => out.push(ch),
		}
	}
	out.freeze()
}

/// Account picker for `/logout` once the provider is known: circular ↑/↓,
/// PgUp/PgDn by a page,
/// Enter asks the controller to delete the highlighted account.
pub struct LogoutSelector {
	provider: Str,
	accounts: Vec<AccountRow>,
	selected: usize,
	status:   Option<Str>,
	pending:  Option<(usize, Mutation)>,
	ui:       Ui,
	ctx:      UiContext,
	width:    u16,
}

impl LogoutSelector {
	/// Opens the selector over `accounts` of one provider; the active
	/// account is preselected.
	#[must_use]
	pub fn open(provider_name: impl Into<Str>, accounts: Vec<AccountRow>, ctx: &UiContext) -> Self {
		let selected = accounts
			.iter()
			.position(|account| account.active)
			.unwrap_or(0);
		let mut selector = Self {
			provider: provider_name.into(),
			accounts,
			selected,
			status: None,
			pending: None,
			ui: Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx: ctx.clone(),
			width: 0,
		};
		selector.rebuild(80);
		selector
	}

	/// Highlighted row index.
	#[must_use]
	pub const fn selected(&self) -> usize {
		self.selected
	}

	fn step(&mut self, delta: isize) {
		let total = self.accounts.len();
		if total == 0 {
			return;
		}
		let at = self.selected as isize;
		self.selected = match delta {
			-1 | 1 => (at + delta).rem_euclid(total as isize) as usize,
			_ => (at + delta).clamp(0, total as isize - 1) as usize,
		};
		self.status = None;
		self.rebuild(self.width);
	}

	fn confirm(&mut self) -> PanelEvent {
		if self.pending.is_some() {
			return PanelEvent::Consumed;
		}
		let Some(account) = self.accounts.get(self.selected) else {
			return PanelEvent::Consumed;
		};
		let mutation = Mutation::Logout { account: account.clone() };
		self.status = Some(sf!("Logging out {}…", account.label));
		self.pending = Some((self.selected, mutation.clone()));
		self.rebuild(self.width);
		PanelEvent::Command(HostCommand::Service(mutation))
	}

	fn rebuild(&mut self, width: u16) {
		self.width = width;
		let title = sf!("Select {} account to log out", self.provider);
		let total = self.accounts.len();
		let start = if total <= LOGOUT_SELECTOR_MAX_VISIBLE {
			0
		} else {
			self
				.selected
				.saturating_sub(LOGOUT_SELECTOR_MAX_VISIBLE / 2)
				.min(total - LOGOUT_SELECTOR_MAX_VISIBLE)
		};
		let end = (start + LOGOUT_SELECTOR_MAX_VISIBLE).min(total);
		let rows: Vec<_> = self.accounts[start..end]
			.iter()
			.enumerate()
			.map(|(offset, account)| {
				(
					start + offset == self.selected,
					account.label.clone(),
					account.active,
					account.detail.clone(),
				)
			})
			.collect();
		let status = self.status.clone();
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					for (selected, label, active, detail) in rows {
						<row>
							if selected {
								<icon name="cursor" fg=accent/>
								<pre fg=accent>{" "}{label}</pre>
							} else {
								<pre>{"  "}{label}</pre>
							}
							if active { <pre fg=muted>{" (active)"}</pre> }
							if !detail.is_empty() { <pre fg=muted>{"  "}{detail}</pre> }
						</row>
					}
					if total == 0 { <text fg=muted>{LOGOUT_EMPTY}</text> }
					<text fg=muted truncate>{LOGOUT_HINT}</text>
					if let Some(status) = status {
						<text fg=warn truncate>{status}</text>
					}
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, width, self.ctx.clone());
	}
}

impl Panel for LogoutSelector {
	fn id(&self) -> &'static str {
		"logout"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc | Key::Ctrl('c') => PanelEvent::Close,
			Key::Up => {
				self.step(-1);
				PanelEvent::Consumed
			},
			Key::Down => {
				self.step(1);
				PanelEvent::Consumed
			},
			Key::PageUp => {
				self.step(-(LOGOUT_SELECTOR_MAX_VISIBLE as isize));
				PanelEvent::Consumed
			},
			Key::PageDown => {
				self.step(LOGOUT_SELECTOR_MAX_VISIBLE as isize);
				PanelEvent::Consumed
			},
			Key::Enter => self.confirm(),
			_ => PanelEvent::Consumed,
		}
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		match self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods)
		{
			UiEvent::Cancel => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width {
			self.rebuild(viewport.width);
		}
		self.ui.frame()
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		let PanelNote::Outcome(Outcome::Service(outcome)) = note else {
			return PanelEvent::Ignored;
		};
		let Some((index, mutation)) = &self.pending else {
			return PanelEvent::Ignored;
		};
		if *mutation != outcome.mutation {
			return PanelEvent::Ignored;
		}
		let index = *index;
		self.pending = None;
		match &outcome.result {
			Ok(_) => {
				let account = self.accounts.remove(index);
				self.selected = self.selected.min(self.accounts.len().saturating_sub(1));
				self.status = None;
				self.rebuild(self.width);
				PanelEvent::Finish(sf!("echo \"Logged out {}\"", escape_quoted(&account.label)))
			},
			Err(error) => {
				self.status = Some(sf!("Logout failed: {error}"));
				self.rebuild(self.width);
				PanelEvent::Consumed
			},
		}
	}
}

/// What choosing a provider does.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderMode {
	/// `/login`, `/setup`, `/providers`: start a login for the provider.
	Login,
	/// `/logout` without a provider: open that provider's account selector.
	Logout,
}

/// Provider picker and setup wizard step 1:
/// each row shows the provider name and whether it is signed in; Enter
/// runs `login <id>` or `logout <id>` through the console.
pub struct ProviderPicker {
	providers: Vec<ProviderRow>,
	mode:      ProviderMode,
	query:     Str,
	list_rows: u16,
	ui:        Ui,
	ctx:       UiContext,
	width:     u16,
}

impl ProviderPicker {
	/// Opens the picker over `providers`.
	#[must_use]
	pub fn open(providers: Vec<ProviderRow>, mode: ProviderMode, ctx: &UiContext) -> Self {
		let mut picker = Self {
			providers,
			mode,
			query: Str::default(),
			list_rows: LOGOUT_SELECTOR_MAX_VISIBLE as u16,
			ui: Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx: ctx.clone(),
			width: 0,
		};
		picker.rebuild(80);
		picker
	}

	/// Providers in picker order.
	#[must_use]
	pub fn providers(&self) -> &[ProviderRow] {
		&self.providers
	}

	fn route(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Changed { id, value } if id.as_str() == LIST_ID => value
				.as_str()
				.parse::<usize>()
				.ok()
				.and_then(|index| self.providers.get(index))
				.map_or(PanelEvent::Consumed, |provider| {
					let verb = match self.mode {
						ProviderMode::Login => "login",
						ProviderMode::Logout => "logout",
					};
					PanelEvent::Finish(sf!("{verb} {}", provider.id))
				}),
			UiEvent::Filtered { id, query, .. } if id.as_str() == LIST_ID => {
				self.query = query;
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn rebuild(&mut self, width: u16) {
		self.width = width;
		let (title, hint, empty) = match self.mode {
			ProviderMode::Login => {
				("Select provider to login", PROVIDER_LOGIN_HINT, NO_LOGIN_PROVIDERS)
			},
			ProviderMode::Logout => {
				("Select provider to logout", PROVIDER_LOGOUT_HINT, NO_LOGOUT_PROVIDERS)
			},
		};
		let seed = self.query.clone();
		let height = self.list_rows.saturating_add(1);
		let options: Vec<_> = self
			.providers
			.iter()
			.enumerate()
			.map(|(index, provider)| {
				(
					sf!("{index}"),
					sf!("{} {}", provider.name, provider.id),
					provider.name.clone(),
					provider.logged_in,
				)
			})
			.collect();
		let none = self.providers.is_empty();
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					if none {
						<text fg=muted>{empty}</text>
					} else {
						<select id={LIST_ID} filter={seed} h={height}>
							for (value, search, name, logged_in) in options {
								<option value={value} label={search}>
									<td truncate grow><pre>{name}</pre></td>
									<td>
										if logged_in {
											<icon name="enabled" fg=ok/>
											<pre fg=ok>{" logged in"}</pre>
										} else {
											<pre fg=muted>{"not signed in"}</pre>
										}
									</td>
								</option>
							}
						</select>
					}
					<hr border=round/>
					<text fg=muted truncate>{hint}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, width, self.ctx.clone());
	}
}

impl Panel for ProviderPicker {
	fn id(&self) -> &'static str {
		"setup"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if key == Key::Ctrl('c') {
			return PanelEvent::Close;
		}
		if self.providers.is_empty() && matches!(key, Key::Esc | Key::Enter | Key::Char('q')) {
			return PanelEvent::Close;
		}
		let event = self.ui.handle_key(key);
		self.route(event)
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		let event = self.ui.handle_paste(text);
		self.route(event)
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.route(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let rows = viewport
			.height
			.saturating_sub(FRAME_ROWS)
			.clamp(3, LOGOUT_SELECTOR_MAX_VISIBLE as u16);
		if rows != self.list_rows {
			self.list_rows = rows;
			self.ui.set_prop(LIST_ID, Prop::H, rows.saturating_add(1));
		}
		if viewport.width != self.width {
			self.rebuild(viewport.width);
		}
		self.ui.frame()
	}
}

#[cfg(test)]
mod tests {
	use flume::{Receiver, Sender};
	use omp_core::sf;

	use super::*;
	use crate::overlays::services::{ServiceOutcome, ServiceResult};

	struct Channels {
		events: Sender<LoginEvent>,
		input:  Receiver<Str>,
		done:   Sender<ServiceResult<Str>>,
		cancel: Receiver<()>,
	}

	fn flow() -> (LoginFlow, Channels) {
		let (events_tx, events) = flume::unbounded();
		let (input, input_rx) = flume::unbounded();
		let (done_tx, done) = flume::bounded(1);
		let (cancel, cancel_rx) = flume::bounded(1);
		(
			LoginFlow {
				provider: sf!("anthropic"),
				provider_name: sf!("Anthropic"),
				events,
				input,
				done,
				cancel,
			},
			Channels { events: events_tx, input: input_rx, done: done_tx, cancel: cancel_rx },
		)
	}

	fn text(panel: &mut dyn Panel) -> String {
		omp_tui::frame_text(panel.frame(Size { width: 70, height: 24 }))
	}

	#[test]
	fn login_dialog_shows_the_url_then_prompts_submits_and_cancels() {
		let ctx = UiContext::default();
		let (flow, channels) = flow();
		let mut dialog = LoginDialog::open(flow, &ctx);
		let rendered = text(&mut dialog);
		assert!(rendered.contains("Login to Anthropic"), "{rendered}");
		assert!(rendered.contains("Logging in to Anthropic"), "{rendered}");
		assert_eq!(dialog.next_wake(), Some(Duration::ZERO));

		channels
			.events
			.send(LoginEvent::OpenUrl {
				url:      sf!("https://auth.example/authorize?x=1"),
				launched: true,
			})
			.unwrap();
		assert!(dialog.tick(Duration::ZERO), "a new event repaints");
		assert_eq!(dialog.next_wake(), Some(POLL));
		let rendered = text(&mut dialog);
		assert!(rendered.contains("https://auth.example/authorize?x=1"), "{rendered}");
		assert!(rendered.contains(CLICK_HINT), "{rendered}");
		assert!(rendered.contains(LAUNCHED_HINT), "{rendered}");
		assert!(rendered.contains(CANCEL_HINT), "{rendered}");
		assert!(!rendered.contains("Enter to submit"), "{rendered}");
		assert!(!dialog.tick(POLL), "nothing new");

		channels
			.events
			.send(LoginEvent::Prompt { label: sf!("Paste the redirect URL") })
			.unwrap();
		assert!(dialog.tick(POLL * 2));
		assert!(dialog.prompting());
		let rendered = text(&mut dialog);
		assert!(rendered.contains("Paste the redirect URL"), "{rendered}");
		assert!(rendered.contains(SUBMIT_HINT), "{rendered}");
		assert!(
			rendered.contains("https://auth.example/authorize?x=1"),
			"the URL stays visible:\n{rendered}"
		);

		for ch in "abc".chars() {
			assert_eq!(dialog.key(Key::Char(ch)), PanelEvent::Consumed);
		}
		assert_eq!(dialog.paste("-xyz"), PanelEvent::Consumed);
		assert_eq!(dialog.key(Key::Enter), PanelEvent::Consumed);
		assert_eq!(channels.input.try_recv().unwrap().as_str(), "abc-xyz");
		assert!(!dialog.prompting());
		assert!(text(&mut dialog).contains(CANCEL_HINT));

		assert_eq!(dialog.key(Key::Esc), PanelEvent::Close);
		assert!(channels.cancel.try_recv().is_ok(), "Esc cancels the flow");
		assert_eq!(dialog.outcome(), Some(Err("Login cancelled")));
		assert_eq!(dialog.next_wake(), None);
	}

	#[test]
	fn login_dialog_shows_the_device_code_and_the_settled_outcome() {
		let ctx = UiContext::default();
		let (flow, channels) = flow();
		let mut dialog = LoginDialog::open(flow, &ctx);
		channels
			.events
			.send(LoginEvent::DeviceCode {
				code:             sf!("WY7H-2AZ4"),
				verification_url: sf!("https://device.example/activate"),
			})
			.unwrap();
		assert!(dialog.tick(Duration::ZERO));
		let rendered = text(&mut dialog);
		assert!(rendered.contains("WY7H-2AZ4"), "{rendered}");
		assert!(rendered.contains("https://device.example/activate"), "{rendered}");
		assert!(rendered.contains(DEVICE_HINT), "{rendered}");

		channels
			.done
			.send(Ok(sf!("Successfully logged in to Anthropic")))
			.unwrap();
		assert!(dialog.tick(POLL));
		assert_eq!(dialog.outcome(), Some(Ok("Successfully logged in to Anthropic")));
		assert_eq!(dialog.next_wake(), None);
		let rendered = text(&mut dialog);
		assert!(rendered.contains("Successfully logged in to Anthropic"), "{rendered}");
		assert!(rendered.contains(CLOSE_HINT), "{rendered}");
		assert_eq!(dialog.key(Key::Enter), PanelEvent::Close);
		assert!(channels.cancel.try_recv().is_err(), "a settled login is never cancelled");
	}

	#[test]
	fn login_dialog_reports_a_dropped_driver() {
		let ctx = UiContext::default();
		let (flow, channels) = flow();
		let mut dialog = LoginDialog::open(flow, &ctx);
		drop(channels);
		assert!(dialog.tick(Duration::ZERO));
		assert_eq!(dialog.outcome(), Some(Err("Login to Anthropic ended without a result")));
	}

	fn account(id: &'static str, active: bool) -> AccountRow {
		AccountRow {
			id: Str::new_static(id),
			provider: sf!("anthropic"),
			provider_name: sf!("Anthropic"),
			label: sf!("{id}@example.com"),
			detail: sf!("stored oauth"),
			kind: sf!("oauth"),
			active,
		}
	}

	#[test]
	fn logout_selector_wraps_and_enter_logs_out_the_highlighted_account() {
		let ctx = UiContext::default();
		let mut selector = LogoutSelector::open(
			"Anthropic",
			vec![account("alice", false), account("bob", true), account("carol", false)],
			&ctx,
		);
		assert_eq!(selector.selected(), 1, "the active account is preselected");
		let rendered = text(&mut selector);
		assert!(rendered.contains("Select Anthropic account to log out"), "{rendered}");
		assert!(rendered.contains("bob@example.com"), "{rendered}");
		assert!(rendered.contains("(active)"), "{rendered}");
		assert!(rendered.contains("stored oauth"), "{rendered}");
		assert!(rendered.contains(LOGOUT_HINT), "{rendered}");

		assert_eq!(selector.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(selector.selected(), 2);
		assert_eq!(selector.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(selector.selected(), 0, "down wraps to the top");
		assert_eq!(selector.key(Key::Up), PanelEvent::Consumed);
		assert_eq!(selector.selected(), 2, "up wraps to the bottom");
		assert_eq!(selector.key(Key::PageUp), PanelEvent::Consumed);
		assert_eq!(selector.selected(), 0, "page up clamps");
		assert_eq!(selector.key(Key::PageDown), PanelEvent::Consumed);
		assert_eq!(selector.selected(), 2, "page down clamps");

		let mutation = Mutation::Logout { account: account("carol", false) };
		assert_eq!(
			selector.key(Key::Enter),
			PanelEvent::Command(HostCommand::Service(mutation.clone()))
		);
		assert!(text(&mut selector).contains("Logging out carol@example.com"));
		let outcome = Outcome::Service(ServiceOutcome {
			mutation,
			result: Ok(Str::new_static("Logged out carol@example.com")),
		});
		assert_eq!(
			selector.notify(PanelNote::Outcome(&outcome)),
			PanelEvent::Finish(sf!("echo \"Logged out carol@example.com\""))
		);
		assert_eq!(selector.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn logout_selector_without_accounts_says_so() {
		let ctx = UiContext::default();
		let mut selector = LogoutSelector::open("Anthropic", Vec::new(), &ctx);
		assert!(text(&mut selector).contains(LOGOUT_EMPTY));
		assert_eq!(selector.key(Key::Enter), PanelEvent::Consumed);
		assert_eq!(selector.key(Key::Esc), PanelEvent::Close);
	}

	fn provider(id: &'static str, name: &'static str, logged_in: bool) -> ProviderRow {
		ProviderRow { id: Str::new_static(id), name: Str::new_static(name), oauth: true, logged_in }
	}

	#[test]
	fn provider_picker_enter_runs_login_for_the_highlighted_provider() {
		let ctx = UiContext::default();
		let mut picker = ProviderPicker::open(
			vec![provider("anthropic", "Anthropic", true), provider("openai", "OpenAI", false)],
			ProviderMode::Login,
			&ctx,
		);
		let rendered = text(&mut picker);
		assert!(rendered.contains("Select provider to login"), "{rendered}");
		assert!(rendered.contains("Anthropic"), "{rendered}");
		assert!(rendered.contains("logged in"), "{rendered}");
		assert!(rendered.contains("not signed in"), "{rendered}");
		assert_eq!(picker.key(Key::Enter), PanelEvent::Finish(sf!("login anthropic")));
		assert_eq!(picker.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(picker.key(Key::Enter), PanelEvent::Finish(sf!("login openai")));
		assert_eq!(picker.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn provider_picker_in_logout_mode_runs_logout() {
		let ctx = UiContext::default();
		let mut picker =
			ProviderPicker::open(vec![provider("openai", "OpenAI", true)], ProviderMode::Logout, &ctx);
		assert!(text(&mut picker).contains("Select provider to logout"));
		assert_eq!(picker.key(Key::Enter), PanelEvent::Finish(sf!("logout openai")));
	}

	#[test]
	fn empty_provider_picker_closes_on_enter() {
		let ctx = UiContext::default();
		let mut picker = ProviderPicker::open(Vec::new(), ProviderMode::Login, &ctx);
		assert!(text(&mut picker).contains(NO_LOGIN_PROVIDERS));
		assert_eq!(picker.key(Key::Enter), PanelEvent::Close);
	}
}
