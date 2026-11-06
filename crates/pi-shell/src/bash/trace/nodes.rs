//! Node ancestry for aggregating real command state, independent of
//! presentation.

use crate::bash::{event::NodeKind, ir::NodeInfo};

/// The nearest preceding node whose source span contains each node.
pub(super) fn parents(nodes: &[NodeInfo]) -> Vec<Option<u32>> {
	let mut parents = Vec::with_capacity(nodes.len());
	let mut stack: Vec<u32> = Vec::new();
	for (index, node) in nodes.iter().enumerate() {
		while let Some(&ancestor) = stack.last() {
			let parent = &nodes[ancestor as usize];
			if parent.lo <= node.lo && node.hi <= parent.hi {
				break;
			}
			stack.pop();
		}
		parents.push(stack.last().copied());
		stack.push(index as u32);
	}
	parents
}

/// Direct executable children, excluding words and assignments.
pub(super) fn statement_children(nodes: &[NodeInfo], parents: &[Option<u32>]) -> Vec<Vec<u32>> {
	let mut children = vec![Vec::new(); nodes.len()];
	for (index, parent) in parents.iter().enumerate() {
		if let Some(parent) = *parent
			&& !matches!(nodes[index].kind, NodeKind::Word | NodeKind::Assign)
		{
			children[parent as usize].push(index as u32);
		}
	}
	children
}
