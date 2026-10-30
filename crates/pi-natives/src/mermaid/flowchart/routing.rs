use std::collections::HashSet;

use super::{
	AsciiGraph, Dir, EdgeId, GridCoord, LayoutDirection,
	grid::get_node_subgraph,
	pathfinder::{get_path, get_path_avoiding, merge_path},
};
use crate::mermaid::text::display_width;

/// Grid distance between adjacent ranks (a 3-cell node block plus one gap).
const RANK_PITCH: i32 = 4;

/// Determine the cardinal or diagonal direction from one coordinate to another.
pub const fn determine_direction(from: GridCoord, to: GridCoord) -> Dir {
	if from.x == to.x {
		if from.y < to.y { Dir::Down } else { Dir::Up }
	} else if from.y == to.y {
		if from.x < to.x { Dir::Right } else { Dir::Left }
	} else if from.x < to.x {
		if from.y < to.y {
			Dir::LowerRight
		} else {
			Dir::UpperRight
		}
	} else if from.y < to.y {
		Dir::LowerLeft
	} else {
		Dir::UpperLeft
	}
}

fn self_reference_direction(graph_direction: LayoutDirection) -> (Dir, Dir, Dir, Dir) {
	if graph_direction == LayoutDirection::LR {
		(Dir::Right, Dir::Down, Dir::Down, Dir::Right)
	} else {
		(Dir::Down, Dir::Right, Dir::Right, Dir::Down)
	}
}

/// Return `(preferred start, preferred end, alternative start, alternative
/// end)` directions.
pub fn determine_start_and_end_dir(
	graph: &AsciiGraph,
	edge: EdgeId,
	graph_direction: LayoutDirection,
) -> (Dir, Dir, Dir, Dir) {
	let Some(edge) = graph.edges.get(edge) else {
		return (Dir::default(), Dir::default(), Dir::default(), Dir::default());
	};
	if edge.from == edge.to {
		return self_reference_direction(graph_direction);
	}
	let (Some(from), Some(to)) = (
		graph.nodes.get(edge.from).and_then(|node| node.grid_coord),
		graph.nodes.get(edge.to).and_then(|node| node.grid_coord),
	) else {
		return (Dir::default(), Dir::default(), Dir::default(), Dir::default());
	};
	let direction = determine_direction(from, to);
	let is_backwards = match graph_direction {
		LayoutDirection::LR => matches!(direction, Dir::Left | Dir::UpperLeft | Dir::LowerLeft),
		LayoutDirection::TD => matches!(direction, Dir::Up | Dir::UpperLeft | Dir::UpperRight),
	};
	// A straight edge that skips over intermediate ranks would otherwise
	// share the in-between nodes' connecting cells; leave and enter on the
	// perpendicular side so it runs beside the chain with its own arrowhead.
	let skips_ranks = match graph_direction {
		LayoutDirection::LR => direction == Dir::Right && to.x - from.x > RANK_PITCH,
		LayoutDirection::TD => direction == Dir::Down && to.y - from.y > RANK_PITCH,
	};
	if skips_ranks {
		return match graph_direction {
			LayoutDirection::LR => (Dir::Down, Dir::Down, Dir::Right, Dir::Left),
			LayoutDirection::TD => (Dir::Right, Dir::Right, Dir::Down, Dir::Up),
		};
	}

	match (direction, graph_direction) {
		(Dir::LowerRight, LayoutDirection::LR) => (Dir::Down, Dir::Left, Dir::Right, Dir::Up),
		(Dir::LowerRight, LayoutDirection::TD) => (Dir::Right, Dir::Up, Dir::Down, Dir::Left),
		(Dir::UpperRight, LayoutDirection::LR) => (Dir::Up, Dir::Left, Dir::Right, Dir::Down),
		(Dir::UpperRight, LayoutDirection::TD) => (Dir::Right, Dir::Down, Dir::Up, Dir::Left),
		(Dir::LowerLeft, LayoutDirection::LR) => (Dir::Down, Dir::Down, Dir::Left, Dir::Up),
		(Dir::LowerLeft, LayoutDirection::TD) => (Dir::Left, Dir::Up, Dir::Down, Dir::Right),
		(Dir::UpperLeft, LayoutDirection::LR) => (Dir::Down, Dir::Down, Dir::Left, Dir::Down),
		(Dir::UpperLeft, LayoutDirection::TD) => (Dir::Right, Dir::Right, Dir::Up, Dir::Right),
		(Dir::Left, LayoutDirection::LR) if is_backwards => {
			(Dir::Down, Dir::Down, Dir::Left, Dir::Right)
		},
		(Dir::Up, LayoutDirection::TD) if is_backwards => {
			(Dir::Right, Dir::Right, Dir::Up, Dir::Down)
		},
		_ => (direction, direction.opposite(), direction, direction.opposite()),
	}
}

