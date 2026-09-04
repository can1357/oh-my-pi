//! Host-side application of a posted [`CommandAction`]: guards read the
//! detached replica, presentation effects (notices, panels, composer
//! submits) stay observer-local, and everything that mutates the session
//! goes to the controller as one [`HostCommand`] (ADR 0005).

use std::{fmt::Write as _, path::PathBuf, time::Duration};

use omp_core::{Str, StrMut};
use omp_dom::{Dom, Handle, KnownTag, PropId, PropKey, Tag, Value};

use super::{
	CommandAction, CompactionMethod, GoalOp, LoopLimit, Selector, SessionOp, TodoOp,
	plan::DEFAULT_PLAN,
};
use crate::{
	actions::HostAction,
	host::{HostCommand, HostError, Presenter, Routed, SpawnKind},
	notices::format_duration,
	overlays::{
		PanelOpener,
		move_panel::MovePanel,
		plan_review::PlanReviewPanel,
		report::ReportPanel,
		services::{ForeignSessionSource, Mutation},
		session_info::SessionInfoPanel,
		sessions::{ForeignSessionPicker, SessionPicker},
		side::SidePanel,
		tree::TreePanel,
	},
	status_line::StatusLine,
};

/// Mutual-exclusion warnings.
const EXIT_PLAN_FIRST: &str = "Exit plan mode first.";
const EXIT_GOAL_FIRST: &str = "Exit goal mode first.";
const EXIT_VIBE_FIRST: &str = "Exit vibe mode first.";
/// Streaming guards.
const WAIT_BEFORE_HANDOFF: &str =
	"Wait for the current response to finish or abort it before handing off.";
const WAIT_BEFORE_FORK: &str =
	"Wait for the current response to finish or abort it before forking.";
const WAIT_BEFORE_FRESH: &str =
	"Wait for the current response to finish or abort it before refreshing provider state.";
const WAIT_BEFORE_RESET: &str =
	"Wait for the current response to finish or abort it before resetting the context.";
const WAIT_BEFORE_MOVE: &str = "Wait for the current response to finish or abort it before moving.";
const WAIT_BEFORE_WORKTREE: &str =
	"Wait for the current response to finish or abort it before creating a worktree.";
/// Empty `/jobs` notice.
const NO_JOBS: &str = "No background jobs running. (Background jobs run async tools — e.g. \
                       long-running bash, debug, or task subagents that would otherwise tie up a \
                       turn. They appear here while alive and for ~5 minutes after.)";
/// Guided-goal interview prompt.
const GUIDED_GOAL_INTERVIEW: &str = include_str!("../../prompts/guided-goal-interview.md");
/// Emergency steering rule the kernel enforces on this host.
const OMFG_RULE: &str = include_str!("../../prompts/omfg-rule.md");

/// `/vibe` Director family as journaled under `<meta><directors>`.
pub const VIBE: &str = "vibe";
/// `/goal` family.
pub const GOAL: &str = "goal";
/// `/loop` family.
pub const LOOP: &str = "loop_mode";
/// `/force` family.
pub const FORCE: &str = "force_tool";

/// Whether a Director family is engaged (status `active`) anywhere under
/// `<meta><directors>` (frames nest, so the scan is recursive).
#[must_use]
pub fn director_active(dom: &Dom, family: &str) -> bool {
	director_frame(dom, family)
		.and_then(|handle| dom.get(handle))
		.is_some_and(|node| custom(node, "status") == Some("active"))
}

/// The engaged (active or paused) frame of one Director family.
#[must_use]
pub fn director_frame(dom: &Dom, family: &str) -> Option<Handle> {
	let directors = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Directors))
	})?;
	let mut stack = vec![directors];
	while let Some(parent) = stack.pop() {
		for child in dom.children(parent).iter().copied() {
			let Some(node) = dom.get(child) else { continue };
			if node.tag != Tag::Known(KnownTag::Director) {
				continue;
			}
			if custom(node, "family") == Some(family)
				&& matches!(custom(node, "status"), Some("active" | "paused"))
			{
				return Some(child);
			}
			stack.push(child);
		}
	}
	None
}

/// User plus assistant message count on the live chain for the empty-session
/// preflight.
#[must_use]
pub fn message_count(dom: &Dom) -> usize {
	dom.children(dom.body())
		.iter()
		.flat_map(|turn| dom.children(*turn).iter())
		.filter(|handle| {
			dom.get(**handle).is_some_and(|node| {
				matches!(node.tag, Tag::Known(KnownTag::User | KnownTag::Assistant))
			})
		})
		.count()
}

