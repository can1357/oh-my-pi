//! The min-cost tiling, with the marked-stream vocabulary as an Aho-Corasick
//! automaton over UTF-8 bytes.
//!
//! Port of ctok's `engine.py`, count-only: marker atoms are in the vocabulary
//! as cost-1 tokens, so a marker no piece absorbs tiles as itself; the count
//! is the number of tiles. Token materialization (`tokenize()`) is not ported
//! — every consumer here needs the count alone.
//!
//! The vocabulary is matched with one Aho-Corasick transition per stream byte:
//! the state a byte lands in names, through its dictionary-link chain, every
//! piece ending at that byte, so the DP scores exactly the candidate tiles that
//! exist. A trie of reversed pieces answers the same question with a fresh
//! backwards descent per position, re-walking the vocabulary for every byte.
//!
//! Only pieces that end where a tile ends are candidates, and all of them are
//! scored: `best` is *not* monotone, because a long piece can cover a prefix
//! that is expensive to tile, so the longest match is not always the cheapest.
//!
//! Stream and vocabulary are both UTF-8 byte strings, never decoded character
//! sequences: a tile boundary is a byte offset, a transition is one byte, and a
//! character is decoded only where no piece covers it. Byte matching is exact
//! because a substring of valid UTF-8 that is itself valid UTF-8 must start on
//! a character boundary — a continuation byte cannot open a sequence — so no
//! piece can match across a character seam, and no match can be shorter than
//! its final character.

use std::collections::{HashSet, VecDeque};

use super::{constants::is_marker_byte, normalize::FrameParams};

/// Whether `b` continues a multi-byte UTF-8 sequence, so it is not the start of
/// a character and no tile may begin or end there.
#[inline]
const fn is_continuation(b: u8) -> bool {
	b & 0xc0 == 0x80
}

/// The vocabulary as an Aho-Corasick automaton: [`PieceMatcher::advance`] walks
/// the stream one byte at a time and the dictionary-link chain from the state
/// it lands in enumerates every piece ending at that byte, longest first.
pub struct PieceMatcher {
	states:       Vec<State>,
	edge_bytes:   Vec<u8>,
	edge_targets: Vec<u32>,
	/// Dense transitions out of the root, which is the hottest state by far.
	/// Zero (the root itself) where no piece starts with that byte.
	root_goto:    [u32; 256],
}

/// One automaton state: goto edges, the fail link, and the piece chain the DP
/// reads. Sixteen bytes, so a transition and the match it reports share a cache
/// line.
struct State {
	edge_start: u32,
	/// Longest proper suffix of this state's path that is also a state.
	fail:       u32,
	/// Next state along the fail chain at which a piece ends, 0 for none — the
	/// root can serve as that sentinel because no piece is empty.
	dict:       u32,
	edge_count: u16,
	/// Byte length of the piece ending in this state, 0 if none ends here.
	out_len:    u16,
}

/// Construction form: the vocabulary arrives sorted by bytes (the blob is
/// front-coded), so the trie grows along one path stack without any hashing,
/// and each parent's edges are created in increasing byte order.
struct Builder {
	terminal: Vec<bool>,
	depth:    Vec<u32>,
	edges:    Vec<(u32, u8, u32)>,
	/// States along the piece last inserted, indexed by prefix length.
	path:     Vec<u32>,
}

impl Builder {
	fn new(piece_count: usize) -> Self {
		Self {
			terminal: vec![false],
			depth:    vec![0],
			edges:    Vec::with_capacity(piece_count * 2),
			path:     vec![0],
		}
	}

	/// Insert the next piece of the sorted list: `shared` leading bytes the
	/// previous piece already walked, then `suffix`.
	fn push_piece(&mut self, shared: usize, suffix: &[u8]) {
		self.path.truncate(shared + 1);
		let mut at = *self.path.last().expect("root state");
		for &b in suffix {
			let child = self.terminal.len() as u32;
			self.terminal.push(false);
			self.depth.push(self.depth[at as usize] + 1);
			self.edges.push((at, b, child));
			self.path.push(child);
			at = child;
		}
		self.terminal[at as usize] = true;
	}

