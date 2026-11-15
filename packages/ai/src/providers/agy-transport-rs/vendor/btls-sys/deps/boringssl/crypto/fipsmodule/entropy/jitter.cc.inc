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

// BoringCrypto Jitter Entropy version 20250725.

#include <openssl/base.h>

#if defined(OPENSSL_LINUX) || defined(OPENSSL_MACOS)

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <array>
#include <type_traits>
#include <utility>

#include <openssl/mem.h>

#include "internal.h"
#include "sha512.cc.inc"

#if defined(__x86_64__)
#include <x86intrin.h>
#endif


BSSL_NAMESPACE_BEGIN
namespace entropy {
namespace {

#if defined(__x86_64__)
static inline uint64_t GetTimestamp() { return _rdtsc(); }
#elif defined(__aarch64__)
static inline uint64_t GetTimestamp() {
  // Ideally this would use __arm_rsr64 from <arm_acle.h>. Clang has supported
  // it Clang 3.7 (2016), but GCC did not add it until GCC 14.1.0 (2024). See
  // https://crbug.com/440670941. When our minimum GCC is past that point,
  // switch this back to __arm_rsr64.
  uint64_t ret;
  __asm__ volatile("mrs %0, cntvct_el0" : "=r"(ret));
  return ret;
}
#else
static inline uint64_t GetTimestamp() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC_RAW, &ts);
  return ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}
#endif

class MemoryOffsetLCG {
 public:
  MemoryOffsetLCG() : state(GetTimestamp() & 0xFFFFFFFF) {}
  uint32_t Next() {
    state = state * 1664525 + 1013904223;
    return state;
  }

 private:
  uint32_t state;
};

class MemoryAccessSampler {
 public:
  MemoryAccessSampler(size_t array_size, unsigned num_samples)
      : array_size_(array_size),
        num_samples_(num_samples),
        array_(reinterpret_cast<uint8_t *>(OPENSSL_malloc(array_size_))) {
    if (array_ == nullptr ||         //
        array_size_ == 0 ||          //
        array_size_ > (1u << 26) ||  //
        array_size_ & (array_size_ - 1)) {
      abort();
    }
  }

  ~MemoryAccessSampler() { OPENSSL_free(const_cast<uint8_t *>(array_)); }

  MemoryAccessSampler(const MemoryAccessSampler &) = delete;
  MemoryAccessSampler &operator=(const MemoryAccessSampler &) = delete;

  MemoryAccessSampler(MemoryAccessSampler &&other)
      : array_size_(other.array_size_),
        num_samples_(other.num_samples_),
        lcg_(other.lcg_),
        array_(other.array_) {
    other.array_ = nullptr;
  }

  bool Next(uint64_t *out) {
    // Perform some memory accesses and measure how long it took. The LCG is
    // intended to defeat any CPU predictors and thus expose this code to as
    // much system entropy as possible.
    for (unsigned i = 0; i < num_samples_; i++) {
      // The lower bits of an LCG tend to fall into short cycles and so are
      // discarded here.
      array_[(lcg_.Next() >> 6) & (array_size_ - 1)] += 1;
    }

    *out = GetTimestamp();
    return true;
  }

 private:
  const size_t array_size_;
  const unsigned num_samples_;
  MemoryOffsetLCG lcg_;
  volatile uint8_t *array_;
};

template <typename T>
class DeltaSampler {
 public:
  explicit DeltaSampler(T &&sub_sampler)
      : sub_sampler_(std::forward<T>(sub_sampler)) {}

  // Next function to return the delta between two subsequent samples
  bool Next(uint64_t *out) {
    uint64_t sample;
    if (!sub_sampler_.Next(&sample)) {
      return false;
    }

    if (!initialized_) {
      last_sample_ = sample;
      if (!sub_sampler_.Next(&sample)) {
        return false;
      }
      initialized_ = true;
    }

    *out = sample - last_sample_;
    last_sample_ = sample;
    return true;
  }

 private:
  bool initialized_ = false;
  T sub_sampler_;
  uint64_t last_sample_ = 0;
};

template <typename U>
DeltaSampler(U &&sub_sampler) -> DeltaSampler<std::decay_t<U>>;

template <typename T>
class MaskSampler {
 public:
  explicit MaskSampler(uint8_t mask, T &&sub_sampler)
      : mask_(mask), sub_sampler_(std::forward<T>(sub_sampler)) {}

  bool Next(uint8_t *out) {
    uint64_t sample;
    if (!sub_sampler_.Next(&sample)) {
      return false;
    }

    *out = sample & mask_;
    return true;
  }