/// Route an edge using the shorter of its preferred and alternative A* paths.
pub fn determine_path(graph: &mut AsciiGraph, edge: EdgeId) {
	let Some(edge_data) = graph.edges.get(edge) else {
		return;
	};
	let (from_id, to_id) = (edge_data.from, edge_data.to);
	let source_subgraph = get_node_subgraph(graph, from_id);
	let target_subgraph = get_node_subgraph(graph, to_id);
	let effective_direction = if source_subgraph.is_some() && source_subgraph == target_subgraph {
		source_subgraph
			.and_then(|subgraph| graph.subgraphs.get(subgraph))
			.and_then(|subgraph| subgraph.direction)
			.unwrap_or(graph.config.direction)
	} else {
		graph.config.direction
	};
	let (preferred, preferred_end, alternative, alternative_end) =
		determine_start_and_end_dir(graph, edge, effective_direction);
	let (Some(from), Some(to)) = (
		graph.nodes.get(from_id).and_then(|node| node.grid_coord),
		graph.nodes.get(to_id).and_then(|node| node.grid_coord),
	) else {
		return;
	};

	let preferred_from = from.offset(preferred);
	let preferred_to = to.offset(preferred_end);
	let alternative_from = from.offset(alternative);
	let alternative_to = to.offset(alternative_end);
	let preferred_path = get_path(&graph.grid, preferred_from, preferred_to).map(merge_path);
	let alternative_path = get_path(&graph.grid, alternative_from, alternative_to).map(merge_path);

	let (mut start_dir, mut end_dir, mut path) = match (preferred_path, alternative_path) {
		(Some(preferred_path), Some(alternative_path)) => {
			if preferred_path.len() <= alternative_path.len() {
				(preferred, preferred_end, preferred_path)
			} else {
				(alternative, alternative_end, alternative_path)
			}
		},
		(Some(path), None) => (preferred, preferred_end, path),
		(None, Some(path)) => (alternative, alternative_end, path),
		(None, None) => (preferred, preferred_end, vec![preferred_from, preferred_to]),
	};

	// Another edge joining the same two nodes may already run along this
	// route; drawing both on the same cells would merge their lines and
	// stack their labels. Re-route around every routed edge (repeats are
	// routed last, see `grid::create_mapping`), also trying to leave and
	// enter on the sides across the flow, as backward edges do.
	let parallel_taken = parallel_route_cells(graph, edge);
	if !parallel_taken.is_empty() && route_rank(&path, &parallel_taken).1 > 0 {
		let other_taken = other_route_cells(graph, edge);
		let all_taken = all_route_cells(graph, edge);
		let (side_a, side_b) = match effective_direction {
			LayoutDirection::LR => (Dir::Down, Dir::Up),
			LayoutDirection::TD => (Dir::Right, Dir::Left),
		};
		let rerouted = [
			(preferred, preferred_end),
			(preferred, alternative_end),
			(alternative, preferred_end),
			(alternative, alternative_end),
			(side_a, side_a),
			(side_b, side_b),
			(side_a, side_b),
			(side_b, side_a),
		]
		.into_iter()
		.filter_map(|(start, end)| {
			let candidate =
				get_path_avoiding(&graph.grid, from.offset(start), to.offset(end), &all_taken)
					.map(merge_path)?;
			let shares_end_port = graph.edges.iter().enumerate().any(|(id, other)| {
				id != edge
					&& !other.path.is_empty()
					&& ((other.to == to_id && other.end_dir == end)
						|| (other.from == to_id && other.start_dir == end))
			});
			let shares_parallel_end = graph.edges.iter().enumerate().any(|(id, other)| {
				id != edge
					&& !other.path.is_empty()
					&& other.from == from_id
					&& other.to == to_id
					&& other.end_dir == end
			});
			// `draw::edge_drawing_path` moves a last segment that enters a port
			// another edge leaves from beside that edge's stem, so sharing those
			// cells draws no collision.
			let leaves_end_port = graph.edges.iter().enumerate().any(|(id, other)| {
				id != edge && !other.path.is_empty() && other.from == to_id && other.start_dir == end
			});
			let separated_end: HashSet<GridCoord> = if leaves_end_port && candidate.len() >= 3 {
				path_cells(&candidate[candidate.len() - 2..]).collect()
			} else {
				HashSet::new()
			};
			let other_shared = path_cells(&candidate)
				.filter(|cell| other_taken.contains(cell) && !separated_end.contains(cell))
				.count();
			let parallel_rank = route_rank(&candidate, &parallel_taken);
			Some((
				(
					parallel_rank.0,
					shares_parallel_end,
					other_shared,
					parallel_rank.2,
					shares_end_port,
					parallel_rank.1,
				),
				start,
				end,
				candidate,
			))
		})
		.min_by_key(|(rank, ..)| *rank);
		if let Some((_, start, end, candidate)) = rerouted {
			(start_dir, end_dir, path) = (start, end, candidate);
		}
	}

	if let Some(edge) = graph.edges.get_mut(edge) {
		edge.start_dir = start_dir;
		edge.end_dir = end_dir;
		edge.path = path;
	}
}

