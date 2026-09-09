use omp_dom::Dom;
use omp_journal::{Entry, Kind};

use crate::{Component, Draft};

/// Declares the `<meta><directors>` component boundary.
///
/// Director engagements are already expressed as ordinary `patch@1`
/// insertions and removals, so this reducer intentionally adds no second
/// interpretation. Phase 3 drives the subtree exclusively through patches.
pub struct DirectorsComponent;

impl Component for DirectorsComponent {
	fn interested(&self, _kind: &Kind) -> bool {
		false
	}

	fn apply(&mut self, _entry: &Entry, _dom: &Dom, _draft: &mut Draft) {}
}
