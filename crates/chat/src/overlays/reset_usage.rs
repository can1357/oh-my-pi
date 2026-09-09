//! Saved-reset account selector for `/usage reset`.

use std::time::Duration;

use omp_core::{Str, sf};
use omp_tui::{Frame, Key, Size, Ui, UiContext, dom};

use super::{
	Outcome, Panel, PanelAnchor, PanelCx, PanelEvent, PanelNote,
	services::{Mutation, Pending, ResetAccountRow},
};
use crate::host::HostCommand;

const POLL: Duration = Duration::from_millis(100);
const ID: &str = "usage-reset";

/// Modal confirmation selector for spending one saved reset credit.
pub struct ResetUsageSelector {
	pending:   Option<Pending<Vec<ResetAccountRow>>>,
	rows:      Vec<ResetAccountRow>,
	selected:  usize,
	awaiting:  Option<Str>,
	status:    Option<Str>,
	next_wake: Option<Duration>,
	ui:        Ui,
	ctx:       UiContext,
	width:     u16,
}

impl ResetUsageSelector {
	/// Starts loading the redeemable account roster from the controller feed.
	pub fn open(cx: &PanelCx<'_>) -> Result<Self, Str> {
		let pending = cx
			.services
			.reset_accounts()
			.map_err(|error| sf!("{error}"))?;
		Ok(Self::new(pending, cx.ui))
	}

	fn new(pending: Pending<Vec<ResetAccountRow>>, ctx: &UiContext) -> Self {
		let mut panel = Self {
			pending:   Some(pending),
			rows:      Vec::new(),
			selected:  0,
			awaiting:  None,
			status:    None,
			next_wake: Some(Duration::ZERO),
			ui:        Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx:       ctx.clone(),
			width:     80,
		};
		panel.rebuild();
		panel
	}

	fn step(&mut self, delta: isize) {
		if self.rows.is_empty() || self.awaiting.is_some() {
			return;
		}
		self.selected =
			(self.selected as isize + delta).rem_euclid(self.rows.len() as isize) as usize;
		self.status = None;
		self.rebuild();
	}

	fn confirm(&mut self) -> PanelEvent {
		if self.pending.is_some() || self.awaiting.is_some() {
			return PanelEvent::Consumed;
		}
		let Some(row) = self.rows.get(self.selected) else {
			return PanelEvent::Consumed;
		};
		if row.available == 0 {
			self.status = Some(sf!("{} has no saved resets to spend", row.label));
			self.rebuild();
			return PanelEvent::Consumed;
		}
		let target = row.target.clone();
		self.awaiting = Some(target.clone());
		self.status = Some(sf!("Redeeming one saved reset for {}…", row.label));
		self.rebuild();
		PanelEvent::Command(HostCommand::Service(Mutation::ResetUsage { target }))
	}

	fn rebuild(&mut self) {
		let rows = self
			.rows
			.iter()
			.enumerate()
			.map(|(index, row)| (index == self.selected, row.label.clone(), row.available, row.active))
			.collect::<Vec<_>>();
		let loading = self.pending.is_some();
		let status = self.status.clone();
		let tree = dom! {
			<box border=round title="Spend Saved Reset" pad-x=1>
				<col>
					if loading { <text fg=muted>{"Loading saved resets…"}</text> }
					for (selected, label, available, active) in rows {
						<row>
							if selected { <icon name="cursor" fg=accent/> } else { <pre>{"  "}</pre> }
							<pre fg={if available == 0 { "muted" } else if selected { "accent" } else { "text" }}>{label}</pre>
							if active { <pre fg=muted>{" (active)"}</pre> }
							<pre fg=muted>{"  "}{sf!("{available} saved")}</pre>
						</row>
					}
					if !loading && self.rows.is_empty() { <text fg=muted>{"No Codex accounts found"}</text> }
					<text fg=muted>{"↑/↓ select · Enter confirm and spend one credit · Esc cancel"}</text>
					if let Some(status) = status { <text fg=warn wrap>{status}</text> }
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}
}

impl Panel for ResetUsageSelector {
	fn id(&self) -> &'static str {
		ID
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
			Key::Enter => self.confirm(),
			_ => PanelEvent::Consumed,
		}
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		let PanelNote::Outcome(Outcome::Service(outcome)) = note else {
			return PanelEvent::Ignored;
		};
		let Mutation::ResetUsage { target } = &outcome.mutation else {
			return PanelEvent::Ignored;
		};
		if self.awaiting.as_ref() != Some(target) {
			return PanelEvent::Ignored;
		}
		self.awaiting = None;
		match &outcome.result {
			Ok(line) => {
				if let Some(row) = self.rows.get_mut(self.selected) {
					row.available = row.available.saturating_sub(1);
				}
				self.status = Some(line.clone());
			},
			Err(error) => self.status = Some(sf!("Reset failed: {error}")),
		}
		self.rebuild();
		PanelEvent::Consumed
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if self.width != viewport.width {
			self.width = viewport.width;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		let Some(pending) = self.pending.as_ref() else {
			return false;
		};
		match pending.try_recv() {
			Ok(Ok(rows)) => {
				self.rows = rows;
				self.selected = self
					.rows
					.iter()
					.position(|row| row.available > 0)
					.unwrap_or(0);
				self.pending = None;
				self.next_wake = None;
				self.rebuild();
				true
			},
			Ok(Err(error)) => {
				self.pending = None;
				self.next_wake = None;
				self.status = Some(sf!("Could not load saved resets: {error}"));
				self.rebuild();
				true
			},
			Err(flume::TryRecvError::Disconnected) => {
				self.pending = None;
				self.next_wake = None;
				self.status = Some(Str::new_static("Saved-reset lookup was cancelled"));
				self.rebuild();
				true
			},
			Err(flume::TryRecvError::Empty) => {
				self.next_wake = Some(now + POLL);
				false
			},
		}
	}

	fn next_wake(&self) -> Option<Duration> {
		self.next_wake
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn preselects_redeemable_and_requires_confirmation_enter() {
		let (tx, rx) = flume::bounded(1);
		tx.send(Ok(vec![
			ResetAccountRow {
				target:    "empty".into(),
				label:     "empty".into(),
				available: 0,
				active:    true,
			},
			ResetAccountRow {
				target:    "ready".into(),
				label:     "ready".into(),
				available: 2,
				active:    false,
			},
		]))
		.unwrap();
		let mut panel = ResetUsageSelector::new(rx, &UiContext::default());
		assert!(panel.tick(Duration::ZERO));
		assert_eq!(panel.selected, 1);
		assert_eq!(
			panel.key(Key::Enter),
			PanelEvent::Command(HostCommand::Service(Mutation::ResetUsage { target: "ready".into() }))
		);
	}

	#[test]
	fn zero_credit_account_cannot_emit_redemption() {
		let (tx, rx) = flume::bounded(1);
		tx.send(Ok(vec![ResetAccountRow {
			target:    "empty".into(),
			label:     "empty".into(),
			available: 0,
			active:    true,
		}]))
		.unwrap();
		let mut panel = ResetUsageSelector::new(rx, &UiContext::default());
		panel.tick(Duration::ZERO);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Consumed);
		assert!(panel.awaiting.is_none());
	}
}