fn custom<'a>(node: &'a omp_dom::Node, key: &'static str) -> Option<&'a str> {
	node
		.prop(&PropKey::Custom(Str::new_static(key)))
		.and_then(Value::as_str)
}

fn state<'a>(node: &'a omp_dom::Node, key: &str) -> Option<&'a Value> {
	node.prop(&PropKey::Custom(Str::new(format!("state/{key}"))))
}

impl Presenter {
	/// Applies one slash-command request.
	pub(crate) fn run_command(&mut self, action: CommandAction) -> Result<Routed, HostError> {
		Ok(match action {
			CommandAction::Plan { prompt } => self.plan(prompt),
			CommandAction::PlanReview => self.plan_review()?,
			CommandAction::PlanApprove { role, compact, keep } => {
				self.plan_approve(role, compact, keep)
			},
			CommandAction::Vibe { prompt } => self.vibe(prompt),
			CommandAction::Goal(op) => self.goal(op)?,
			CommandAction::GuidedGoal { initial } => self.guided_goal(initial),
			CommandAction::Loop { limit, prompt } => self.loop_mode(limit, prompt),
			CommandAction::Queue { prompt } => {
				let active = self.turn_active;
				let _ = self
					.commands
					.send(HostCommand::Queue { prompt, attachments: Vec::new() });
				self.notice(if active {
					"Queued message for when the agent yields"
				} else {
					"Sent queued message"
				})
			},
			CommandAction::Prompt { text } => self.submit(text),
			CommandAction::SkillPrompt { prompt } => self.submit_skill_prompt(prompt),
			CommandAction::Force { tool, prompt } => {
				let _ = self.commands.send(HostCommand::Director {
					id:     Str::new_static(FORCE),
					engage: true,
					args:   vec![tool.clone()],
				});
				let routed = self.notice(format!("Next turn forced to use {tool}."));
				match prompt {
					Some(prompt) => routed.max(self.submit(prompt)),
					None => routed,
				}
			},
			CommandAction::Pause => self.pause()?,
			CommandAction::PauseResume { held_ms } => {
				let _ = self.commands.send(HostCommand::Pause { active: false });
				let held = crate::overlays::pause::PausePanel::duration(Duration::from_millis(held_ms));
				self.notice(format!("Resumed after {held} — agents are running again."))
			},
			CommandAction::Compact { method, focus } => self.compact(method, focus),
			CommandAction::New => {
				let _ = self.commands.send(HostCommand::SessionNew { model: None });
				Routed::Repaint
			},
			CommandAction::Fresh => {
				if self.turn_active {
					return Ok(self.notice(WAIT_BEFORE_FRESH));
				}
				// This kernel keeps no provider-side conversation state: every
				// inference is projected from the journal, so there is nothing
				// to prune and the report is exact.
				self.notice("Fresh provider session started (0 provider states pruned).")
			},
			CommandAction::Drop => {
				if !self.session_persisted() {
					return Ok(self.notice("Nothing to drop (in-memory session)"));
				}
				let _ = self.commands.send(HostCommand::SessionDrop);
				Routed::Repaint
			},
			CommandAction::Resume { id } => self.resume(id)?,
			CommandAction::Select(Selector::Rewind | Selector::Tree) => {
				self.act(HostAction::Open(PanelOpener::new(|cx| {
					TreePanel::open(cx).map(|panel| Box::new(panel) as Box<_>)
				})))?
			},
			CommandAction::Fork { target } => {
				if self.turn_active {
					return Ok(self.notice(WAIT_BEFORE_FORK));
				}
				let _ = self.commands.send(HostCommand::Fork { target });
				Routed::Repaint
			},
			CommandAction::Rewind { target, recall } => {
				let _ = self.commands.send(HostCommand::Rewind { target });
				if let Some(text) = recall {
					self.composer.set_text(text.as_str());
				}
				Routed::Repaint
			},
			CommandAction::SessionRename { id, title } => {
				let _ = self
					.commands
					.send(HostCommand::Service(Mutation::RenameSession { id, title }));
				Routed::Repaint
			},
			CommandAction::SessionDelete { id } => {
				let _ = self
					.commands
					.send(HostCommand::Service(Mutation::DeleteSession { id }));
				Routed::Repaint
			},
			CommandAction::Rename { title } => {
				let _ = self
					.commands
					.send(HostCommand::Rename { title: title.clone() });
				self.notice(format!("Session renamed to \"{title}\"."))
			},
			CommandAction::Session(op) => self.session(op)?,
			CommandAction::Jobs => self.jobs()?,
			CommandAction::Todo(op) => self.todo(op)?,
			CommandAction::Btw { question } => {
				let context = conversation_context(&self.replica);
				let question_for_panel = question.clone();
				self.act(HostAction::Open(PanelOpener::new(move |cx| {
					let events = cx
						.services
						.btw(question_for_panel.as_str(), context.as_str())
						.map_err(|error| Str::new(error.to_string()))?;
					Ok(Box::new(SidePanel::btw(question_for_panel.clone(), events, cx)) as Box<_>)
				})))?
			},
			CommandAction::Tan { task } => {
				let _ = self
					.commands
					.send(HostCommand::Spawn { kind: SpawnKind::Tan, text: task });
				Routed::Repaint
			},
			CommandAction::Omfg { rule } => {
				let text = Str::new(OMFG_RULE.replace("{{complaint}}", rule.as_str()));
				let _ = self.commands.send(HostCommand::Steer(text));
				self.notice("Rule steered into the session; it applies from the next safe point.")
			},
			CommandAction::Clear => {
				if self.turn_active {
					return Ok(self.notice(WAIT_BEFORE_RESET));
				}
				let _ = self.commands.send(HostCommand::ContextReset);
				Routed::Repaint
			},
			CommandAction::Move { path } => {
				if self.turn_active {
					return Ok(self.notice(WAIT_BEFORE_MOVE));
				}
				let Some(path) = path else {
					return self.act(HostAction::Open(PanelOpener::new(|cx| {
						let cwd = cx
							.services
							.project_dir()
							.or_else(|_| std::env::current_dir())
							.unwrap_or_else(|_| PathBuf::from("."));
						Ok(Box::new(MovePanel::open(cwd, cx.viewport, cx.ui)) as Box<_>)
					})));
				};
				let cwd = self
					.services
					.project_dir()
					.or_else(|_| std::env::current_dir())
					.unwrap_or_else(|_| PathBuf::from("."));
				let resolved = super::workspace::resolve_to_cwd(path.as_str(), &cwd);
				if resolved.is_dir() {
					let _ = self
						.commands
						.send(HostCommand::Move { path: resolved, create: false });
					return Ok(Routed::Repaint);
				}
				if resolved.exists() {
					return Ok(self.notice(format!("Not a directory: {}", resolved.display())));
				}
				let parent = resolved
					.parent()
					.unwrap_or_else(|| std::path::Path::new(""));
				if !parent.is_dir() {
					let name = resolved
						.file_name()
						.and_then(|name| name.to_str())
						.unwrap_or_default();
					return Ok(
						self.notice(format!("Cannot create \"{name}\": parent directory does not exist"))
					);
				}
				self.act(HostAction::Open(PanelOpener::new(move |cx| {
					Ok(Box::new(MovePanel::confirm(resolved.clone(), cx.viewport, cx.ui)) as Box<_>)
				})))?
			},
			CommandAction::Worktree { branch } => {
				if self.turn_active {
					return Ok(self.notice(WAIT_BEFORE_WORKTREE));
				}
				let branch = branch.unwrap_or_else(super::workspace::default_worktree_branch);
				match self.services.create_worktree(branch.as_str()) {
					Ok(worktree) => {
						let _ = self
							.commands
							.send(HostCommand::Move { path: worktree.path.clone(), create: false });
						self.notice(format!(
							"Moved to worktree {} on branch {} (checked out, uncommitted changes carried \
							 over).",
							worktree.path.display(),
							worktree.branch
						))
					},
					Err(error) => self.notice(format!("Worktree creation failed: {error}")),
				}
			},
		})
	}