	/// Group the edges by parent and link the automaton.
	fn freeze(self) -> PieceMatcher {
		let count = self.terminal.len();
		// Counting sort by parent; within a parent the creation order is
		// already byte-sorted, so the groups come out sorted.
		let mut offsets = vec![0u32; count + 1];
		for &(parent, ..) in &self.edges {
			offsets[parent as usize + 1] += 1;
		}
		for i in 0..count {
			offsets[i + 1] += offsets[i];
		}
		let mut edge_bytes = vec![0u8; self.edges.len()];
		let mut edge_targets = vec![0u32; self.edges.len()];
		let mut cursor = offsets.clone();
		for &(parent, b, child) in &self.edges {
			let at = cursor[parent as usize] as usize;
			cursor[parent as usize] += 1;
			edge_bytes[at] = b;
			edge_targets[at] = child;
		}

		let states = (0..count)
			.map(|i| State {
				edge_start: offsets[i],
				edge_count: u16::try_from(offsets[i + 1] - offsets[i]).expect("byte fanout"),
				out_len:    0,
				fail:       0,
				dict:       0,
			})
			.collect();
		let mut matcher = PieceMatcher { states, edge_bytes, edge_targets, root_goto: [0; 256] };
		matcher.link(&self.terminal, &self.depth);
		matcher
	}
}

impl PieceMatcher {
	/// Fill the fail links, piece lengths and dictionary links breadth-first: a
	/// state's fail link points at a strictly shallower state, so every lookup
	/// below reads a state this loop has already linked.
	fn link(&mut self, terminal: &[bool], depth: &[u32]) {
		let mut queue: VecDeque<u32> = VecDeque::new();
		let root = &self.states[0];
		let (start, count) = (root.edge_start as usize, usize::from(root.edge_count));
		for i in start..start + count {
			let child = self.edge_targets[i];
			self.root_goto[usize::from(self.edge_bytes[i])] = child;
			queue.push_back(child);
		}
		while let Some(u) = queue.pop_front() {
			let fail = self.states[u as usize].fail;
			self.states[u as usize].out_len = if terminal[u as usize] {
				u16::try_from(depth[u as usize]).expect("piece length fits u16")
			} else {
				0
			};
			// Shortcut straight to the next shorter piece, so the DP walks
			// matches only, never the whole fail chain.
			self.states[u as usize].dict = if self.states[fail as usize].out_len > 0 {
				fail
			} else {
				self.states[fail as usize].dict
			};
			let st = &self.states[u as usize];
			let (start, count) = (st.edge_start as usize, usize::from(st.edge_count));
			for i in start..start + count {
				let child = self.edge_targets[i];
				// `fail` is shallower than `u`, so this transition only reads
				// linked states and can never land on `child` itself.
				self.states[child as usize].fail = self.advance(fail, self.edge_bytes[i]);
				queue.push_back(child);
			}
		}
	}

	/// Follow one goto edge, or `None` when this state has no piece continuing
	/// with `b`.
	#[inline]
	fn goto(&self, state: u32, b: u8) -> Option<u32> {
		let st = &self.states[state as usize];
		let start = st.edge_start as usize;
		let bytes = &self.edge_bytes[start..start + usize::from(st.edge_count)];
		// Fanout is one or two bytes for most states, where scanning the sorted
		// run beats a binary search's branch chain; the wide states sit near
		// the root, and the root itself never gets here.
		let hit = if bytes.len() <= 8 {
			bytes
				.iter()
				.position(|&e| e >= b)
				.filter(|&i| bytes[i] == b)
		} else {
			bytes.binary_search(&b).ok()
		}?;
		Some(self.edge_targets[start + hit])
	}

	/// Consume one stream byte. Each fail step drops at least one level and a
	/// transition adds at most one, so the whole scan is linear in the stream.
	#[inline]
	fn advance(&self, state: u32, b: u8) -> u32 {
		let mut at = state;
		loop {
			if at == 0 {
				return self.root_goto[usize::from(b)];
			}
			if let Some(next) = self.goto(at, b) {
				return next;
			}
			at = self.states[at as usize].fail;
		}
	}