/// Every grid cell crossed by the routed edges other than `edge`.
fn all_route_cells(graph: &AsciiGraph, edge: EdgeId) -> HashSet<GridCoord> {
	let mut cells = HashSet::new();
	for (id, other) in graph.edges.iter().enumerate() {
		if id != edge && !other.path.is_empty() {
			cells.extend(path_cells(&other.path));
		}
	}
	cells
}

/// Every grid cell crossed by the routed edges that do not join the same two
/// nodes as `edge`.
fn other_route_cells(graph: &AsciiGraph, edge: EdgeId) -> HashSet<GridCoord> {
	let mut cells = HashSet::new();
	let Some(this) = graph.edges.get(edge) else {
		return cells;
	};
	for (id, other) in graph.edges.iter().enumerate() {
		if id != edge && !this.joins_same_pair(other) && !other.path.is_empty() {
			cells.extend(path_cells(&other.path));
		}
	}
	cells
}

/// Every grid cell crossed by the already-routed edges that join the same two
/// nodes as `edge` (in either direction).
fn parallel_route_cells(graph: &AsciiGraph, edge: EdgeId) -> HashSet<GridCoord> {
	let mut cells = HashSet::new();
	let Some(this) = graph.edges.get(edge) else {
		return cells;
	};
	if this.from == this.to {
		return cells;
	}
	for (id, other) in graph.edges.iter().enumerate() {
		if id != edge && this.joins_same_pair(other) {
			cells.extend(path_cells(&other.path));
		}
	}
	cells
}

/// Sort key for a merged `path` against cells other routes already use:
/// `(entirely hidden under them, shared cell count, point count)`. A hidden
/// route draws nothing of its own, so any partly visible one beats it.
fn route_rank(path: &[GridCoord], cells: &HashSet<GridCoord>) -> (bool, usize, usize) {
	let (mut total, mut shared) = (0, 0);
	for cell in path_cells(path) {
		total += 1;
		shared += usize::from(cells.contains(&cell));
	}
	(shared == total, shared, path.len())
}

/// Expand a merged path back into the cells its segments cross. Diagonal jumps
/// (unroutable fallbacks) walk both axes until each reaches its end.
fn path_cells(path: &[GridCoord]) -> impl Iterator<Item = GridCoord> + '_ {
	path
		.first()
		.copied()
		.into_iter()
		.chain(path.array_windows().flat_map(|&[from, to]| {
			let (span_x, span_y) = ((to.x - from.x).abs(), (to.y - from.y).abs());
			let (dx, dy) = ((to.x - from.x).signum(), (to.y - from.y).signum());
			(1..=span_x.max(span_y)).map(move |step| {
				GridCoord::new(from.x + dx * step.min(span_x), from.y + dy * step.min(span_y))
			})
		}))
}

fn calculate_line_width(graph: &AsciiGraph, line: [GridCoord; 2]) -> i32 {
	let start_x = line[0].x.min(line[1].x);
	let end_x = line[0].x.max(line[1].x);
	(start_x..=end_x)
		.map(|x| graph.column_width.get(&x).copied().unwrap_or(0))
		.sum()
}