	fn session_persisted(&self) -> bool {
		!StatusLine::from_dom(&self.replica).session.is_empty()
	}

	fn plan(&mut self, prompt: Option<Str>) -> Routed {
		let dom = &self.replica;
		if director_active(dom, GOAL) {
			return self.notice(EXIT_GOAL_FIRST);
		}
		if director_active(dom, VIBE) {
			return self.notice(EXIT_VIBE_FIRST);
		}
		if self.plan_engaged() {
			let _ = self.commands.send(HostCommand::PlanMode { engage: false });
			return self.notice("Plan mode paused.");
		}
		let _ = self.commands.send(HostCommand::PlanMode { engage: true });
		let routed = self.notice(format!("Plan mode enabled. Plan file: {DEFAULT_PLAN}"));
		match prompt {
			Some(prompt) => routed.max(self.submit(prompt)),
			None => routed,
		}
	}

	fn plan_review(&mut self) -> Result<Routed, HostError> {
		if !self.plan_engaged() {
			return Ok(self.notice("Plan mode is not active."));
		}
		let cycle = self
			.cycle
			.iter()
			.map(|(role, model, _)| (role.clone(), model.clone()))
			.collect::<Vec<_>>();
		self.act(HostAction::Open(PanelOpener::new(move |cx| {
			PlanReviewPanel::open(cx, &cycle).map(|panel| Box::new(panel) as Box<_>)
		})))
	}