 private:
  const uint8_t mask_;
  T sub_sampler_;
};

template <typename U>
MaskSampler(uint8_t mask, U &&sub_sampler) -> MaskSampler<std::decay_t<U>>;

// The estimated entropy per sample from MaskSampler.
constexpr float kH = 0.8;

// kAlphaLog2 is log_2(alpha), where alpha is the standard false-positive
// probability from SP 800-90B.
static constexpr float kAlphaLog2 = -20;
// kAlpha is the variable of the same name from section 4.4.1 of SP 800-90B.
constexpr float kAlpha = 1.0 / (1 << static_cast<unsigned>(-kAlphaLog2));

// Ceil rounds up its non-negative argument to the next integer. (std::ceil
// isn't constexpr until C++23.)
constexpr unsigned Ceil(float val) {
  auto truncated = static_cast<unsigned>(val);
  if (val == static_cast<float>(truncated)) {
    return truncated;
  }
  if (val > 0) {
    return truncated + 1;
  }
  __builtin_unreachable();
}

template <typename T>
class RepetitionCountTest {
 public:
  static constexpr unsigned kThreshold = 1 + Ceil(-kAlphaLog2 / kH);
  static_assert(kThreshold == 26);

  explicit RepetitionCountTest(T &&sub_sampler)
      : sub_sampler_(std::forward<T>(sub_sampler)) {}

  bool Next(uint8_t *out) {
    uint8_t sample;
    if (!sub_sampler_.Next(&sample)) {
      return false;
    }
    if (sample == last_sample_) {
      count_++;
    } else {
      count_ = 1;
      last_sample_ = sample;
    }
    if (count_ >= kThreshold) {
      return false;
    }
    *out = sample;
    return true;
  }

 private:
  T sub_sampler_;
  unsigned count_ = 0;
  uint8_t last_sample_ = 0;
};

template <typename U>
RepetitionCountTest(U &&sub_sampler) -> RepetitionCountTest<std::decay_t<U>>;

constexpr double BinomialPMF(int64_t k, int64_t n, double p) {
  if (k < 0 || k > n) {
    return 0.0;
  }

  double result = 1.0;
  for (int64_t i = 0; i < k; ++i) {
    result *= (n - i);
    result /= (i + 1);
  }

  for (int64_t i = 0; i < k; ++i) {
    result *= p;
  }
  for (int64_t i = 0; i < n - k; ++i) {
    result *= (1 - p);
  }

  return result;
}

// CritBinom implements the Excel function of the same name.
constexpr unsigned CritBinom(unsigned trials, double probability_s,
                             double alpha) {
  if (probability_s < 0.0 || probability_s > 1.0 || alpha < 0.0 ||
      alpha > 1.0) {
    __builtin_unreachable();
  }

  double cumulative = 0.0;
  for (unsigned k = 0; k <= trials; ++k) {
    cumulative += BinomialPMF(k, trials, probability_s);
    if (cumulative >= alpha) {
      return k;
    }
  }

  return trials;
}

// ExpTaylor calculates e^x using the Taylor series: e^x = 1 + x + x²/2! +
// x³/3! + ...
constexpr double ExpTaylor(double x) {
  double sum = 1.0;
  double term = 1.0;

  for (int i = 1; i < 25; ++i) {
    term *= x / i;
    sum += term;
  }

  return sum;
}

// Power2 calculates 2^exp by calculating e^(ln(2) * exp) = e^(ln(2)) ^ exp =
// 2^exp. (std::pow isn't constexpr until C++26.)
constexpr double Power2(double exp) {
  constexpr double ln2 = 0.693147180559945309417232121458;
  return ExpTaylor(exp * ln2);
}

// AdaptiveProportionTestCutoff implements the function from the footnote on
// page 27 of SP 800-90B.
constexpr unsigned AdaptiveProportionTestCutoff(unsigned W, float H,
                                                float alpha) {
  return 1 + CritBinom(W, Power2(-H), 1.0 - alpha);
}

// These are the example values from table 2 of SP 800-90B, to show that
// we're calculating the values correctly.
static_assert(AdaptiveProportionTestCutoff(512, 0.5, kAlpha) == 410);
static_assert(AdaptiveProportionTestCutoff(512, 1, kAlpha) == 311);
static_assert(AdaptiveProportionTestCutoff(512, 2, kAlpha) == 177);
static_assert(AdaptiveProportionTestCutoff(512, 4, kAlpha) == 62);
static_assert(AdaptiveProportionTestCutoff(512, 8, kAlpha) == 13);

