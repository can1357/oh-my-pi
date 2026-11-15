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

#ifndef BSSL_PKI_MERKLE_TREE_H_
#define BSSL_PKI_MERKLE_TREE_H_

#include <assert.h>

#include <array>
#include <optional>

#include <openssl/sha2.h>
#include <openssl/span.h>

BSSL_NAMESPACE_BEGIN

// A Subtree represents a range of elements in a Merkle Tree, identified by the
// half-open interval [start, end) of tree indexes. A Subtree with start == end
// represents a range of zero elements.
struct Subtree {
  uint64_t start;
  uint64_t end;

  constexpr bool operator==(const Subtree &other) const {
    return start == other.start && end == other.end;
  }

  // Returns the number of elements in the Subtree.
  constexpr uint64_t Size() const { return end - start; }

  // Returns a value k such that Subtrees left = [start, k) and right = [k, end)
  // are valid and share no interior nodes. Further, neither left nor right is
  // empty unless the input Subtree has fewer than 2 elements.
  constexpr uint64_t Split() const {
    uint64_t n = Size();
    if (n < 2) {
      return end;
    }
    // find the largest power of 2 smaller than n
    uint64_t k = Pow2Smaller(n);
    return start + k;
  }

  // Returns the left subtree of this Subtree. If this subtree has fewer than 2
  // elements, returns itself.
  constexpr Subtree Left() const { return {start, Split()}; }

  // Returns the right subtree of this Subtree. If this subtree has fewer than 2
  // elements, returns an empty subtree.
  constexpr Subtree Right() const { return {Split(), end}; }

  // Returns whether [start, end) specifies a valid Subtree.
  constexpr bool IsValid() const {
    // A Subtree's half-open interval must have start <= end, otherwise the
    // interval is improperly defined.
    if (start > end) {
      return false;
    }
    uint64_t n = Size();
    // A Subtree must not have a ragged left edge, i.e. if k is the largest
    // power of 2 that divides start, n must be less than or equal to k.
    uint64_t k = start & (~start + 1);
    return (start == 0 || n <= k);
  }

  // Returns whether this Subtree contains a leaf node at index.
  constexpr bool Contains(uint64_t index) const {
    return start <= index && index < end;
  }
  constexpr bool Contains(const Subtree &subtree) const {
    return start <= subtree.start && subtree.end <= end;
  }

 private:
  // compute the largest power of 2 smaller than n. Assumes n >= 2.
  constexpr static uint64_t Pow2Smaller(uint64_t n) {
    // TODO(crbug.com/404286922): replace the entirety of this function with
    // std::bit_floor(n-1) once we can use C++20.
    assert(n >= 2);
    // The bitwise OR ladder here (`n |= n >> 1; n |= n >> 2;` etc) takes a
    // number and copies any 1 bits to all positions to the right, resulting in
    // a number that looks like 0b00...00111...1, where the number of 1 bits
    // matches the bit position of the most significant bit in the input number.
    // Assuming the input number m has the most significant bit in position k,
    // it produces the value 2^(k+1)-1 >= m. Because both 2^(k+1)-1 and m have
    // their MSB in the same place, right shifting 2^(k+1)-1 1 bit produces a
    // number that is strictly smaller than both; that number is 2^k-1. Thus, we
    // have 2^k-1 < m <= 2^(k+1)-1.
    //
    // Using that bit trick and right shifting 1 give us 2^k-1, the largest "one
    // less than a power of 2" smaller than the input number. (It is the largest
    // such value because the next largest is 2^(k+1)-1, which we showed to be
    // greater than or equal to the input.) However, we want a power of 2, not
    // one less than a power of 2. Finishing the procedure by adding 1 gives us
    // a power of 2, but it does not guarantee that it is smaller than the
    // input. If we consider the inequality 2^k-1 < m <= 2^(k+1)-1, we can add 1
    // to all sides of the inequality to get 2^k < m+1 <= 2^(k+1). Given an
    // input value n, we want to find the value 2^k such that
    // 2^k < n <= 2^(k+1).
    //
    // Substituting n = m+1 and solving for m = n-1 means that running this
    // procedure with n-1 will give us the power of 2 we're looking for.
    n -= 1;
    n |= n >> 1;
    n |= n >> 2;
    n |= n >> 4;
    n |= n >> 8;
    n |= n >> 16;
    n |= n >> 32;
    return (n >> 1) + 1;
  }
};

using TreeHash = std::array<uint8_t, SHA256_DIGEST_LENGTH>;
using TreeHashSpan = Span<uint8_t, SHA256_DIGEST_LENGTH>;
using TreeHashConstSpan = Span<const uint8_t, SHA256_DIGEST_LENGTH>;

// Performs the procedure defined in section 4.4.3 of
// draft-davidben-tls-merkle-tree-certs-08, Verifying a Subtree Consistency
// Proof:
//
//   Given a Merkle Tree over `n` elements, a subtree defined by `[start, end)`,
//   a consistency proof `proof`, a subtree hash `node_hash`, and a root hash
//   `root_hash`
//
// The one difference between this function and the routine described in
// draft-davidben-tls-merkle-tree-certs-08 is that instead of taking `root_hash`
// as an input, this function returns the computed root hash and it is the
// caller's responsibility to verify that the computed root hash matches the
// expected root hash. This function returns std::nullopt if other steps of
// proof verification failed.
OPENSSL_EXPORT std::optional<TreeHash> EvaluateMerkleSubtreeConsistencyProof(
    uint64_t n, const Subtree &subtree, Span<const uint8_t> proof,
    TreeHashConstSpan node_hash);

// Helper function to compute the hash value of an interior node in a Merkle
// tree, i.e. HASH(0x01 || left || right). 32 bytes of output are written to
// |out|. This function is intended for internal use only and only exists here
// for the convenience of merkle_tree_unittest.cc.
OPENSSL_EXPORT void HashNode(TreeHashConstSpan left, TreeHashConstSpan right,
                             TreeHashSpan out);

BSSL_NAMESPACE_END

#endif  // BSSL_PKI_MERKLE_TREE_H_