	/// Plan-review verdicts: approving exits plan mode,
	/// optionally switches `ai_model` to the slider's role, optionally
	/// compacts first, then submits the execution prompt.
	fn plan_approve(&mut self, role: Option<Str>, compact: bool, keep: bool) -> Routed {
		if !self.plan_engaged() {
			return self.notice("Plan mode is not active.");
		}
		let _ = self.commands.send(HostCommand::Director {
			id:     Str::new_static("plan"),
			engage: false,
			args:   Vec::new(),
		});
		if let Some(role) = role
			&& let Some((_, model, _)) = self.cycle.iter().find(|(name, ..)| *name == role)
			&& let Err(error) = omp_agent::AI_MODEL.set(&self.con, model.clone())
		{
			return self.notice(format!("Could not switch to the {role} model: {error}"));
		}
		if compact {
			let _ = self.commands.send(HostCommand::Compact {
				method: CompactionMethod::Compact,
				hint:   Some(Str::new_static(
					"Keep every decision and open question from the approved plan.",
				)),
			});
		}
		let prompt = if keep {
			"Execute the approved plan at local://PLAN.md, keeping the full planning context in mind."
		} else {
			"Execute the approved plan at local://PLAN.md."
		};
		let routed = self.notice("Plan approved.");
		routed.max(self.submit(Str::new_static(prompt)))
	}

	fn vibe(&mut self, prompt: Option<Str>) -> Routed {
		if director_active(&self.replica, VIBE) {
			let _ = self.commands.send(HostCommand::Director {
				id:     Str::new_static(VIBE),
				engage: false,
				args:   Vec::new(),
			});
			return self.notice("Vibe mode disabled.");
		}
		if self.plan_engaged() {
			return self.notice(EXIT_PLAN_FIRST);
		}
		if director_active(&self.replica, GOAL) {
			return self.notice(EXIT_GOAL_FIRST);
		}
		let _ = self.commands.send(HostCommand::Director {
			id:     Str::new_static(VIBE),
			engage: true,
			args:   Vec::new(),
		});
		let routed = self.notice(
			"Vibe mode enabled. You direct fast/good worker sessions; toolset is read + optional \
			 parent Todo + vibe tools.",
		);
		match prompt {
			Some(prompt) => routed.max(self.submit(prompt)),
			None => routed,
		}
	}

	fn goal(&mut self, op: GoalOp) -> Result<Routed, HostError> {
		let frame = director_frame(&self.replica, GOAL);
		let engage =
			|args: Vec<Str>| HostCommand::Director { id: Str::new_static(GOAL), engage: true, args };
		Ok(match op {
			GoalOp::Menu => match frame {
				Some(_) => self.goal_show(),
				None => self.notice("Usage: /goal <objective> — or /guided-goal for an interview"),
			},
			GoalOp::Set(objective) => {
				if frame.is_some() && !director_active(&self.replica, GOAL) {
					return Ok(self.notice(
						"Resume the current goal first, or drop it before setting a new objective.",
					));
				}
				if self.plan_engaged() {
					return Ok(self.notice(EXIT_PLAN_FIRST));
				}
				if director_active(&self.replica, VIBE) {
					return Ok(self.notice(EXIT_VIBE_FIRST));
				}
				let _ = self
					.commands
					.send(engage(vec![Str::new_static("set"), objective.clone()]));
				self.notice(if frame.is_some() {
					format!("Goal replaced: {objective}")
				} else {
					format!("Goal mode enabled: {objective}")
				})
			},
			GoalOp::Show => match frame {
				Some(_) => self.goal_show(),
				None => self.notice("No active goal."),
			},
			GoalOp::Pause => match frame.filter(|_| director_active(&self.replica, GOAL)) {
				Some(_) => {
					let _ = self.commands.send(engage(vec![Str::new_static("pause")]));
					self.notice("Goal paused.")
				},
				None => self.notice("No active goal to pause."),
			},
			GoalOp::Resume => match frame.filter(|handle| {
				self
					.replica
					.get(*handle)
					.is_some_and(|node| custom(node, "status") == Some("paused"))
			}) {
				Some(_) => {
					let _ = self.commands.send(engage(vec![Str::new_static("resume")]));
					self.notice("Goal resumed.")
				},
				None => self.notice("No paused goal to resume."),
			},
			GoalOp::Drop => match frame {
				Some(_) => {
					let _ = self.commands.send(HostCommand::Director {
						id:     Str::new_static(GOAL),
						engage: false,
						args:   Vec::new(),
					});
					self.notice("Goal dropped.")
				},
				None => self.notice("No goal to drop."),
			},
			GoalOp::Budget(budget) => match frame {
				None => self.notice("No active goal."),
				Some(_) if !director_active(&self.replica, GOAL) => {
					self.notice("Resume the goal before adjusting the budget.")
				},
				Some(_) => {
					let mut args = vec![Str::new_static("budget")];
					if let Some(budget) = budget {
						args.push(Str::new(budget.to_string()));
					}
					let _ = self.commands.send(engage(args));
					self.notice(match budget {
						Some(budget) => format!("Goal budget set to {budget}."),
						None => "Goal budget cleared.".to_owned(),
					})
				},
			},
		})
	}

