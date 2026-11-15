// Copyright 2024 The BoringSSL Authors
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

#include <gtest/gtest.h>

#include <openssl/aead.h>
#include <openssl/ssl.h>

#include "internal.h"


#if !defined(BORINGSSL_SHARED_LIBRARY)
BSSL_NAMESPACE_BEGIN
namespace {

TEST(ReconstructSeqnumTest, Increment) {
  // Test simple cases from the beginning of an epoch with both 8- and 16-bit
  // wire sequence numbers.
  EXPECT_EQ(reconstruct_seqnum(0, 0xff, 0), 0u);
  EXPECT_EQ(reconstruct_seqnum(1, 0xff, 0), 1u);
  EXPECT_EQ(reconstruct_seqnum(2, 0xff, 0), 2u);
  EXPECT_EQ(reconstruct_seqnum(0, 0xffff, 0), 0u);
  EXPECT_EQ(reconstruct_seqnum(1, 0xffff, 0), 1u);
  EXPECT_EQ(reconstruct_seqnum(2, 0xffff, 0), 2u);

  // When the max seen sequence number is 0, the numerically closest
  // reconstructed sequence number could be negative. Sequence numbers are
  // non-negative, so reconstruct_seqnum should instead return the closest
  // non-negative number instead of returning a number congruent to that
  // closest negative number mod 2^64.
  EXPECT_EQ(reconstruct_seqnum(0xff, 0xff, 0), 0xffu);
  EXPECT_EQ(reconstruct_seqnum(0xfe, 0xff, 0), 0xfeu);
  EXPECT_EQ(reconstruct_seqnum(0xffff, 0xffff, 0), 0xffffu);
  EXPECT_EQ(reconstruct_seqnum(0xfffe, 0xffff, 0), 0xfffeu);

  // When the wire sequence number is less than the corresponding low bytes of
  // the max seen sequence number, check that the next larger sequence number
  // is reconstructed as its numerically closer than the corresponding sequence
  // number that would keep the high order bits the same.
  EXPECT_EQ(reconstruct_seqnum(0, 0xff, 0xff), 0x100u);
  EXPECT_EQ(reconstruct_seqnum(1, 0xff, 0xff), 0x101u);
  EXPECT_EQ(reconstruct_seqnum(2, 0xff, 0xff), 0x102u);
  EXPECT_EQ(reconstruct_seqnum(0, 0xffff, 0xffff), 0x10000u);
  EXPECT_EQ(reconstruct_seqnum(1, 0xffff, 0xffff), 0x10001u);
  EXPECT_EQ(reconstruct_seqnum(2, 0xffff, 0xffff), 0x10002u);

  // Test cases when the wire sequence number is close to the largest magnitude
  // that can be represented in 8 or 16 bits.
  EXPECT_EQ(reconstruct_seqnum(0xff, 0xff, 0x2f0), 0x2ffu);
  EXPECT_EQ(reconstruct_seqnum(0xfe, 0xff, 0x2f0), 0x2feu);
  EXPECT_EQ(reconstruct_seqnum(0xffff, 0xffff, 0x2f000), 0x2ffffu);
  EXPECT_EQ(reconstruct_seqnum(0xfffe, 0xffff, 0x2f000), 0x2fffeu);

  // Test that reconstruct_seqnum can return the maximum sequence number,
  // 2^48-1.
  constexpr uint64_t kMaxSequence = (uint64_t{1} << 48) - 1;
  EXPECT_EQ(reconstruct_seqnum(0xff, 0xff, kMaxSequence), kMaxSequence);
  EXPECT_EQ(reconstruct_seqnum(0xff, 0xff, kMaxSequence - 1), kMaxSequence);
  EXPECT_EQ(reconstruct_seqnum(0xffff, 0xffff, kMaxSequence), kMaxSequence);
  EXPECT_EQ(reconstruct_seqnum(0xffff, 0xffff, kMaxSequence - 1), kMaxSequence);
}

TEST(ReconstructSeqnumTest, Decrement) {
  // Test that the sequence number 0 can be reconstructed when the max
  // seen sequence number is greater than 0.
  EXPECT_EQ(reconstruct_seqnum(0, 0xff, 0x10), 0u);
  EXPECT_EQ(reconstruct_seqnum(0, 0xffff, 0x1000), 0u);

  // Test cases where the reconstructed sequence number is less than the max
  // seen sequence number.
  EXPECT_EQ(reconstruct_seqnum(0, 0xff, 0x210), 0x200u);
  EXPECT_EQ(reconstruct_seqnum(2, 0xff, 0x210), 0x202u);
  EXPECT_EQ(reconstruct_seqnum(0, 0xffff, 0x43210), 0x40000u);
  EXPECT_EQ(reconstruct_seqnum(2, 0xffff, 0x43210), 0x40002u);

  // Test when the wire sequence number is greater than the low bits of the
  // max seen sequence number.
  EXPECT_EQ(reconstruct_seqnum(0xff, 0xff, 0x200), 0x1ffu);
  EXPECT_EQ(reconstruct_seqnum(0xfe, 0xff, 0x200), 0x1feu);
  EXPECT_EQ(reconstruct_seqnum(0xffff, 0xffff, 0x20000), 0x1ffffu);
  EXPECT_EQ(reconstruct_seqnum(0xfffe, 0xffff, 0x20000), 0x1fffeu);

  constexpr uint64_t kMaxSequence = (uint64_t{1} << 48) - 1;
  // kMaxSequence00 is kMaxSequence with the last byte replaced with 0x00.
  constexpr uint64_t kMaxSequence00 = kMaxSequence - 0xff;
  // kMaxSequence0000 is kMaxSequence with the last byte replaced with 0x0000.
  constexpr uint64_t kMaxSequence0000 = kMaxSequence - 0xffff;

  // Test when the max seen sequence number is close to the 2^48-1 max value.
  // In some cases, the closest numerical value in the integers will exceed the
  // limit. In this case, reconstruct_seqnum should return the closest integer
  // within range.
  EXPECT_EQ(reconstruct_seqnum(0, 0xff, kMaxSequence), kMaxSequence00);
  EXPECT_EQ(reconstruct_seqnum(0, 0xff, kMaxSequence - 1), kMaxSequence00);
  EXPECT_EQ(reconstruct_seqnum(1, 0xff, kMaxSequence), kMaxSequence00 + 0x01);
  EXPECT_EQ(reconstruct_seqnum(1, 0xff, kMaxSequence - 1),
            kMaxSequence00 + 0x01);
  EXPECT_EQ(reconstruct_seqnum(0xfe, 0xff, kMaxSequence),
            kMaxSequence00 + 0xfe);
  EXPECT_EQ(reconstruct_seqnum(0xfd, 0xff, kMaxSequence - 1),
            kMaxSequence00 + 0xfd);
  EXPECT_EQ(reconstruct_seqnum(0, 0xffff, kMaxSequence), kMaxSequence0000);
  EXPECT_EQ(reconstruct_seqnum(0, 0xffff, kMaxSequence - 1), kMaxSequence0000);
  EXPECT_EQ(reconstruct_seqnum(1, 0xffff, kMaxSequence),
            kMaxSequence0000 + 0x0001);
  EXPECT_EQ(reconstruct_seqnum(1, 0xffff, kMaxSequence - 1),
            kMaxSequence0000 + 0x0001);
  EXPECT_EQ(reconstruct_seqnum(0xfffe, 0xffff, kMaxSequence),
            kMaxSequence0000 + 0xfffe);
  EXPECT_EQ(reconstruct_seqnum(0xfffd, 0xffff, kMaxSequence - 1),
            kMaxSequence0000 + 0xfffd);
}

TEST(ReconstructSeqnumTest, Halfway) {
  // Test wire sequence numbers that are close to halfway away from the max
  // seen sequence number. The algorithm specifies that the output should be
  // numerically closest to 1 plus the max seen (0x100 in the following test
  // cases). With a max seen of 0x100 and a wire sequence of 0x81, the two
  // closest values to 1+0x100 are 0x81 and 0x181, which are both the same
  // amount away. The algorithm doesn't specify what to do on this edge case;
  // our implementation chooses the larger value (0x181), on the assumption that
  // it's more likely to be a new or larger sequence number rather than a replay
  // or an out-of-order packet.
  EXPECT_EQ(reconstruct_seqnum(0x80, 0xff, 0x100), 0x180u);
  EXPECT_EQ(reconstruct_seqnum(0x81, 0xff, 0x100), 0x181u);
  EXPECT_EQ(reconstruct_seqnum(0x82, 0xff, 0x100), 0x82u);

  // Repeat these tests with 16-bit wire sequence numbers.
  EXPECT_EQ(reconstruct_seqnum(0x8000, 0xffff, 0x10000), 0x18000u);
  EXPECT_EQ(reconstruct_seqnum(0x8001, 0xffff, 0x10000), 0x18001u);
  EXPECT_EQ(reconstruct_seqnum(0x8002, 0xffff, 0x10000), 0x8002u);
}

TEST(DTLSMessageBitmapTest, Basic) {
  // expect_bitmap checks that |b|'s unmarked bits are those listed in |ranges|.
  // Each element of |ranges| must be non-empty and non-overlapping, and
  // |ranges| must be sorted.
  auto expect_bitmap = [](const DTLSMessageBitmap &b,
                          const std::vector<DTLSMessageBitmap::Range> &ranges) {
    EXPECT_EQ(ranges.empty(), b.IsComplete());
    size_t start = 0;
    for (const auto &r : ranges) {
      for (; start < r.start; start++) {
        SCOPED_TRACE(start);
        EXPECT_EQ(b.NextUnmarkedRange(start), r);
      }
      for (; start < r.end; start++) {
        SCOPED_TRACE(start);
        EXPECT_EQ(b.NextUnmarkedRange(start),
                  (DTLSMessageBitmap::Range{start, r.end}));
      }
    }
    EXPECT_TRUE(b.NextUnmarkedRange(start).empty());
    EXPECT_TRUE(b.NextUnmarkedRange(start + 1).empty());
    EXPECT_TRUE(b.NextUnmarkedRange(start + 42).empty());

    // This is implied from the previous checks, but NextUnmarkedRange should
    // work as an iterator to reconstruct the ranges.
    std::vector<DTLSMessageBitmap::Range> got_ranges;
    for (auto r = b.NextUnmarkedRange(0); !r.empty();
         r = b.NextUnmarkedRange(r.end)) {
      got_ranges.push_back(r);
    }
    EXPECT_EQ(ranges, got_ranges);
  };

  // Initially, the bitmap is empty (fully marked).
  DTLSMessageBitmap bitmap;
  expect_bitmap(bitmap, {});

  // It can also be initialized to the empty message and marked.
  ASSERT_TRUE(bitmap.Init(0));
  expect_bitmap(bitmap, {});
  bitmap.MarkRange(0, 0);
  expect_bitmap(bitmap, {});

  // Track 100 bits and mark byte by byte.
  ASSERT_TRUE(bitmap.Init(100));
  expect_bitmap(bitmap, {{0, 100}});
  for (size_t i = 0; i < 100; i++) {
    SCOPED_TRACE(i);
    bitmap.MarkRange(i, i + 1);
    if (i < 99) {
      expect_bitmap(bitmap, {{i + 1, 100}});
    } else {
      expect_bitmap(bitmap, {});
    }
  }

  // Do the same but in reverse.
  ASSERT_TRUE(bitmap.Init(100));
  expect_bitmap(bitmap, {{0, 100}});
  for (size_t i = 100; i > 0; i--) {
    SCOPED_TRACE(i);
    bitmap.MarkRange(i - 1, i);
    if (i > 1) {
      expect_bitmap(bitmap, {{0, i - 1}});
    } else {
      expect_bitmap(bitmap, {});
    }
  }

  // Overlapping ranges are fine.
  ASSERT_TRUE(bitmap.Init(100));
  expect_bitmap(bitmap, {{0, 100}});
  for (size_t i = 0; i < 100; i++) {
    SCOPED_TRACE(i);
    bitmap.MarkRange(i / 2, i + 1);
    if (i < 99) {
      expect_bitmap(bitmap, {{i + 1, 100}});
    } else {
      expect_bitmap(bitmap, {});
    }
  }

  // Mark the middle chunk of every power of 3.
  ASSERT_TRUE(bitmap.Init(100));
  bitmap.MarkRange(1, 2);
  bitmap.MarkRange(3, 6);
  bitmap.MarkRange(9, 18);
  bitmap.MarkRange(27, 54);
  bitmap.MarkRange(81, 162);
  expect_bitmap(bitmap, {{0, 1}, {2, 3}, {6, 9}, {18, 27}, {54, 81}});

  // Mark most of the chunk shifted down a bit, so it both overlaps the previous
  // and also leaves some of the right chunks unmarked.
  bitmap.MarkRange(6 - 2, 9 - 2);
  bitmap.MarkRange(18 - 4, 27 - 4);
  bitmap.MarkRange(54 - 8, 81 - 8);
  expect_bitmap(bitmap,
                {{0, 1}, {2, 3}, {9 - 2, 9}, {27 - 4, 27}, {81 - 8, 81}});

  // Re-mark things that have already been marked.
  bitmap.MarkRange(1, 2);
  bitmap.MarkRange(3, 6);
  bitmap.MarkRange(9, 18);
  bitmap.MarkRange(27, 54);
  bitmap.MarkRange(81, 162);
  expect_bitmap(bitmap,
                {{0, 1}, {2, 3}, {9 - 2, 9}, {27 - 4, 27}, {81 - 8, 81}});

  // Moves should work.
  DTLSMessageBitmap bitmap2 = std::move(bitmap);
  expect_bitmap(bitmap, {});
  expect_bitmap(bitmap2,
                {{0, 1}, {2, 3}, {9 - 2, 9}, {27 - 4, 27}, {81 - 8, 81}});

  // Mark everything in two large ranges.
  bitmap2.MarkRange(27 - 2, 100);
  expect_bitmap(bitmap2, {{0, 1}, {2, 3}, {9 - 2, 9}, {27 - 4, 27 - 2}});
  bitmap2.MarkRange(0, 50);
  expect_bitmap(bitmap2, {});

  // MarkRange inputs may be "out of bounds". The bitmap has conceptually
  // infinitely many marked bits past where it was initialized.
  ASSERT_TRUE(bitmap.Init(10));
  expect_bitmap(bitmap, {{0, 10}});
  bitmap.MarkRange(5, SIZE_MAX);
  expect_bitmap(bitmap, {{0, 5}});
  bitmap.MarkRange(0, SIZE_MAX);
  expect_bitmap(bitmap, {});
}

TEST(MRUQueueTest, Basic) {
  // Use a complex type to confirm the queue handles them correctly.
  MRUQueue<std::unique_ptr<int>, 8> queue;
  auto expect_queue = [&](const std::vector<int> &expected) {
    EXPECT_EQ(queue.size(), expected.size());
    EXPECT_EQ(queue.empty(), expected.empty());
    std::vector<int> queue_values;
    for (size_t i = 0; i < queue.size(); i++) {
      queue_values.push_back(*queue[i]);
    }
    EXPECT_EQ(queue_values, expected);
  };

  expect_queue({});
  queue.PushBack(std::make_unique<int>(1));
  expect_queue({1});
  queue.PushBack(std::make_unique<int>(2));
  expect_queue({1, 2});
  queue.PushBack(std::make_unique<int>(3));
  expect_queue({1, 2, 3});
  queue.PushBack(std::make_unique<int>(4));
  expect_queue({1, 2, 3, 4});
  queue.PushBack(std::make_unique<int>(5));
  expect_queue({1, 2, 3, 4, 5});
  queue.PushBack(std::make_unique<int>(6));
  expect_queue({1, 2, 3, 4, 5, 6});
  queue.PushBack(std::make_unique<int>(7));
  expect_queue({1, 2, 3, 4, 5, 6, 7});
  queue.PushBack(std::make_unique<int>(8));
  expect_queue({1, 2, 3, 4, 5, 6, 7, 8});

  // We are at capacity, so later additions will drop the start. Do more than 8
  // insertions to test that the start index can wrap around.
  queue.PushBack(std::make_unique<int>(9));
  expect_queue({2, 3, 4, 5, 6, 7, 8, 9});
  queue.PushBack(std::make_unique<int>(10));
  expect_queue({3, 4, 5, 6, 7, 8, 9, 10});
  queue.PushBack(std::make_unique<int>(11));
  expect_queue({4, 5, 6, 7, 8, 9, 10, 11});
  queue.PushBack(std::make_unique<int>(12));
  expect_queue({5, 6, 7, 8, 9, 10, 11, 12});
  queue.PushBack(std::make_unique<int>(13));
  expect_queue({6, 7, 8, 9, 10, 11, 12, 13});
  queue.PushBack(std::make_unique<int>(14));
  expect_queue({7, 8, 9, 10, 11, 12, 13, 14});
  queue.PushBack(std::make_unique<int>(15));
  expect_queue({8, 9, 10, 11, 12, 13, 14, 15});
  queue.PushBack(std::make_unique<int>(16));
  expect_queue({9, 10, 11, 12, 13, 14, 15, 16});
  queue.PushBack(std::make_unique<int>(17));
  expect_queue({10, 11, 12, 13, 14, 15, 16, 17});

  // Clearing the queue should not leave the start index in a bad place.
  queue.Clear();
  expect_queue({});
  queue.PushBack(std::make_unique<int>(1));
  expect_queue({1});
  queue.PushBack(std::make_unique<int>(2));
  expect_queue({1, 2});
  queue.PushBack(std::make_unique<int>(3));
  expect_queue({1, 2, 3});
}

TEST(SSLAEADContextTest, Lengths) {
  struct LengthTest {
    // All plaintext lengths from |min_plaintext_len| to |max_plaintext_len|
    // should return in |cipertext_len|.
    size_t min_plaintext_len;
    size_t max_plaintext_len;
    size_t ciphertext_len;
  };

  struct CipherLengthTest {
    uint16_t cipher;
    uint16_t version;
    size_t enc_key_len, mac_key_len, fixed_iv_len;
    size_t block_size;
    std::vector<LengthTest> length_tests;
  };

  const CipherLengthTest kTests[] = {
      // 20-byte MAC, 8-byte CBC blocks with padding
      {
          /*cipher=*/SSL_CIPHER_RSA_WITH_3DES_EDE_CBC_SHA,
          /*version=*/TLS1_2_VERSION,
          /*enc_key_len=*/24,
          /*mac_key_len=*/20,
          /*fixed_iv_len=*/0,
          /*block_size=*/8,
          {
              {/*min_plaintext_len=*/0,
               /*max_plaintext_len=*/3,
               /*ciphertext_len=*/32},
              {/*min_plaintext_len=*/4,
               /*max_plaintext_len=*/11,
               /*ciphertext_len=*/40},
              {/*min_plaintext_len=*/12,
               /*max_plaintext_len=*/19,
               /*ciphertext_len=*/48},
          },
      },
      // 20-byte MAC, 16-byte CBC blocks with padding
      {
          /*cipher=*/SSL_CIPHER_RSA_WITH_AES_128_CBC_SHA,
          /*version=*/TLS1_2_VERSION,
          /*enc_key_len=*/16,
          /*mac_key_len=*/20,
          /*fixed_iv_len=*/0,
          /*block_size=*/16,
          {
              {/*min_plaintext_len=*/0,
               /*max_plaintext_len=*/11,
               /*ciphertext_len=*/48},
              {/*min_plaintext_len=*/12,
               /*max_plaintext_len=*/27,
               /*ciphertext_len=*/64},
              {/*min_plaintext_len=*/38,
               /*max_plaintext_len=*/43,
               /*ciphertext_len=*/80},
          },
      },
      // 32-byte MAC, 16-byte CBC blocks with padding
      {
          /*cipher=*/SSL_CIPHER_ECDHE_RSA_WITH_AES_128_CBC_SHA256,
          /*version=*/TLS1_2_VERSION,
          /*enc_key_len=*/16,
          /*mac_key_len=*/32,
          /*fixed_iv_len=*/0,
          /*block_size=*/16,
          {
              {/*min_plaintext_len=*/0,
               /*max_plaintext_len=*/15,
               /*ciphertext_len=*/64},
              {/*min_plaintext_len=*/16,
               /*max_plaintext_len=*/31,
               /*ciphertext_len=*/80},
              {/*min_plaintext_len=*/32,
               /*max_plaintext_len=*/47,
               /*ciphertext_len=*/96},
          },
      },
      // 8-byte explicit IV, 16-byte tag
      {
          /*cipher=*/SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
          /*version=*/TLS1_2_VERSION,
          /*enc_key_len=*/16,
          /*mac_key_len=*/0,
          /*fixed_iv_len=*/4,
          /*block_size=*/1,
          {
              {/*min_plaintext_len=*/0,
               /*max_plaintext_len=*/0,
               /*ciphertext_len=*/24},
              {/*min_plaintext_len=*/1,
               /*max_plaintext_len=*/1,
               /*ciphertext_len=*/25},
              {/*min_plaintext_len=*/2,
               /*max_plaintext_len=*/2,
               /*ciphertext_len=*/26},
              {/*min_plaintext_len=*/42,
               /*max_plaintext_len=*/42,
               /*ciphertext_len=*/66},
          },
      },
      // No explicit IV, 16-byte tag. TLS 1.3's padding and record type overhead
      // is added at another layer.
      {
          /*cipher=*/SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
          /*version=*/TLS1_2_VERSION,
          /*enc_key_len=*/32,
          /*mac_key_len=*/0,
          /*fixed_iv_len=*/12,
          /*block_size=*/1,
          {
              {/*min_plaintext_len=*/0,
               /*max_plaintext_len=*/0,
               /*ciphertext_len=*/16},
              {/*min_plaintext_len=*/1,
               /*max_plaintext_len=*/1,
               /*ciphertext_len=*/17},
              {/*min_plaintext_len=*/2,
               /*max_plaintext_len=*/2,
               /*ciphertext_len=*/18},
              {/*min_plaintext_len=*/42,
               /*max_plaintext_len=*/42,
               /*ciphertext_len=*/58},
          },
      },
      {
          /*cipher=*/SSL_CIPHER_AES_128_GCM_SHA256,
          /*version=*/TLS1_3_VERSION,
          /*enc_key_len=*/16,
          /*mac_key_len=*/0,
          /*fixed_iv_len=*/12,
          /*block_size=*/1,
          {
              {/*min_plaintext_len=*/0,
               /*max_plaintext_len=*/0,
               /*ciphertext_len=*/16},
              {/*min_plaintext_len=*/1,
               /*max_plaintext_len=*/1,
               /*ciphertext_len=*/17},
              {/*min_plaintext_len=*/2,
               /*max_plaintext_len=*/2,
               /*ciphertext_len=*/18},
              {/*min_plaintext_len=*/42,
               /*max_plaintext_len=*/42,
               /*ciphertext_len=*/58},
          },
      },
      {
          /*cipher=*/SSL_CIPHER_CHACHA20_POLY1305_SHA256,
          /*version=*/TLS1_3_VERSION,
          /*enc_key_len=*/32,
          /*mac_key_len=*/0,
          /*fixed_iv_len=*/12,
          /*block_size=*/1,
          {
              {/*min_plaintext_len=*/0,
               /*max_plaintext_len=*/0,
               /*ciphertext_len=*/16},
              {/*min_plaintext_len=*/1,
               /*max_plaintext_len=*/1,
               /*ciphertext_len=*/17},
              {/*min_plaintext_len=*/2,
               /*max_plaintext_len=*/2,
               /*ciphertext_len=*/18},
              {/*min_plaintext_len=*/42,
               /*max_plaintext_len=*/42,
               /*ciphertext_len=*/58},
          },
      },
  };

  for (const auto &cipher_test : kTests) {
    const SSL_CIPHER *cipher =
        SSL_get_cipher_by_value(static_cast<uint16_t>(cipher_test.cipher));
    ASSERT_TRUE(cipher) << "Could not find cipher " << cipher_test.cipher;
    SCOPED_TRACE(SSL_CIPHER_standard_name(cipher));

    const uint8_t kZeros[EVP_AEAD_MAX_KEY_LENGTH] = {0};
    UniquePtr<SSLAEADContext> aead =
        SSLAEADContext::Create(evp_aead_seal, cipher_test.version, cipher,
                               Span(kZeros).first(cipher_test.enc_key_len),
                               Span(kZeros).first(cipher_test.mac_key_len),
                               Span(kZeros).first(cipher_test.fixed_iv_len));
    ASSERT_TRUE(aead);

    for (const auto &t : cipher_test.length_tests) {
      SCOPED_TRACE(t.ciphertext_len);

      for (size_t plaintext_len = t.min_plaintext_len;
           plaintext_len <= t.max_plaintext_len; plaintext_len++) {
        SCOPED_TRACE(plaintext_len);
        size_t out_len;
        ASSERT_TRUE(aead->CiphertextLen(&out_len, plaintext_len, 0));
        EXPECT_EQ(out_len, t.ciphertext_len);
      }

      EXPECT_EQ(aead->MaxSealInputLen(t.ciphertext_len), t.max_plaintext_len);
      for (size_t extra = 0; extra < cipher_test.block_size; extra++) {
        // Adding up to block_size - 1 bytes of space should not change how much
        // room we have.
        SCOPED_TRACE(extra);
        EXPECT_EQ(aead->MaxSealInputLen(t.ciphertext_len + extra),
                  t.max_plaintext_len);
      }
    }
  }
}

}  // namespace
BSSL_NAMESPACE_END
#endif  // !BORINGSSL_SHARED_LIBRARY