	/// The pieces ending at the byte this state consumed, longest first: the
	/// state itself when one ends here, then its dictionary chain.
	#[inline]
	const fn matches(&self, state: u32) -> Matches<'_> {
		Matches { vocab: self, at: state }
	}
}

/// Iterator over the byte lengths of the pieces ending at one stream position,
/// longest first.
struct Matches<'a> {
	vocab: &'a PieceMatcher,
	at:    u32,
}

impl Iterator for Matches<'_> {
	type Item = usize;

	#[inline]
	fn next(&mut self) -> Option<usize> {
		loop {
			let st = &self.vocab.states[self.at as usize];
			let len = st.out_len;
			self.at = st.dict;
			if len > 0 {
				return Some(usize::from(len));
			}
			// Only the entry state can lack a piece; the chain holds nothing
			// but pieces after that.
			if self.at == 0 {
				return None;
			}
		}
	}
}

/// Min-cost tiling over the cost-1 vocabulary plus a guaranteed one-character
/// floor. `unit_cost(start, end)` prices the character in `s[start..end]` where
/// no piece covers it (may be > 1: a 4-byte letter with no piece costs its byte
/// tiling).
///
/// Long pieces make `best` non-monotone — covering a longer prefix can cost
/// fewer tokens than covering a shorter one — so every piece ending at a
/// position is scored, not just the longest. The one-character floor is needed
/// only when no piece spells that character alone: any piece ending here covers
/// at least the final character (a piece cannot start mid-character), and the
/// character's own piece costs 1, never more than its floor.
pub fn min_vocab_tile(
	s: &[u8],
	vocab: &PieceMatcher,
	mut unit_cost: impl FnMut(usize, usize) -> u32,
) -> u32 {
	let n = s.len();
	if n == 0 {
		return 0;
	}
	let mut best = vec![0u32; n + 1];
	let mut state = 0u32;
	for end in 1..=n {
		state = vocab.advance(state, s[end - 1]);
		// Tiles start and end on character boundaries only; interior byte
		// positions of a character are never a DP state.
		if end != n && is_continuation(s[end]) {
			continue;
		}
		let mut start = end - 1;
		while is_continuation(s[start]) {
			start -= 1;
		}
		let single = end - start;
		let mut cost = u32::MAX;
		let mut spelled = false;
		for len in vocab.matches(state) {
			cost = cost.min(best[end - len] + 1);
			spelled |= len == single;
		}
		if !spelled {
			cost = cost.min(best[start] + unit_cost(start, end));
		}
		best[end] = cost;
	}
	best[n]
}

/// What a codepoint costs when no piece covers it: a min-cost tiling of its
/// UTF-8 bytes over the partial byte-prefix tokens, every single byte
/// costing 1.
struct ByteFloor {
	/// Sorted sentinel-packed byte strings (≤ 4 bytes): membership is all that
	/// is needed, since every token costs 1.
	tokens:  Vec<u64>,
	max_len: usize,
}

#[inline]
fn pack_bytes(bs: &[u8]) -> u64 {
	bs.iter().fold(1u64, |acc, &b| (acc << 8) | u64::from(b))
}

impl ByteFloor {
	fn cost_bytes(&self, bs: &[u8]) -> u32 {
		let n = bs.len();
		let mut best = [u32::MAX; 5];
		best[0] = 0;
		for i in 1..=n {
			for j in i.saturating_sub(self.max_len)..i {
				if best[j] != u32::MAX
					&& (i - j == 1 || self.tokens.binary_search(&pack_bytes(&bs[j..i])).is_ok())
					&& best[j] + 1 < best[i]
				{
					best[i] = best[j] + 1;
				}
			}
		}
		best[n]
	}

	fn cost_char(&self, c: char) -> u32 {
		let mut buf = [0u8; 4];
		self.cost_bytes(c.encode_utf8(&mut buf).as_bytes())
	}
}