	fn goal_show(&mut self) -> Routed {
		let Some(handle) = director_frame(&self.replica, GOAL) else {
			return self.notice("No active goal.");
		};
		let Some(node) = self.replica.get(handle) else {
			return self.notice("No active goal.");
		};
		let objective = state(node, "objective")
			.and_then(Value::as_str)
			.unwrap_or_default();
		let int = |key: &str| match state(node, key) {
			Some(Value::Int(value)) => Some(*value),
			_ => None,
		};
		let used = int("tokens_used").unwrap_or(0).max(0);
		let budget = int("token_budget").filter(|budget| *budget >= 0);
		let done = matches!(state(node, "done"), Some(Value::Bool(true)));
		let dropped = matches!(state(node, "dropped"), Some(Value::Bool(true)));
		let paused = custom(node, "status") == Some("paused");
		let status = if dropped {
			"dropped"
		} else if done {
			"complete"
		} else if paused {
			"paused"
		} else if budget.is_some_and(|budget| used >= budget) {
			"budget-limited"
		} else {
			"active"
		};
		let tokens = match budget {
			Some(budget) => format!("{used} / {budget} ({} left)", budget.saturating_sub(used)),
			None => format!("{used} (no budget)"),
		};
		self.notice(format!("Objective: {objective} · Status: {status} · Tokens: {tokens}"))
	}

	fn guided_goal(&mut self, initial: Option<Str>) -> Routed {
		if self.plan_engaged() {
			return self.notice(EXIT_PLAN_FIRST);
		}
		if director_active(&self.replica, VIBE) {
			return self.notice(EXIT_VIBE_FIRST);
		}
		if director_active(&self.replica, GOAL) {
			return self.notice(
				"Goal mode is already active. Use /goal to manage it, or /goal drop to start over.",
			);
		}
		let mut prompt = StrMut::new(GUIDED_GOAL_INTERVIEW.trim_end());
		if let Some(initial) = initial {
			prompt.push_str("\n\nRough objective from the user:\n");
			prompt.push_str(initial.as_str());
		}
		self.submit(prompt.freeze())
	}

	fn loop_mode(&mut self, limit: Option<LoopLimit>, prompt: Option<Str>) -> Routed {
		if director_active(&self.replica, LOOP) {
			let _ = self.commands.send(HostCommand::Director {
				id:     Str::new_static(LOOP),
				engage: false,
				args:   Vec::new(),
			});
			return self.notice("Loop mode disabled.");
		}
		let mut args = match limit {
			None => vec![Str::new_static("unbounded")],
			Some(LoopLimit::Iterations(count)) => {
				vec![Str::new_static("iterations"), Str::new(count.to_string())]
			},
			Some(LoopLimit::DurationMs(duration)) => {
				vec![Str::new_static("duration_ms"), Str::new(duration.to_string())]
			},
		};
		if let Some(prompt) = &prompt {
			args.push(prompt.clone());
		}
		let _ = self.commands.send(HostCommand::Director {
			id: Str::new_static(LOOP),
			engage: true,
			args,
		});
		let mut text = StrMut::new("Loop mode enabled.");
		match limit {
			Some(LoopLimit::Iterations(count)) => {
				let _ = write!(text, " Limit: {count} iterations.");
			},
			Some(LoopLimit::DurationMs(duration)) => {
				let _ = write!(text, " Limit: {}.", format_duration(duration));
			},
			None => {},
		}
		text.push_str(if prompt.is_some() {
			" Repeating it after each turn."
		} else {
			" Your next prompt will repeat after each turn."
		});
		text.push_str(" Esc cancels the current iteration; /loop again to disable.");
		let routed = self.notice(text.freeze());
		match prompt {
			Some(prompt) => routed.max(self.submit(prompt)),
			None => routed,
		}
	}

