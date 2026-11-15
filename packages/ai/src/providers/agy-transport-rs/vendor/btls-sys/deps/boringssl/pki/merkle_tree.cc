// Copyright 2025 The BoringSSL Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "merkle_tree.h"

#include <algorithm>
#include <optional>

#include <openssl/mem.h>
#include <openssl/span.h>
#include "openssl/sha2.h"

BSSL_NAMESPACE_BEGIN

// Computes HASH(0x01 || left || right) and saves the result to |out|.
void HashNode(TreeHashConstSpan left, TreeHashConstSpan right,
              TreeHashSpan out) {
  static const uint8_t header = 0x01;
  SHA256_CTX ctx;
  SHA256_Init(&ctx);
  SHA256_Update(&ctx, &header, 1);
  SHA256_Update(&ctx, left.data(), left.size());
  SHA256_Update(&ctx, right.data(), right.size());
  SHA256_Final(out.data(), &ctx);
}

namespace {

std::optional<TreeHashConstSpan> NextProofHash(Span<const uint8_t> *proof) {
  if (proof->size() < SHA256_DIGEST_LENGTH) {
    return std::nullopt;
  }
  auto ret = proof->first<SHA256_DIGEST_LENGTH>();
  *proof = proof->subspan(SHA256_DIGEST_LENGTH);
  return ret;
}

}  // namespace

std::optional<TreeHash> EvaluateMerkleSubtreeConsistencyProof(
    uint64_t n, const Subtree &subtree, Span<const uint8_t> proof,
    TreeHashConstSpan node_hash) {
  // For more detail on how subtree consistency proofs work, see appendix B
  // of draft-davidben-tls-merkle-tree-certs-08.

  // Check that inputs are valid. (Step 1)
  if (!subtree.IsValid() || n < subtree.end) {
    return std::nullopt;
  }

  // Initialize fn (first number), sn (second number), and tn (third number).
  // Each number is the path from the root of the tree to 1) the leftmost child
  // of the subtree, 2) the rightmost child of the subtree, and 3) the rightmost
  // child of the full tree. (Step 2)
  uint64_t fn = subtree.start;
  uint64_t sn = subtree.end - 1;
  uint64_t tn = n - 1;

  // The bit patterns of these numbers indicates whether the path goes left or
  // right (or in some cases on the rightmost edge of a (sub)treee, that a level
  // of the tree is skipped).
  //
  // When consuming the proof, we work up the tree from the bottom level (level
  // 0) up to the root, and moving up one level in the tree corresponds to
  // consuming the least significant bit from each of fn, sn, and tn. The proof
  // can start at a higher level than level 0 if the node on the right edge of
  // the subtree at that level is also a node of the overall tree.
  //
  // Remove bits equally from the right of fn, sn, and tn to skip to the level
  // of the tree where the proof starts. (Steps 3 and 4)
  if (sn == tn) {
    // If sn == tn, then the rightmost child of the subtree and the rightmost
    // child of the full tree are the same node, meaning that the subtree is
    // directly contained in the full tree. The proof starts at the same level
    // as the top of the subtree. That level is identified by advancing
    // bit-by-bit through fn and sn until they are the same, meaning that we've
    // moved up the levels of the tree to where the left and right edge of the
    // subtree reach the same point (the root of the subtree).
    //
    // (Step 3: right shift until fn is sn)
    while (fn != sn) {
      fn >>= 1;
      sn >>= 1;
      tn >>= 1;
    }
  } else {
    // Find the largest full (rather than partial) subtree that the rightmost
    // edge of the input subtree is still the rightmost edge of, without going
    // beyond the bounds of the input subtree. Any such full subtree is directly
    // contained in the tree of hash operations for the full tree, meaning that
    // the proof can start at that level rather than level 0.
    //
    // As long as the path to the rightmost edge of the input subtree is
    // indicating it's on the right side of its parent node (its LSB is 1), it's
    // still on the rightmost edge of a full (rather than partial) subtree.
    // Iteration stops when it's no longer on the rightmost edge of a full
    // subtree (LSB(sn) is not set) or when we reach the top of the input
    // subtree (fn is sn).
    //
    // (Step 4: right-shift until fn is sn or LSB(sn) is not set)
    while (fn != sn && (sn & 1) == 1) {
      fn >>= 1;
      sn >>= 1;
      tn >>= 1;
    }
  }

  // The proof array starts with the highest node from the subtree's right edge
  // that is also in the overall tree, and subsequent values from the proof
  // array are hashed in to compute the values that should be node_hash and
  // root_hash if the proof is valid. As an optimization, if node_hash is the
  // hash of the highest node from the subtree's right edge (i.e. the whole
  // subtree is directly contained in the overall tree), that value is omitted
  // from the proof.
  //
  // In this code, computed_node_hash and computed_root_hash are the values fr
  // and sr from draft-davidben-tls-merkle-tree-certs-08.
  // (Steps 5 and 6)
  TreeHash computed_node_hash, computed_root_hash;
  if (fn == sn) {
    // The optimization mentioned above. (Step 5)
    std::copy(node_hash.begin(), node_hash.end(), computed_node_hash.data());
    std::copy(node_hash.begin(), node_hash.end(), computed_root_hash.data());
  } else {
    // The hashes start from the first value of the proof (Step 6)
    std::optional<TreeHashConstSpan> first_hash = NextProofHash(&proof);
    if (!first_hash) {
      return std::nullopt;
    }
    std::copy(first_hash->begin(), first_hash->end(),
              computed_node_hash.data());
    std::copy(first_hash->begin(), first_hash->end(),
              computed_root_hash.data());
  }

  // Iterate over the (remaining) elements of the proof array and traverse up
  // the fn/sn/tn paths until we reach the root of the tree. Each step should
  // consume one element from the proof array and move one level up the tree,
  // and if the proof is valid both iterators end at the same time. (Step 7)
  while (!proof.empty()) {
    auto p = NextProofHash(&proof);
    if (!p) {
      return std::nullopt;
    }
    // (Step 7.1)
    if (tn == 0) {
      // We reached the root of the tree before running out of elements in the
      // proof.
      return std::nullopt;
    }
    // Update the computed root_hash, and if applicable the computed node_hash.
    // We stop updating computed_node_hash when we've reached the level of the
    // root of the subtree, which occurs when the paths to the leftmost and
    // rightmost nodes of the subtree are the same, i.e. fn == sn.
    //
    // (Step 7.2)
    if ((sn & 1) == 1 || sn == tn) {
      // (Step 7.2.1)
      if (fn < sn) {
        HashNode(*p, computed_node_hash, computed_node_hash);
      }
      // (Step 7.2.2)
      HashNode(*p, computed_root_hash, computed_root_hash);
      // Until LSB(sn) is set, right-shift fn, sn, and tn equally.
      // (Step 7.2.3)
      while ((sn & 1) == 0) {
        fn >>= 1;
        sn >>= 1;
        tn >>= 1;
      }
    } else {
      // (Step 7.3.1)
      HashNode(computed_root_hash, *p, computed_root_hash);
    }
    // Advance the iterators: (Step 7.4)
    fn >>= 1;
    sn >>= 1;
    tn >>= 1;
  }

  // Check that the iterators ended together: (Step 8)
  if (tn != 0) {
    return std::nullopt;
  }

  // Check that the computed values match the expected values: (Step 8)
  if (CRYPTO_memcmp(computed_node_hash.data(), node_hash.data(),
                    computed_node_hash.size()) != 0) {
    return std::nullopt;
  }
  // Return the computed root_hash for the caller to compare:
  return computed_root_hash;
}

BSSL_NAMESPACE_END
