//! Interactive `ask@2` presenter: the tool waits on the host, the host
//! answers the call identity.
//!
//! The pending dialog is not stored here: the tool's own `<ask status=
//! running>` element (its `<input>` carries the questions) is the fact the
//! host projects the dialog from, and the answers become the tool's result
//! through the ordinary dispatch path (ADR 0008). This route only pairs a
//! waiting invocation with the reply the host sends for its call id — the
//! same runtime index shape as [`omp_agent::ApprovalRoute`].

use std::{
	collections::BTreeMap,
	future::Future,
	pin::Pin,
	sync::{Arc, Weak},
};

use omp_core::Str;
use omp_tools::ask::{AskPresenter, Fault, Presentation, Question, Selection};
use parking_lot::Mutex;

/// What the host decided for one pending dialog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AskReply {
	/// Selections in question order.
	Answers(Vec<Selection>),
	/// The user dismissed the dialog (Esc).
	Cancelled,
}

/// Cloneable route between the environment's `ask` tool and the host.
#[derive(Clone, Default)]
pub struct AskRoute {
	pending: Arc<Mutex<BTreeMap<Str, Arc<flume::Sender<AskReply>>>>>,
}

/// Removes one presenter registration when its future completes or is
/// dropped, without disturbing a newer presenter that reused the call id.
struct PendingRegistration {
	pending: Arc<Mutex<BTreeMap<Str, Arc<flume::Sender<AskReply>>>>>,
	id:      Str,
	sender:  Weak<flume::Sender<AskReply>>,
}

impl Drop for PendingRegistration {
	fn drop(&mut self) {
		let Some(sender) = self.sender.upgrade() else {
			return;
		};
		let mut pending = self.pending.lock();
		if pending
			.get(&self.id)
			.is_some_and(|current| Arc::ptr_eq(current, &sender))
		{
			pending.remove(&self.id);
		}
	}
}

impl AskRoute {
	/// Creates an empty route.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Delivers the host's reply for the waiting call `id`. Returns `false`
	/// when no dialog with that identity is waiting (already answered, or
	/// the turn was interrupted).
	pub fn answer(&self, id: &str, reply: AskReply) -> bool {
		let Some(sender) = self.pending.lock().remove(id) else {
			return false;
		};
		sender.try_send(reply).is_ok()
	}

	/// Call identities currently waiting on the host, in filing order.
	#[must_use]
	pub fn pending(&self) -> Vec<Str> {
		self.pending.lock().keys().cloned().collect()
	}
}

impl AskPresenter for AskRoute {
	fn present<'p>(
		&'p self,
		questions: &'p [Question],
		invocation: Option<&'p str>,
	) -> Pin<Box<dyn Future<Output = Result<Presentation, Fault>> + Send + 'p>> {
		Box::pin(async move {
			let Some(id) = invocation else {
				return Err(Fault::Presenter {
					message: Str::new_static("interactive ask requires a call identity"),
				});
			};
			let (reply, response) = flume::bounded(1);
			let sender = Arc::new(reply);
			let registration = PendingRegistration {
				pending: Arc::clone(&self.pending),
				id:      Str::new(id),
				sender:  Arc::downgrade(&sender),
			};
			self
				.pending
				.lock()
				.insert(registration.id.clone(), Arc::clone(&sender));
			drop(sender);
			let outcome = response.recv_async().await;
			match outcome {
				Ok(AskReply::Answers(selections)) => {
					Ok(Presentation { selections: align(questions, selections) })
				},
				Ok(AskReply::Cancelled) => Err(Fault::cancelled()),
				Err(_) => Err(Fault::Presenter {
					message: Str::new_static("ask host went away before answering"),
				}),
			}
		})
	}
}