	fn pause(&mut self) -> Result<Routed, HostError> {
		let _ = self.commands.send(HostCommand::Pause { active: true });
		let session_name = StatusLine::from_dom(&self.replica).name;
		self.act(HostAction::Open(PanelOpener::new(move |cx| {
			Ok(Box::new(crate::overlays::pause::PausePanel::open(session_name.clone(), cx)) as Box<_>)
		})))
	}

	fn compact(&mut self, method: CompactionMethod, focus: Option<Str>) -> Routed {
		let count = message_count(&self.replica);
		match method {
			CompactionMethod::Compact if count < 2 => {
				return self.notice("Nothing to compact (no messages yet)");
			},
			CompactionMethod::Handoff if self.turn_active => return self.notice(WAIT_BEFORE_HANDOFF),
			CompactionMethod::Handoff if count < 2 => {
				return self.notice("Nothing to hand off (no messages yet)");
			},
			CompactionMethod::Shake if count == 0 => return self.notice("Nothing to shake."),
			_ => {},
		}
		let _ = self
			.commands
			.send(HostCommand::Compact { method, hint: focus });
		self.notice(match method {
			CompactionMethod::Compact => "Compacting context... (esc to cancel)",
			CompactionMethod::Handoff => "Generating handoff… (esc to cancel)",
			CompactionMethod::Shake => "Shaking context…",
		})
	}

	fn resume(&mut self, id: Option<Str>) -> Result<Routed, HostError> {
		let Some(id) = id else {
			return self.act(HostAction::Open(PanelOpener::new(|cx| {
				SessionPicker::open(cx).map(|panel| Box::new(panel) as Box<_>)
			})));
		};
		let foreign = id
			.as_str()
			.strip_prefix('@')
			.and_then(|source| source.parse::<ForeignSessionSource>().ok());
		if let Some(source) = foreign {
			return self.act(HostAction::Open(PanelOpener::new(move |cx| {
				ForeignSessionPicker::open(source, cx).map(|panel| Box::new(panel) as Box<_>)
			})));
		}
		let direct = PathBuf::from(id.as_str());
		let path = if direct.extension().is_some() && direct.is_file() {
			Some(direct)
		} else {
			self
				.services
				.sessions(crate::overlays::services::SessionScope::Project)
				.ok()
				.into_iter()
				.flatten()
				.find(|row| row.id == id || row.title.as_deref() == Some(id.as_str()))
				.map(|row| row.path)
		};
		Ok(match path {
			Some(path) => {
				let _ = self.commands.send(HostCommand::SessionOpen { path });
				Routed::Repaint
			},
			None => self.notice(format!("Session \"{id}\" not found")),
		})
	}

	fn session(&mut self, op: SessionOp) -> Result<Routed, HostError> {
		match op {
			SessionOp::Info => {
				let body = session_info(&self.replica, self.services.as_ref());
				self.act(HostAction::Open(PanelOpener::new(move |cx| {
					Ok(Box::new(SessionInfoPanel::new(body.clone(), cx.ui)) as Box<_>)
				})))
			},
			SessionOp::Delete => {
				if self.turn_active {
					return Ok(self.notice("Cannot delete the session while streaming."));
				}
				if !self.session_persisted() {
					return Ok(self.notice("No session file to delete (in-memory session)."));
				}
				let _ = self.commands.send(HostCommand::SessionDrop);
				let routed = self.notice("Session deleted");
				Ok(routed.max(self.act(HostAction::Open(PanelOpener::new(|cx| {
					SessionPicker::open(cx).map(|panel| Box::new(panel) as Box<_>)
				})))?))
			},
			SessionOp::Pin(account) => {
				let line = match account {
					Some(account) => format!("pin {account}"),
					None => "pin".to_owned(),
				};
				self.run_console(line.as_str())
			},
		}
	}

	fn jobs(&mut self) -> Result<Routed, HostError> {
		let body = jobs_report(&self.replica);
		let Some(body) = body else {
			return Ok(self.notice(NO_JOBS));
		};
		self.act(HostAction::Open(PanelOpener::new(move |cx| {
			Ok(Box::new(ReportPanel::new("jobs", "Background Jobs", body.clone(), cx.ui)) as Box<_>)
		})))
	}