/// The first character of `bytes`, whose length the lead byte gives — valid
/// UTF-8 is guaranteed by both callers (vocabulary pieces and the encoder's own
/// output).
#[inline]
fn decode_char(bytes: &[u8]) -> char {
	#[inline]
	const fn cont(b: u8) -> u32 {
		(b & 0x3f) as u32
	}
	let lead = u32::from(bytes[0]);
	let cp = if lead < 0x80 {
		lead
	} else if lead < 0xe0 {
		(lead & 0x1f) << 6 | cont(bytes[1])
	} else if lead < 0xf0 {
		(lead & 0x0f) << 12 | cont(bytes[1]) << 6 | cont(bytes[2])
	} else {
		(lead & 0x07) << 18 | cont(bytes[1]) << 12 | cont(bytes[2]) << 6 | cont(bytes[3])
	};
	char::from_u32(cp).expect("valid UTF-8")
}

/// Byte cursor over the embedded vocabulary blob. The data is generated and
/// committed alongside the code, so malformed input is a build defect:
/// readers panic with context rather than propagating errors.
struct Cursor<'a> {
	data: &'a [u8],
	pos:  usize,
}

impl<'a> Cursor<'a> {
	fn take(&mut self, n: usize) -> &'a [u8] {
		let slice = &self.data[self.pos..self.pos + n];
		self.pos += n;
		slice
	}

	fn u8(&mut self) -> u8 {
		self.take(1)[0]
	}

	fn u16(&mut self) -> u16 {
		u16::from_le_bytes(self.take(2).try_into().expect("two bytes"))
	}

	fn u32(&mut self) -> u32 {
		u32::from_le_bytes(self.take(4).try_into().expect("four bytes"))
	}

	fn varint(&mut self) -> usize {
		let mut value = 0usize;
		let mut shift = 0u32;
		loop {
			let byte = self.u8();
			value |= usize::from(byte & 0x7f) << shift;
			if byte & 0x80 == 0 {
				return value;
			}
			shift += 7;
			assert!(shift < 32, "ctok varint overflow");
		}
	}
}

/// The loaded vocabulary plus the scalars the encoder and tiler read from it.
/// One core serves every family that borrows its vocabulary file (v5 reuses
/// v4.7's with different frame scalars).
pub struct VocabCore {
	/// Measured metadata of the vocabulary file (v5 overrides parts of it).
	pub message_overhead: u32,
	/// See [`FrameParams::fold_quotes`].
	pub fold_quotes:      bool,
	/// See [`FrameParams::allcaps_min`].
	pub allcaps_min:      Option<usize>,
	vocab:                PieceMatcher,
	/// Sorted codepoints of the cost-1 whole-character pieces.
	unit_pieces:          Vec<u32>,
	/// Sorted lengths of the pure-newline pieces; coins for the
	/// trailing-newline ladder, where nothing else can match.
	newline_ladder:       Vec<u32>,
	floor:                ByteFloor,
}