/// Orders the host's selections like the questions and fills any the host
/// skipped, so the presentation always has one selection per question.
fn align(questions: &[Question], mut selections: Vec<Selection>) -> Vec<Selection> {
	questions
		.iter()
		.map(|question| {
			selections
				.iter()
				.position(|selection| selection.id == question.id)
				.map_or_else(
					|| Selection {
						id:           question.id.clone(),
						selected:     Vec::new(),
						custom_input: None,
						note:         None,
						timed_out:    false,
					},
					|at| selections.swap_remove(at),
				)
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use omp_tools::ask::OptionItem;

	use super::*;

	fn question(id: &'static str) -> Question {
		Question {
			id:          Str::new_static(id),
			question:    Str::new_static("Which?"),
			header:      None,
			options:     vec![OptionItem {
				label:       Str::new_static("A"),
				description: None,
				preview:     None,
			}],
			multi:       false,
			recommended: Some(0),
		}
	}

	#[tokio::test]
	async fn answers_reach_the_waiting_call_by_identity_in_question_order() {
		let route = AskRoute::new();
		let questions = [question("first"), question("second")];
		let waiting = {
			let route = route.clone();
			let questions = questions.clone();
			tokio::spawn(async move { route.present(&questions, Some("call-1")).await })
		};
		while route.pending().is_empty() {
			tokio::task::yield_now().await;
		}
		assert!(!route.answer("call-9", AskReply::Cancelled), "unknown identity is ignored");
		assert!(route.answer(
			"call-1",
			AskReply::Answers(vec![Selection {
				id:           Str::new_static("second"),
				selected:     vec![Str::new_static("A")],
				custom_input: None,
				note:         None,
				timed_out:    false,
			}]),
		));
		let presentation = waiting.await.expect("task").expect("answered");
		assert_eq!(presentation.selections.len(), 2);
		assert_eq!(presentation.selections[0].id, "first");
		assert!(presentation.selections[0].selected.is_empty());
		assert_eq!(presentation.selections[1].selected, [Str::new_static("A")]);
		assert!(route.pending().is_empty());
	}

	#[tokio::test]
	async fn dropping_presenter_unregisters_call_and_allows_same_id_reuse() {
		let route = AskRoute::new();
		let questions = [question("only")];
		let mut abandoned = route.present(&questions, Some("call-reused"));
		assert!(futures::poll!(abandoned.as_mut()).is_pending());
		assert_eq!(route.pending(), [Str::new_static("call-reused")]);

		drop(abandoned);
		assert!(route.pending().is_empty());

		let mut replacement = route.present(&questions, Some("call-reused"));
		assert!(futures::poll!(replacement.as_mut()).is_pending());
		assert!(route.answer(
			"call-reused",
			AskReply::Answers(vec![Selection {
				id:           Str::new_static("only"),
				selected:     vec![Str::new_static("A")],
				custom_input: None,
				note:         None,
				timed_out:    false,
			}]),
		));
		let presentation = replacement.await.expect("replacement answered");
		assert_eq!(presentation.selections[0].selected, [Str::new_static("A")]);
		assert!(route.pending().is_empty());
	}

	#[tokio::test]
	async fn completed_presenter_does_not_remove_a_new_same_id_registration() {
		let route = AskRoute::new();
		let questions = [question("only")];
		let mut first = route.present(&questions, Some("call-race"));
		assert!(futures::poll!(first.as_mut()).is_pending());
		assert!(route.answer("call-race", AskReply::Answers(Vec::new())));

		let mut second = route.present(&questions, Some("call-race"));
		assert!(futures::poll!(second.as_mut()).is_pending());
		first.await.expect("first answered");
		assert_eq!(route.pending(), [Str::new_static("call-race")]);

		assert!(route.answer("call-race", AskReply::Answers(Vec::new())));
		second.await.expect("second answered");
		assert!(route.pending().is_empty());
	}

	#[tokio::test]
	async fn cancel_is_the_user_cancel_fault() {
		let route = AskRoute::new();
		let questions = [question("only")];
		let waiting = {
			let route = route.clone();
			let questions = questions.clone();
			tokio::spawn(async move { route.present(&questions, Some("call-2")).await })
		};
		while route.pending().is_empty() {
			tokio::task::yield_now().await;
		}
		assert!(route.answer("call-2", AskReply::Cancelled));
		let fault = waiting.await.expect("task").expect_err("cancelled");
		assert_eq!(fault, Fault::cancelled());
	}

	#[tokio::test]
	async fn a_call_without_identity_cannot_be_answered() {
		let route = AskRoute::new();
		let fault = route
			.present(&[question("only")], None)
			.await
			.expect_err("no identity");
		assert!(matches!(fault, Fault::Presenter { .. }));
	}
}