	fn todo(&mut self, op: TodoOp) -> Result<Routed, HostError> {
		match op {
			TodoOp::List => {
				let body = todo_markdown(&self.replica);
				let body = if body.is_empty() {
					Str::new_static("_No todos._")
				} else {
					body
				};
				self.act(HostAction::Open(PanelOpener::new(move |cx| {
					Ok(Box::new(ReportPanel::new("todo", "Todos", body.clone(), cx.ui)) as Box<_>)
				})))
			},
			TodoOp::Copy => {
				let body = todo_markdown(&self.replica);
				if body.is_empty() {
					return Ok(self.notice("Todos: none"));
				}
				self.clipboard = Some(body);
				Ok(self.notice("Copied todos to clipboard"))
			},
			TodoOp::Export(path) => {
				let path =
					path.map_or_else(|| PathBuf::from("TODO.md"), |path| PathBuf::from(path.as_str()));
				let body = todo_markdown(&self.replica);
				match std::fs::write(&path, body.as_bytes()) {
					Ok(()) => Ok(self.notice(format!("Exported todos to {}", path.display()))),
					Err(error) => Ok(self.notice(format!("Export failed: {error}"))),
				}
			},
			other => {
				let _ = self.commands.send(HostCommand::Todo(other));
				Ok(Routed::Repaint)
			},
		}
	}
}

/// Recent conversation text handed to a `/btw` child so it can "use
/// conversation context already provided": the last six turns' user and
/// assistant text, each clipped.
fn conversation_context(dom: &Dom) -> Str {
	const TURNS: usize = 6;
	const CLIP: usize = 1_200;
	let mut out = StrMut::new("");
	let turns = dom.children(dom.body());
	for turn in turns.iter().rev().take(TURNS).rev() {
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			let role = match node.tag {
				Tag::Known(KnownTag::User) => "user",
				Tag::Known(KnownTag::Assistant) => "assistant",
				_ => continue,
			};
			let text = node
				.content
				.as_deref()
				.or_else(|| node.prop(&PropId::Text.into()).and_then(Value::as_str))
				.unwrap_or_default();
			if text.trim().is_empty() {
				continue;
			}
			let clipped = text
				.char_indices()
				.nth(CLIP)
				.map_or(text, |(end, _)| &text[..end]);
			let _ = writeln!(out, "<{role}>\n{clipped}\n</{role}>");
		}
	}
	out.freeze()
}

/// `/session` info block projected from the replica.
fn session_info(dom: &Dom, services: &dyn crate::overlays::Services) -> Str {
	let status = StatusLine::from_dom(dom);
	let session_id = services.live_session_id().ok().or_else(|| {
		dom.get(dom.meta())
			.and_then(|meta| meta.prop(&PropId::Id.into()))
			.and_then(Value::as_str)
			.filter(|id| !id.is_empty())
			.map(Str::new)
	});
	let stored = services
		.sessions(crate::overlays::services::SessionScope::Project)
		.ok();
	let session_file = session_id.as_ref().and_then(|id| {
		stored
			.as_ref()
			.and_then(|rows| rows.iter().find(|row| row.id == *id))
			.map(|row| Str::new(row.path.to_string_lossy().as_ref()))
			.or_else(|| {
				services
					.sessions(crate::overlays::services::SessionScope::All)
					.ok()?
					.into_iter()
					.find(|row| row.id == *id)
					.map(|row| Str::new(row.path.to_string_lossy().as_ref()))
			})
	});
	let mut out = StrMut::new("");
	if let Some(file) = session_file {
		let link = crate::cards::file_link(&file);
		let _ = writeln!(out, "**File**: [{file}]({link})");
	} else {
		let _ = writeln!(out, "**File**: In-memory");
	}
	if let Some(id) = &session_id {
		let _ = writeln!(out, "**ID**: {id}");
	}
	if let Some(name) = &status.name {
		let _ = writeln!(out, "**Title**: {name}");
	}
	let _ = writeln!(out, "**Model**: {}", status.model);
	let (users, assistants, calls) = dom.children(dom.body()).iter().fold(
		(0usize, 0usize, 0usize),
		|(users, assistants, calls), turn| {
			dom.children(*turn)
				.iter()
				.filter_map(|handle| dom.get(*handle))
				.fold((users, assistants, calls), |(u, a, c), node| match &node.tag {
					Tag::Known(KnownTag::User) => (u + 1, a, c),
					Tag::Known(KnownTag::Assistant) => (u, a + 1, c),
					Tag::Custom(_) => (u, a, c + 1),
					_ => (u, a, c),
				})
		},
	);
	let _ = writeln!(out, "\n### Messages");
	let _ = writeln!(out, "- User: {users}");
	let _ = writeln!(out, "- Assistant: {assistants}");
	let _ = writeln!(out, "- Tool Calls: {calls}");
	let _ = writeln!(out, "- Total: {}", users + assistants + calls);
	let _ = writeln!(out, "\n### Tokens");
	let _ = writeln!(out, "- Input: {}", status.tokens_in);
	let _ = writeln!(out, "- Output: {}", status.tokens_out);
	if status.cache_read > 0 {
		let _ = writeln!(out, "- Cache Read: {}", status.cache_read);
	}
	if status.cache_write > 0 {
		let _ = writeln!(out, "- Cache Write: {}", status.cache_write);
	}
	let _ = writeln!(out, "- Total: {}", status.tokens_in + status.tokens_out);
	if status.cost_nano_usd > 0 {
		let _ = writeln!(out, "\n### Cost");
		let _ = writeln!(out, "- Total: ${:.4}", status.cost_nano_usd as f64 / 1e9);
	}
	if let Some(rows) = stored {
		let _ = writeln!(out, "\n### Stored sessions\n- {} on disk", rows.len());
	}
	out.freeze()
}

