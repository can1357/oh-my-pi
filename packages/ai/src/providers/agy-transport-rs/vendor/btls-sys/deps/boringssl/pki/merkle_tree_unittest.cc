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

#include <cassert>
#include <cstdint>
#include <limits>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <openssl/sha2.h>

BSSL_NAMESPACE_BEGIN

namespace {

class MerkleTree {
 public:
  class Data {
   public:
    virtual ~Data() = default;
    virtual std::vector<uint8_t> At(uint64_t index) = 0;
    // Caching functions are only called for full subtrees (size is a power of
    // 2) that have size at least 2.
    virtual std::optional<TreeHash> NodeHash(Subtree node) = 0;
    virtual void CacheNodeHash(Subtree node, TreeHash hash) = 0;
  };

  explicit MerkleTree(Data *data) : data_(data) {}
  MerkleTree(const MerkleTree &) = delete;
  MerkleTree(MerkleTree &&) = default;
  MerkleTree &operator=(const MerkleTree &) = delete;
  MerkleTree &operator=(MerkleTree &&) = default;

  // MTH computes the Merkle Tree Hash (MTH; RFC 9162, section 2.1.1) of a
  // tree containing `end - start` elements from D_n, starting at d[start]. If
  // start > end or there is an internal error, this function returns nullopt.
  //
  // Note that the MTH function defined in RFC 9162 takes an ordered list of
  // inputs D_n. This function takes start and end indicies to identify the
  // inputs.
  std::optional<TreeHash> MTH(const Subtree &subtree) {
    if (!subtree.IsValid()) {
      return std::nullopt;
    }
    SHA256_CTX ctx;
    SHA256_Init(&ctx);
    TreeHash out;
    uint64_t n = subtree.Size();
    if (n == 0) {
      // The hash of an empty list is the hash of an empty string.
      SHA256_Final(out.data(), &ctx);
      return out;
    }
    if (n == 1) {
      // One element in the list: return a leaf hash.
      static const uint8_t header = 0x00;
      auto leaf = data_->At(subtree.start);
      SHA256_Update(&ctx, &header, 1);
      SHA256_Update(&ctx, leaf.data(), leaf.size());
      SHA256_Final(out.data(), &ctx);
      return out;
    }
    // Only use the cache for subtrees with a size that is a power of 2.
    uint64_t s = subtree.end - subtree.start;
    bool use_cache = (s & (s - 1)) == 0;
    if (use_cache) {
      if (auto hash_opt = data_->NodeHash(subtree); hash_opt.has_value()) {
        return *hash_opt;
      }
    }
    // n elements in the list: MTH() is defined recursively.
    auto left = MTH(subtree.Left());
    auto right = MTH(subtree.Right());
    if (!left.has_value() || !right.has_value()) {
      return std::nullopt;
    }
    HashNode(*left, *right, out);
    if (use_cache) {
      data_->CacheNodeHash(subtree, out);
    }
    return out;
  }

  // Computes an inclusion proof to the element at index in subtree from start
  // to end.
  std::optional<std::vector<TreeHash>> InclusionProof(uint64_t index,
                                                      const Subtree &subtree) {
    return SubtreeSubproof({index, index + 1}, subtree, true);
  }

  // Computes a consistency proof that |subtree| is contained in |tree|.
  std::optional<std::vector<TreeHash>> ConsistencyProof(const Subtree &subtree,
                                                        const Subtree &tree) {
    return SubtreeSubproof(subtree, tree, true);
  }

 private:
  // Computes a SUBTREE_SUBPROOF from subtree to tree, where subtree is
  // contained within tree.
  std::optional<std::vector<TreeHash>> SubtreeSubproof(Subtree subtree,
                                                       const Subtree &tree,
                                                       bool known_hash) {
    if (!subtree.IsValid() || !tree.IsValid() || !tree.Contains(subtree)) {
      // Invalid inputs
      return std::nullopt;
    }
    uint64_t n = tree.Size();
    if (n == 0) {
      // There must be a tree with contents for there to be a proof that
      // something is in said tree.
      return std::nullopt;
    }
    if (subtree == tree) {
      if (known_hash) {
        return std::vector<TreeHash>();
      }
      auto mth = MTH(tree);
      if (!mth.has_value()) {
        return std::nullopt;
      }
      return {{*mth}};
    }

    uint64_t k = tree.Split();
    Subtree subproof_tree, mth_tree;
    if (subtree.end <= k) {
      subproof_tree = tree.Left();
      mth_tree = tree.Right();
    } else if (subtree.start >= k) {
      mth_tree = tree.Left();
      subproof_tree = tree.Right();
    } else {
      subtree.start = k;
      mth_tree = tree.Left();
      subproof_tree = tree.Right();
      known_hash = false;
    }
    auto subproof = SubtreeSubproof(subtree, subproof_tree, known_hash);
    auto mth = MTH(mth_tree);
    if (!subproof.has_value() || !mth.has_value()) {
      return std::nullopt;
    }
    subproof->push_back(*mth);
    return subproof;
  }