template <typename T>
class AdaptiveProportionTest {
 public:
  // The size of the sliding window, representing the number of recent samples
  // to analyze.
  static constexpr unsigned kWindowSize = 512;

  // The maximum number of times any single byte value is allowed to appear
  // within the sliding window.
  static constexpr unsigned kThreshold =
      AdaptiveProportionTestCutoff(kWindowSize, kH, kAlpha);
  static_assert(kThreshold == 348);

  explicit AdaptiveProportionTest(T &&sub_sampler)
      : sub_sampler_(std::forward<T>(sub_sampler)) {
    counts_.fill(0);
  }

  bool Next(uint8_t *out) {
    uint8_t sample;
    if (!sub_sampler_.Next(&sample)) {
      return false;
    }
    *out = sample;

    if (samples_processed_ >= kWindowSize) {
      const uint8_t evicted_sample = buffer_[buffer_idx_];
      counts_[evicted_sample]--;
    }

    buffer_[buffer_idx_] = sample;
    const uint16_t new_count = ++counts_[sample];

    if (new_count > kThreshold) {
      return false;
    }

    buffer_idx_ = (buffer_idx_ + 1) % kWindowSize;
    samples_processed_++;

    return true;
  }

 private:
  T sub_sampler_;

  // A circular buffer to store the most recent `kWindowSize` samples.
  std::array<uint8_t, kWindowSize> buffer_{};

  // An array to store the frequency counts of each possible byte value (0-255)
  // within the current window.
  std::array<uint16_t, 256> counts_{};

  // The current index for writing into the circular buffer.
  size_t buffer_idx_ = 0;

  // The total number of samples processed. Used to determine when the buffer
  // is full and eviction should begin.
  size_t samples_processed_ = 0;
};

template <typename U>
AdaptiveProportionTest(U &&sub_sampler)
    -> AdaptiveProportionTest<std::decay_t<U>>;

template <typename T>
class SeedSampler {
 public:
  // NIST requires 1024 samples at start-up time. This code is structured so
  // that the entropy generator is considered to be starting afresh for each
  // seed.
  static constexpr unsigned kNumSamples = 1024;

  explicit SeedSampler(T &&sub_sampler)
      : sub_sampler_(std::forward<T>(sub_sampler)) {}

  bool Next(uint8_t out_seed[48]) {
    // HMAC-SHA384 `kNumSamples` samples with an all-zero key:
    SHA512_CTX ctx;
    SHA384_Init(&ctx);

    uint8_t block[kSHA384Block];
    memset(block, 0x36, sizeof(block));
    SHA384_Update(&ctx, block, sizeof(block));

    static_assert(kNumSamples % sizeof(block) == 0);
    for (unsigned i = 0; i < kNumSamples / sizeof(block); i++) {
      for (unsigned j = 0; j < sizeof(block); j++) {
        if (!sub_sampler_.Next(&block[j])) {
          return false;
        }
      }
      SHA384_Update(&ctx, block, sizeof(block));
    }

    SHA384_Final(out_seed, &ctx);

    SHA384_Init(&ctx);
    memset(block, 0x5c, sizeof(block));
    SHA384_Update(&ctx, block, sizeof(block));
    SHA384_Update(&ctx, out_seed, kSHA384DigestLength);
    SHA384_Final(out_seed, &ctx);

    return true;
  }

 private:
  T sub_sampler_;
};

template <typename U>
SeedSampler(U &&sub_sampler) -> SeedSampler<std::decay_t<U>>;

constexpr size_t kMemorySize = 1u << 25;
constexpr size_t kMemoryAccessesPerSample = 16;
constexpr size_t kBitsPerSample = 8;
constexpr uint8_t kMask = (1u << kBitsPerSample) - 1;

}  // namespace

int GetVersion() { return 20250725; }

bool GetSeed(uint8_t out[48]) {
  auto sampler(SeedSampler(AdaptiveProportionTest(RepetitionCountTest(
      MaskSampler(kMask, DeltaSampler(MemoryAccessSampler(
                             kMemorySize, kMemoryAccessesPerSample)))))));
  return sampler.Next(out);
}

bool GetSamples(uint64_t *out, size_t n) {
  auto sampler(
      DeltaSampler(MemoryAccessSampler(kMemorySize, kMemoryAccessesPerSample)));
  for (size_t i = 0; i < n; i++) {
    if (!sampler.Next(&out[i])) {
      return false;
    }
  }
  return true;
}

}  // namespace entropy
BSSL_NAMESPACE_END

#endif  // LINUX || MACOS