impl VocabCore {
	/// Parse one front-coded binary vocabulary blob produced by
	/// `crates/pi-natives/tools/gen-ctok-vocab.ts` (format documented there;
	/// pieces arrive in the compact marker alphabet, sorted by those bytes).
	/// Pieces stream straight into the automaton builder; nothing is buffered
	/// beyond the front-coding scratch.
	pub fn parse(blob: &[u8]) -> Self {
		let mut cur = Cursor { data: blob, pos: 0 };
		assert_eq!(cur.take(4), b"CTOK", "bad ctok vocabulary magic");
		assert_eq!(cur.u8(), 2, "unsupported ctok vocabulary version");
		let fold_quotes = cur.u8() & 1 != 0;
		let message_overhead = u32::from(cur.u8());
		let allcaps_min = match cur.u8() {
			0 => None,
			n => Some(usize::from(n)),
		};
		let byte_token_count = usize::from(cur.u16());
		let piece_count = cur.u32();

		let mut tokens = HashSet::with_capacity(byte_token_count + 512);
		let mut max_len = 1usize;
		for _ in 0..byte_token_count {
			let len = usize::from(cur.u8());
			assert!((1..=4).contains(&len), "byte token out of range: {len}");
			max_len = max_len.max(len);
			tokens.insert(pack_bytes(cur.take(len)));
		}

		let mut builder = Builder::new(piece_count as usize);
		let mut unit_pieces = Vec::new();
		let mut newline_ladder = Vec::new();
		let mut scratch: Vec<u8> = Vec::with_capacity(64);
		for _ in 0..piece_count {
			let shared = cur.varint();
			let suffix_len = cur.varint();
			assert!(shared <= scratch.len(), "ctok pieces should be front-coded in order");
			scratch.truncate(shared);
			let suffix = cur.take(suffix_len);
			scratch.extend_from_slice(suffix);
			builder.push_piece(shared, suffix);
			assert!(std::str::from_utf8(&scratch).is_ok(), "ctok piece should be UTF-8");
			if scratch.iter().all(|&b| b == b'\n') {
				newline_ladder.push(scratch.len() as u32);
			}
			// Cost-1 whole-character pieces fold into the byte floor's
			// membership set, so an uncovered character still prices at 1.
			// Marker atoms are pieces too, but they spell no character.
			if scratch.len() == 1 && is_marker_byte(scratch[0]) {
				continue;
			}
			let c = decode_char(&scratch);
			if scratch.len() == c.len_utf8() {
				unit_pieces.push(c as u32);
				max_len = max_len.max(scratch.len());
				tokens.insert(pack_bytes(&scratch));
			}
		}
		assert_eq!(cur.pos, blob.len(), "trailing ctok vocabulary bytes");
		newline_ladder.sort_unstable();
		unit_pieces.sort_unstable();
		let mut tokens: Vec<u64> = tokens.into_iter().collect();
		tokens.sort_unstable();

		Self {
			message_overhead,
			fold_quotes,
			allcaps_min,
			vocab: builder.freeze(),
			unit_pieces,
			newline_ladder,
			floor: ByteFloor { tokens, max_len },
		}
	}

	/// One character standing where the vocabulary covers nothing: markers and
	/// whole-character pieces cost one token, everything else falls to the byte
	/// floor.
	fn uncovered_cost(&self, bytes: &[u8]) -> u32 {
		if bytes.len() == 1 && is_marker_byte(bytes[0]) {
			return 1; // a marker no piece absorbs tiles as itself
		}
		let c = decode_char(bytes);
		if self.unit_pieces.binary_search(&(c as u32)).is_ok() {
			1
		} else {
			self.floor.cost_char(c)
		}
	}

	/// Tile the marked stream: minimum token count over the vocabulary, with
	/// markers costing one and uncovered characters falling to the byte floor.
	pub fn tile_cost(&self, stream: &[u8]) -> u32 {
		min_vocab_tile(stream, &self.vocab, |start, end| self.uncovered_cost(&stream[start..end]))
	}

	/// What a content-final run of `n_tail` frame-absorbed newlines costs
	/// beyond the frame's own trailing token (ladder families only). The
	/// v3/v4.7 frames append ⏎⏎ after the content and one token can span
	/// into them, so the run the tokenizer sees is `n_tail + 2`; the
	/// sonnet/fable-5 frame appends nothing (`appended = 0`). In both cases
	/// the frame already pays for one token of the run.
	pub fn ladder_tail_cost(&self, n_tail: usize, appended: usize) -> u32 {
		if n_tail == 0 {
			return 0;
		}
		let m = n_tail + appended;
		// Min-token cover of a homogeneous run: only the pure-newline
		// pieces can match (each costing one), and a newline left over
		// costs one. The lengths are not contiguous (v4.7 jumps 16 → 24),
		// so this is a coin DP, not a division by the longest piece.
		let mut best = vec![0u32; m + 1];
		for end in 1..=m {
			let mut cost = best[end - 1] + 1;
			for &len in &self.newline_ladder {
				let len = len as usize;
				if len > end {
					break;
				}
				cost = cost.min(best[end - len] + 1);
			}
			best[end] = cost;
		}
		best[m] - 1
	}

	/// The frame scalars this vocabulary file measures (v3/v4.7 defaults:
	/// the frame ends in ⟨bow⟩ and pays the trailing-newline ladder).
	pub const fn frame_params(&self) -> FrameParams {
		FrameParams {
			message_overhead: self.message_overhead,
			fold_quotes:      self.fold_quotes,
			allcaps_min:      self.allcaps_min,
			frame_bow:        true,
			ladder:           true,
		}
	}
}