  Data *data_;
};

size_t countr_zero(uint64_t n) {
  if (n == 0) {
    return 8 * sizeof(n);
  }
  size_t count = 0;
  while ((n & 1) == 0) {
    n >>= 1;
    count++;
  }
  return count;
}

class ConcatData : public MerkleTree::Data {
 public:
  explicit ConcatData(Span<const uint8_t> label)
      : label_(label.begin(), label.end()) {}

  std::vector<uint8_t> At(uint64_t index) override {
    std::vector<uint8_t> out(label_.size() + sizeof(index));
    memcpy(out.data(), label_.data(), label_.size());
    memcpy(out.data() + label_.size(), &index, sizeof(index));
    return out;
  }

  std::optional<TreeHash> NodeHash(Subtree node) override {
    size_t level_index = countr_zero(node.Size()) - 1;
    if (node_cache_.size() <= level_index) {
      return std::nullopt;
    }
    size_t position_index = node.start / node.Size();
    if (node_cache_[level_index].size() <= position_index) {
      return std::nullopt;
    }
    return node_cache_[level_index][position_index];
  }

  void CacheNodeHash(Subtree node, TreeHash hash) override {
    size_t level_index = countr_zero(node.Size()) - 1;
    size_t position_index = node.start / node.Size();
    if (level_index >= node_cache_.size()) {
      BSSL_CHECK(level_index == node_cache_.size());
      node_cache_.push_back({});
    }
    if (position_index < node_cache_[level_index].size()) {
      node_cache_[level_index][position_index] = hash;
      return;
    }
    node_cache_[level_index].resize(position_index);
    node_cache_[level_index].push_back(hash);
  }