/// Choose an edge segment for its label and widen the midpoint column to fit
/// it.
pub fn determine_label_line(graph: &mut AsciiGraph, edge: EdgeId) {
	let Some(edge_data) = graph.edges.get(edge) else {
		return;
	};
	if edge_data.text.is_empty() || edge_data.path.len() < 2 {
		return;
	}
	let label_width = i32::try_from(display_width(&edge_data.text)).unwrap_or(i32::MAX);
	let mut segments = Vec::with_capacity(edge_data.path.len() - 1);
	for index in 1..edge_data.path.len() {
		let line = [edge_data.path[index - 1], edge_data.path[index]];
		segments.push((line, calculate_line_width(graph, line), index));
	}
	// A parallel edge's label goes on a segment of its own: skip segments that
	// another route fully covers. `.all` rather than `.any`, so a segment that
	// only meets another route at a corner stays eligible. Edges without a
	// parallel twin keep their original segment choice.
	if !parallel_route_cells(graph, edge).is_empty() {
		let taken = all_route_cells(graph, edge);
		let shared = |line: &[GridCoord; 2]| path_cells(line).all(|cell| taken.contains(&cell));
		if segments.iter().any(|(line, ..)| !shared(line)) {
			segments.retain(|(line, ..)| !shared(line));
		}
	}

	let largest_line = segments
		.iter()
		.rev()
		.find(|(_, width, index)| *width >= label_width && *index > 1)
		.or_else(|| {
			segments
				.iter()
				.rev()
				.find(|(_, width, _)| *width >= label_width)
		})
		.or_else(|| {
			let mut widest = segments.first();
			for segment in segments.iter().skip(1) {
				if widest.is_none_or(|candidate| segment.1 > candidate.1) {
					widest = Some(segment);
				}
			}
			widest
		})
		.map(|(line, ..)| *line);
	let Some(largest_line) = largest_line else {
		return;
	};

	let min_x = largest_line[0].x.min(largest_line[1].x);
	let max_x = largest_line[0].x.max(largest_line[1].x);
	let column = label_column(graph, min_x, max_x);
	let required_width =
		required_column_width(graph, min_x, max_x, column, label_width.saturating_add(2));
	graph
		.column_width
		.entry(column)
		.and_modify(|width| *width = (*width).max(required_width))
		.or_insert(required_width);
	if let Some(edge) = graph.edges.get_mut(edge) {
		edge.label_line = largest_line.to_vec();
	}
}

/// When [`label_column`] shifts a label off a node border onto one of the
/// segment's endpoint columns (`min_x` or `max_x`), only half of that column
/// lies inside `[center(min_x), center(max_x)]`; size the endpoint column so
/// its interior half still covers `target_span`.
fn required_column_width(
	graph: &AsciiGraph,
	min_x: i32,
	max_x: i32,
	column: i32,
	target_span: i32,
) -> i32 {
	let middle = min_x + (max_x - min_x).div_euclid(2);
	if min_x < max_x && column != middle && (column == min_x || column == max_x) {
		let other_end = if column == min_x { max_x } else { min_x };
		let other_end_half = graph
			.column_width
			.get(&other_end)
			.copied()
			.unwrap_or(0)
			.div_euclid(2);
		let interior: i32 = ((min_x + 1)..max_x)
			.filter(|&x| x != column)
			.map(|x| graph.column_width.get(&x).copied().unwrap_or(0))
			.sum();
		let needed_half = (target_span - other_end_half - interior).max(0);
		needed_half.saturating_mul(2).max(target_span)
	} else {
		target_span
	}
}

/// Column in `min_x..=max_x` a label widens: the middle one, else the nearest
/// that is not a node border column (ties go to gap columns, which do not
/// resize any box). [`super::draw::draw_node`] sizes a box from its left and
/// center columns only, so a wider border column would push edges attached to
/// that border off the drawn box. Falls back to the middle column when every
/// candidate is a border.
fn label_column(graph: &AsciiGraph, min_x: i32, max_x: i32) -> i32 {
	let middle = min_x + (max_x - min_x).div_euclid(2);
	let lefts: Vec<i32> = graph
		.nodes
		.iter()
		.filter_map(|node| node.grid_coord)
		.map(|gc| gc.x)
		.collect();
	(min_x..=max_x)
		.filter(|&x| !lefts.iter().any(|&left| x == left || x == left + 2))
		.min_by_key(|&x| ((x - middle).abs(), lefts.iter().any(|&left| x == left + 1)))
		.unwrap_or(middle)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn determines_axis_and_diagonal_directions() {
		let origin = GridCoord::new(2, 2);
		assert_eq!(determine_direction(origin, GridCoord::new(2, 1)), Dir::Up);
		assert_eq!(determine_direction(origin, GridCoord::new(2, 3)), Dir::Down);
		assert_eq!(determine_direction(origin, GridCoord::new(1, 2)), Dir::Left);
		assert_eq!(determine_direction(origin, GridCoord::new(3, 2)), Dir::Right);
		assert_eq!(determine_direction(origin, GridCoord::new(3, 3)), Dir::LowerRight);
	}
}
