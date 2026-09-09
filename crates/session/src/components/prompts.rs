//! Journal-backed deferred-prompt subtree boundary.

use omp_dom::{Dom, Handle, KnownTag, Tag};
use omp_journal::{Entry, Kind};

use crate::{Component, Draft};

/// Declares the `<queues><prompts>` component boundary.
///
/// Prompt state is expressed entirely as ordinary `patch@1` insertions and
/// property updates. This component deliberately retains no private state.
pub struct PromptsComponent;

impl Component for PromptsComponent {
	fn interested(&self, _kind: &Kind) -> bool {
		false
	}

	fn apply(&mut self, _entry: &Entry, _dom: &Dom, _draft: &mut Draft) {}
}

/// Returns the canonical `<queues><prompts>` handle.
#[must_use]
pub fn prompts_handle(dom: &Dom) -> Option<Handle> {
	dom.children(dom.queues()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Prompts))
	})
}