 private:
  std::vector<uint8_t> label_;
  std::vector<std::vector<std::optional<TreeHash>>> node_cache_;
};


TEST(MerkleTreeTest, SubtreeIsValid) {
  // An empty subtree is valid.
  EXPECT_TRUE((Subtree{0, 0}.IsValid()));
  // But if the end is before start, it's invalid.
  EXPECT_FALSE((Subtree{1, 0}.IsValid()));
  // A subtree of the maximum expressible size is valid.
  EXPECT_TRUE((Subtree{0, std::numeric_limits<uint64_t>::max()}.IsValid()));

  // Subtrees don't have to start at 0.
  EXPECT_TRUE((Subtree{4, 8}.IsValid()));
  // But if they don't start at 0, there's a limit to how big they can be.
  EXPECT_FALSE((Subtree{4, 9}.IsValid()));
  // Subtrees can have a ragged right edge.
  EXPECT_TRUE((Subtree{4, 6}.IsValid()));
  EXPECT_TRUE((Subtree{0, 6}.IsValid()));
}

TEST(MerkleTreeTest, SubtreeSplit) {
  // Empty subtree.
  EXPECT_EQ((Subtree{24601, 24601}).Split(), 24601ul);
  // Single-item subtree.
  EXPECT_EQ((Subtree{1336, 1337}).Split(), 1337ul);
  // Two items in subtree.
  EXPECT_EQ((Subtree{42, 44}).Split(), 43ul);
  // Subtree size is 1 less than a power of 2.
  EXPECT_EQ((Subtree{0, 31}).Split(), 16ul);
  // Subtree size is a power of 2.
  EXPECT_EQ((Subtree{64, 128}).Split(), 96ul);
  /// Subtree size is 1 more than a power of 2.
  EXPECT_EQ((Subtree{0, 257}).Split(), 256ul);

  static const uint64_t u64_max = std::numeric_limits<uint64_t>::max();
  // Maximum size tree.
  EXPECT_EQ((Subtree{0, u64_max}).Split(), 1ull << 63);
  // Small tree, with end at maximum value.
  EXPECT_EQ((Subtree{u64_max - 3, u64_max}).Split(), u64_max - 1);
}

std::vector<uint8_t> ConcatProof(const std::vector<TreeHash> &proof) {
  std::vector<uint8_t> out;
  for (const auto &p : proof) {
    out.insert(out.end(), p.begin(), p.end());
  }
  return out;
}

TEST(MerkleTreeTest, VerifySubtreeConsistencyProof) {
  ConcatData tree_data(StringAsBytes("label"));
  MerkleTree tree(&tree_data);

  uint64_t index = 0;
  auto node_hash = tree.MTH({index, index + 1});
  Subtree subtree{0, 16};
  auto proof = tree.InclusionProof(index, subtree);
  ASSERT_TRUE(proof.has_value());
  auto root_hash = EvaluateMerkleSubtreeConsistencyProof(
      subtree.end, {index, index + 1}, ConcatProof(*proof), *node_hash);
  ASSERT_TRUE(root_hash.has_value());
  EXPECT_EQ(root_hash, tree.MTH(subtree));
}

// Test that the computed consistency proofs match the examples given in RFC
// 9162 section 2.1.5.
TEST(MerkleTreeTest, SubtreeConsistencyProofRFC9162) {
  ConcatData tree_data(StringAsBytes("label"));
  MerkleTree tree(&tree_data);

  // The example from section 2.1.5 has a final tree with 7 leaves.
  Subtree final_tree{0, 7};

  // The examples refer to letters representing the MTH of various subtrees
  // within that tree.
  // a isn't used in any of the examples.
  auto b = tree.MTH({1, 2});
  auto c = tree.MTH({2, 3});
  auto d = tree.MTH({3, 4});
  // e isn't used in any of the examples.
  auto f = tree.MTH({5, 6});
  auto g = tree.MTH({0, 2});
  auto h = tree.MTH({2, 4});
  auto i = tree.MTH({4, 6});
  auto j = tree.MTH({6, 7});
  auto k = tree.MTH({0, 4});
  auto l = tree.MTH({4, 7});

  // Inclusion proofs:

  // Section 2.1.5: "The inclusion proof for `d0` is `[b, h, l]`."
  auto d0_proof = tree.InclusionProof(0, final_tree);
  EXPECT_THAT(*d0_proof, testing::ElementsAre(*b, *h, *l));

  // Section 2.1.5: "The inclusion proof for `d3` is `[c, g, l]`."
  auto d3_proof = tree.InclusionProof(3, final_tree);
  EXPECT_THAT(*d3_proof, testing::ElementsAre(*c, *g, *l));

  // Section 2.1.5: "The inclusion proof for `d4` is `[f, j, k]`."
  auto d4_proof = tree.InclusionProof(4, final_tree);
  EXPECT_THAT(*d4_proof, testing::ElementsAre(*f, *j, *k));

  // Section 2.1.5: "The inclusion proof for `d6` is `[i, k]`."
  auto d6_proof = tree.InclusionProof(6, final_tree);
  EXPECT_THAT(*d6_proof, testing::ElementsAre(*i, *k));

  // Consistency proofs:

  // The consistency proofs refer to the lettered MTHs above, as well as some
  // MTHs representing the tree as it was incrementally built.
  Subtree hash0_subtree = {0, 3};
  Subtree hash1_subtree = {0, 4};
  auto hash1 = tree.MTH(hash1_subtree);
  ASSERT_EQ(hash1, k);
  Subtree hash2_subtree = {0, 6};

  // "The consistency proof between hash0 and hash is [c, d, g, l]."
  auto hash0_proof = tree.ConsistencyProof(hash0_subtree, final_tree);
  EXPECT_THAT(*hash0_proof, testing::ElementsAre(*c, *d, *g, *l));

  // "The consistency proof beween hash1 and hash is [l]."
  auto hash1_proof = tree.ConsistencyProof(hash1_subtree, final_tree);
  EXPECT_THAT(*hash1_proof, testing::ElementsAre(*l));

  // "The consistency proof between hash2 and hash is [i, j, k]."
  auto hash2_proof = tree.ConsistencyProof(hash2_subtree, final_tree);
  EXPECT_THAT(*hash2_proof, testing::ElementsAre(*i, *j, *k));
}

TEST(MerkleTreeTest, ValidProofsTest) {
  ConcatData tree_data(StringAsBytes("label"));
  MerkleTree tree(&tree_data);

  uint64_t n = 4, start = 0, end = 3;
  Subtree full_tree{0, n};
  auto tree_hash = tree.MTH(full_tree);
  Subtree subtree{start, end};
  ASSERT_TRUE(subtree.IsValid());
  auto subtree_hash = tree.MTH(subtree);

  auto proof = tree.ConsistencyProof(subtree, full_tree);
  ASSERT_TRUE(proof.has_value());
  auto computed_hash = EvaluateMerkleSubtreeConsistencyProof(
      n, subtree, ConcatProof(*proof), *subtree_hash);
  EXPECT_EQ(computed_hash, tree_hash);
}

TEST(MerkleTreeTest, ValidProofs) {
  ConcatData tree_data(StringAsBytes("label"));
  MerkleTree tree(&tree_data);

  // As of the time of writing this test, a run was performed with limit=257 and
  // the test passed (but it took 1.7 seconds to run). This value is set to 129
  // to balance how much of the space to explore with test execution time.
  uint64_t limit = 129;
  for (uint64_t n = 0; n < limit; n++) {
    Subtree full_tree{0, n};
    auto tree_hash = tree.MTH(full_tree);
    for (uint64_t end = 0; end <= n; end++) {
      for (uint64_t start = 0; start < end; start++) {
        Subtree subtree{start, end};
        if (!subtree.IsValid()) {
          continue;
        }
        SCOPED_TRACE(testing::Message() << "Tree n=" << n << ", start: "
                                        << start << ", end: " << end);
        auto subtree_hash = tree.MTH(subtree);

        auto proof = tree.ConsistencyProof(subtree, full_tree);
        ASSERT_TRUE(proof.has_value());
        auto computed_hash = EvaluateMerkleSubtreeConsistencyProof(
            n, subtree, ConcatProof(*proof), *subtree_hash);
        EXPECT_EQ(computed_hash, tree_hash);
      }
    }
  }
}

class ConstData : public MerkleTree::Data {
 public:
  // A tree that uses ConstData has the same data at every index in the tree.
  std::vector<uint8_t> At(uint64_t index) override { return {}; }