/// `/jobs` report from `<meta><jobs>`; `None` when there are no jobs.
fn jobs_report(dom: &Dom) -> Option<Str> {
	let jobs = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Jobs))
	})?;
	let rows = dom
		.children(jobs)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.map(|node| {
			let id = node
				.prop(&PropId::Id.into())
				.and_then(Value::as_str)
				.unwrap_or("?");
			let kind = node
				.prop(&PropId::Kind.into())
				.and_then(Value::as_str)
				.unwrap_or("job");
			let status = node
				.prop(&PropId::Status.into())
				.and_then(Value::as_str)
				.unwrap_or("running");
			let label = custom(node, "agent")
				.or_else(|| custom(node, "owner"))
				.unwrap_or_default();
			(status == "running", format!("  [{id}] {kind} ({status})\n    {label}"))
		})
		.collect::<Vec<_>>();
	if rows.is_empty() {
		return None;
	}
	let running = rows.iter().filter(|(running, _)| *running).count();
	let mut out = StrMut::new("");
	let _ = writeln!(out, "Running: {running}\n");
	let _ = writeln!(out, "### Running Jobs");
	for (_, row) in rows.iter().filter(|(running, _)| *running) {
		let _ = writeln!(out, "{row}");
	}
	let _ = writeln!(out, "\n### Recent Jobs");
	for (_, row) in rows.iter().filter(|(running, _)| !*running) {
		let _ = writeln!(out, "{row}");
	}
	Some(out.freeze())
}

/// `<meta><todo>` as the complete editable Markdown checklist shown by the
/// `/todo` report overlay and written by `copy`/`export`.
#[must_use]
pub fn todo_markdown(dom: &Dom) -> Str {
	use omp_tools::todo::{Phase, Status, Task};

	let Some(todo) = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Todo))
	}) else {
		return Str::new_static("");
	};
	let mut phases = dom
		.get(todo)
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static("phase-order"))))
		.and_then(|value| match value {
			Value::Json(raw) => serde_json::from_str::<Vec<Str>>(raw.get()).ok(),
			_ => None,
		})
		.unwrap_or_default()
		.into_iter()
		.map(|name| Phase { name, tasks: Vec::new() })
		.collect::<Vec<_>>();
	for handle in dom.children(todo) {
		let Some(node) = dom.get(*handle) else {
			continue;
		};
		if node.tag != Tag::Known(KnownTag::Item) {
			continue;
		}
		let phase_name = custom(node, "phase")
			.filter(|name| !name.is_empty())
			.unwrap_or("Tasks");
		let phase_index = phases
			.iter()
			.position(|phase| phase.name == phase_name)
			.unwrap_or_else(|| {
				let index = phases.len();
				phases.push(Phase { name: Str::new(phase_name), tasks: Vec::new() });
				index
			});
		let content = node
			.prop(&PropId::Label.into())
			.and_then(Value::as_str)
			.map_or_else(Str::default, Str::new);
		let status = node
			.prop(&PropId::Status.into())
			.and_then(Value::as_str)
			.and_then(|status| status.parse::<Status>().ok())
			.unwrap_or_default();
		let blocker = node
			.prop(&PropId::Detail.into())
			.and_then(Value::as_str)
			.map(Str::new);
		phases[phase_index]
			.tasks
			.push(Task { content, status, blocker });
	}
	if phases.is_empty() {
		Str::default()
	} else {
		Str::from(omp_tools::todo::render(&phases))
	}
}
