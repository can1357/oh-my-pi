//! Branch selection through journal `prior` links.

use omp_core::FastHashMap;

use crate::{Entry, EntryId};

/// Iterates the tail-selected live chain from oldest to newest.
///
/// An absent `prior` selects the preceding entry in file order. An explicit
/// `prior` walks to that identity. A missing target or cycle terminates the
/// walk rather than inventing ancestry.
pub fn live_chain(entries: &[Entry]) -> impl Iterator<Item = &Entry> {
	let indices = chain_indices(entries);
	indices.into_iter().map(|index| &entries[index])
}

/// Iterates entries not reachable from the file tail.
pub fn abandoned(entries: &[Entry]) -> impl Iterator<Item = &Entry> {
	let mut selected = vec![false; entries.len()];
	for index in chain_indices(entries) {
		selected[index] = true;
	}
	entries
		.iter()
		.enumerate()
		.filter_map(move |(index, entry)| (!selected[index]).then_some(entry))
}

fn chain_indices(entries: &[Entry]) -> Vec<usize> {
	let by_id: FastHashMap<EntryId, usize> = entries
		.iter()
		.enumerate()
		.map(|(index, entry)| (entry.id, index))
		.collect();
	let mut visited = vec![false; entries.len()];
	let mut reversed = Vec::new();
	let mut current = entries.len().checked_sub(1);
	while let Some(index) = current {
		if visited[index] {
			break;
		}
		visited[index] = true;
		reversed.push(index);
		current = match entries[index].prior {
			Some(prior) => by_id.get(&prior).copied(),
			None => index.checked_sub(1),
		};
	}
	reversed.reverse();
	reversed
}