  std::optional<TreeHash> NodeHash(Subtree node) override {
    size_t index = countr_zero(node.Size()) - 1;
    if (node_cache_.size() <= index) {
      return std::nullopt;
    }
    return node_cache_[index];
  }

  void CacheNodeHash(Subtree node, TreeHash hash) override {
    size_t index = countr_zero(node.Size()) - 1;
    // Cache entries are only inserted if not present, and always inserted from
    // lowest level of the tree to highest.
    BSSL_CHECK(index == node_cache_.size());
    node_cache_.push_back(hash);
  }

 private:
  std::vector<TreeHash> node_cache_;
};

TEST(MerkleTreeTest, VeryLargeProofs) {
  ConstData tree_data;
  MerkleTree tree(&tree_data);

  Subtree fullest_tree = {0, std::numeric_limits<uint64_t>::max()};
  auto root_hash = tree.MTH(fullest_tree);
  ASSERT_TRUE(root_hash.has_value());

  Subtree test_subtrees[] = {
      fullest_tree,
      {0, 1},
      {0, 1ull << 63},
      {1ull << 63, std::numeric_limits<uint64_t>::max()},
      {std::numeric_limits<uint64_t>::max() - 1,
       std::numeric_limits<uint64_t>::max()},
  };
  for (auto subtree : test_subtrees) {
    SCOPED_TRACE(testing::Message() << "Subtree start: " << subtree.start
                                    << ", end: " << subtree.end);

    auto proof = tree.ConsistencyProof(subtree, fullest_tree);
    ASSERT_TRUE(proof.has_value());
    auto computed_root_hash = EvaluateMerkleSubtreeConsistencyProof(
        fullest_tree.end, subtree, ConcatProof(*proof), *tree.MTH(subtree));
    EXPECT_EQ(computed_root_hash, root_hash);
  }
}

}  // namespace

BSSL_NAMESPACE_END
