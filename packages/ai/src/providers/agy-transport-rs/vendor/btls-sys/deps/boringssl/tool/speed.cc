// Copyright 2014 The BoringSSL Authors
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

#include <algorithm>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <assert.h>
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/aead.h>
#include <openssl/aes.h>
#include <openssl/base64.h>
#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/crypto.h>
#include <openssl/curve25519.h>
#include <openssl/digest.h>
#include <openssl/ec.h>
#include <openssl/ec_key.h>
#include <openssl/ecdsa.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hrss.h>
#include <openssl/mem.h>
#include <openssl/mldsa.h>
#include <openssl/mlkem.h>
#include <openssl/nid.h>
#include <openssl/rand.h>
#include <openssl/rsa.h>
#include <openssl/siphash.h>
#include <openssl/slhdsa.h>
#include <openssl/trust_token.h>
#include <openssl/x509.h>

#if defined(OPENSSL_WINDOWS)
#include <windows.h>
#elif defined(OPENSSL_APPLE)
#include <sys/time.h>
#else
#include <time.h>
#endif

#if defined(OPENSSL_THREADS)
#include <condition_variable>
#include <mutex>
#include <thread>
#endif

#include "../crypto/ec/internal.h"
#include "../crypto/fipsmodule/ec/internal.h"
#include "../crypto/internal.h"
#include "../crypto/trust_token/internal.h"
#include "internal.h"

// g_print_json is true if printed output is JSON formatted.
static bool g_print_json = false;

// TimeResults represents the results of benchmarking a function.
struct TimeResults {
  // num_calls is the number of function calls done in the time period.
  uint64_t num_calls;
  // us is the number of microseconds that elapsed in the time period.
  uint64_t us;

  void Print(const std::string &description) const {
    if (g_print_json) {
      PrintJSON(description);
    } else {
      printf(
          "Did %" PRIu64 " %s operations in %" PRIu64 "us (%.1f ops/sec)\n",
          num_calls, description.c_str(), us,
          (static_cast<double>(num_calls) / static_cast<double>(us)) * 1000000);
    }
  }

  void PrintWithBytes(const std::string &description,
                      size_t bytes_per_call) const {
    if (g_print_json) {
      PrintJSON(description, bytes_per_call);
    } else {
      printf(
          "Did %" PRIu64 " %s operations in %" PRIu64
          "us (%.1f ops/sec): %.1f MB/s\n",
          num_calls, description.c_str(), us,
          (static_cast<double>(num_calls) / static_cast<double>(us)) * 1000000,
          static_cast<double>(bytes_per_call * num_calls) /
              static_cast<double>(us));
    }
  }

 private:
  void PrintJSON(const std::string &description,
                 size_t bytes_per_call = 0) const {
    if (first_json_printed) {
      puts(",");
    }

    printf("{\"description\": \"%s\", \"numCalls\": %" PRIu64
           ", \"microseconds\": %" PRIu64,
           description.c_str(), num_calls, us);

    if (bytes_per_call > 0) {
      printf(", \"bytesPerCall\": %zu", bytes_per_call);
    }

    printf("}");
    first_json_printed = true;
  }

  // first_json_printed is true if |g_print_json| is true and the first item in
  // the JSON results has been printed already. This is used to handle the
  // commas between each item in the result list.
  static bool first_json_printed;
};

bool TimeResults::first_json_printed = false;

#if defined(OPENSSL_WINDOWS)
static uint64_t time_now() { return GetTickCount64() * 1000; }
#elif defined(OPENSSL_APPLE)
static uint64_t time_now() {
  struct timeval tv;
  uint64_t ret;

  gettimeofday(&tv, NULL);
  ret = tv.tv_sec;
  ret *= 1000000;
  ret += tv.tv_usec;
  return ret;
}
#else
static uint64_t time_now() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);

  uint64_t ret = ts.tv_sec;
  ret *= 1000000;
  ret += ts.tv_nsec / 1000;
  return ret;
}
#endif

static uint64_t g_timeout_seconds = 1;
static std::vector<size_t> g_chunk_lengths = {16, 256, 1350, 8192, 16384};

// IterationsBetweenTimeChecks returns the number of iterations of |func| to run
// in between checking the time, or zero on error.
static uint32_t IterationsBetweenTimeChecks(std::function<bool()> func) {
  uint64_t start = time_now();
  if (!func()) {
    return 0;
  }
  uint64_t delta = time_now() - start;
  if (delta == 0) {
    return 250;
  }

  // Aim for about 100ms between time checks.
  uint32_t ret = static_cast<double>(100000) / static_cast<double>(delta);
  if (ret > 1000) {
    ret = 1000;
  } else if (ret < 1) {
    ret = 1;
  }
  return ret;
}

static bool TimeFunctionImpl(TimeResults *results, std::function<bool()> func,
                             uint32_t iterations_between_time_checks) {
  // total_us is the total amount of time that we'll aim to measure a function
  // for.
  const uint64_t total_us = g_timeout_seconds * 1000000;
  uint64_t start = time_now(), now;
  uint64_t done = 0;
  for (;;) {
    for (uint32_t i = 0; i < iterations_between_time_checks; i++) {
      if (!func()) {
        return false;
      }
      done++;
    }

    now = time_now();
    if (now - start > total_us) {
      break;
    }
  }

  results->us = now - start;
  results->num_calls = done;
  return true;
}

static bool TimeFunction(TimeResults *results, std::function<bool()> func) {
  uint32_t iterations_between_time_checks = IterationsBetweenTimeChecks(func);
  if (iterations_between_time_checks == 0) {
    return false;
  }

  return TimeFunctionImpl(results, std::move(func),
                          iterations_between_time_checks);
}

#if defined(OPENSSL_THREADS)
// g_threads is the number of threads to run in parallel benchmarks.
static int g_threads = 1;

// Latch behaves like C++20 std::latch.
class Latch {
 public:
  explicit Latch(int expected) : expected_(expected) {}
  Latch(const Latch &) = delete;
  Latch &operator=(const Latch &) = delete;

  void ArriveAndWait() {
    std::unique_lock<std::mutex> lock(lock_);
    expected_--;
    if (expected_ > 0) {
      cond_.wait(lock, [&] { return expected_ == 0; });
    } else {
      cond_.notify_all();
    }
  }

 private:
  int expected_;
  std::mutex lock_;
  std::condition_variable cond_;
};

static bool TimeFunctionParallel(TimeResults *results,
                                 std::function<bool()> func) {
  if (g_threads <= 1) {
    return TimeFunction(results, std::move(func));
  }

  uint32_t iterations_between_time_checks = IterationsBetweenTimeChecks(func);
  if (iterations_between_time_checks == 0) {
    return false;
  }

  struct ThreadResult {
    TimeResults time_result;
    bool ok = false;
  };
  std::vector<ThreadResult> thread_results(g_threads);
  Latch latch(g_threads);
  std::vector<std::thread> threads;
  for (int i = 0; i < g_threads; i++) {
    threads.emplace_back([&, i] {
      // Wait for all the threads to be ready before running the benchmark.
      latch.ArriveAndWait();
      thread_results[i].ok = TimeFunctionImpl(
          &thread_results[i].time_result, func, iterations_between_time_checks);
    });
  }

  for (auto &thread : threads) {
    thread.join();
  }

  results->num_calls = 0;
  results->us = 0;
  for (const auto &pair : thread_results) {
    if (!pair.ok) {
      return false;
    }
    results->num_calls += pair.time_result.num_calls;
    results->us += pair.time_result.us;
  }
  return true;
}

#else
static bool TimeFunctionParallel(TimeResults *results,
                                 std::function<bool()> func) {
  return TimeFunction(results, std::move(func));
}
#endif

static bool SpeedRSA(const std::string &selected) {
  if (!selected.empty() && selected.find("RSA") == std::string::npos) {
    return true;
  }

  static const struct {
    const char *name;
    const uint8_t *key;
    const size_t key_len;
  } kRSAKeys[] = {
      {"RSA 2048", kDERRSAPrivate2048, kDERRSAPrivate2048Len},
      {"RSA 3072", kDERRSAPrivate3072, kDERRSAPrivate3072Len},
      {"RSA 4096", kDERRSAPrivate4096, kDERRSAPrivate4096Len},
  };

  for (const auto &key_info : kRSAKeys) {
    const std::string name = key_info.name;

    bssl::UniquePtr<RSA> key(
        RSA_private_key_from_bytes(key_info.key, key_info.key_len));
    if (key == nullptr) {
      fprintf(stderr, "Failed to parse %s key.\n", name.c_str());
      ERR_print_errors_fp(stderr);
      return false;
    }

    static constexpr size_t kMaxSignature = 512;
    if (RSA_size(key.get()) > kMaxSignature) {
      abort();
    }
    const uint8_t fake_sha256_hash[32] = {0};

    TimeResults results;
    if (!TimeFunctionParallel(&results, [&key, &fake_sha256_hash]() -> bool {
          // Usually during RSA signing we're using a long-lived |RSA| that
          // has already had all of its |BN_MONT_CTX|s constructed, so it
          // makes sense to use |key| directly here.
          uint8_t out[kMaxSignature];
          unsigned out_len;
          return RSA_sign(NID_sha256, fake_sha256_hash,
                          sizeof(fake_sha256_hash), out, &out_len, key.get());
        })) {
      fprintf(stderr, "RSA_sign failed.\n");
      ERR_print_errors_fp(stderr);
      return false;
    }
    results.Print(name + " signing");

    uint8_t sig[kMaxSignature];
    unsigned sig_len;
    if (!RSA_sign(NID_sha256, fake_sha256_hash, sizeof(fake_sha256_hash), sig,
                  &sig_len, key.get())) {
      return false;
    }
    if (!TimeFunctionParallel(
            &results, [&key, &fake_sha256_hash, &sig, sig_len]() -> bool {
              return RSA_verify(NID_sha256, fake_sha256_hash,
                                sizeof(fake_sha256_hash), sig, sig_len,
                                key.get());
            })) {
      fprintf(stderr, "RSA_verify failed.\n");
      ERR_print_errors_fp(stderr);
      return false;
    }
    results.Print(name + " verify (same key)");

    if (!TimeFunctionParallel(
            &results, [&key, &fake_sha256_hash, &sig, sig_len]() -> bool {
              // Usually during RSA verification we have to parse an RSA key
              // from a certificate or similar, in which case we'd need to
              // construct a new RSA key, with a new |BN_MONT_CTX| for the
              // public modulus. If we were to use |key| directly instead, then
              // these costs wouldn't be accounted for.
              bssl::UniquePtr<RSA> verify_key(RSA_new_public_key(
                  RSA_get0_n(key.get()), RSA_get0_e(key.get())));
              if (!verify_key) {
                return false;
              }
              return RSA_verify(NID_sha256, fake_sha256_hash,
                                sizeof(fake_sha256_hash), sig, sig_len,
                                verify_key.get());
            })) {
      fprintf(stderr, "RSA_verify failed.\n");
      ERR_print_errors_fp(stderr);
      return false;
    }
    results.Print(name + " verify (fresh key)");

    if (!TimeFunctionParallel(&results, [&]() -> bool {
          return bssl::UniquePtr<RSA>(RSA_private_key_from_bytes(
                     key_info.key, key_info.key_len)) != nullptr;
        })) {
      fprintf(stderr, "Failed to parse %s key.\n", name.c_str());
      ERR_print_errors_fp(stderr);
      return false;
    }
    results.Print(name + " private key parse");
  }

  return true;
}

static bool SpeedRSAKeyGen(const std::string &selected) {
  // Don't run this by default because it's so slow.
  if (selected != "RSAKeyGen") {
    return true;
  }

  bssl::UniquePtr<BIGNUM> e(BN_new());
  if (!BN_set_word(e.get(), 65537)) {
    return false;
  }

  const std::vector<int> kSizes = {2048, 3072, 4096};
  for (int size : kSizes) {
    const uint64_t start = time_now();
    uint64_t num_calls = 0;
    uint64_t us;
    std::vector<uint64_t> durations;

    for (;;) {
      bssl::UniquePtr<RSA> rsa(RSA_new());

      const uint64_t iteration_start = time_now();
      if (!RSA_generate_key_ex(rsa.get(), size, e.get(), nullptr)) {
        fprintf(stderr, "RSA_generate_key_ex failed.\n");
        ERR_print_errors_fp(stderr);
        return false;
      }
      const uint64_t iteration_end = time_now();

      num_calls++;
      durations.push_back(iteration_end - iteration_start);

      us = iteration_end - start;
      if (us > 30 * 1000000 /* 30 secs */) {
        break;
      }
    }

    std::sort(durations.begin(), durations.end());
    const std::string description =
        std::string("RSA ") + std::to_string(size) + std::string(" key-gen");
    const TimeResults results = {num_calls, us};
    results.Print(description);
    const size_t n = durations.size();
    assert(n > 0);

    // Distribution information is useful, but doesn't fit into the standard
    // format used by |g_print_json|.
    if (!g_print_json) {
      uint64_t min = durations[0];
      uint64_t median = n & 1 ? durations[n / 2]
                              : (durations[n / 2 - 1] + durations[n / 2]) / 2;
      uint64_t max = durations[n - 1];
      printf("  min: %" PRIu64 "us, median: %" PRIu64 "us, max: %" PRIu64
             "us\n",
             min, median, max);
    }
  }

  return true;
}

static std::string ChunkLenSuffix(size_t chunk_len) {
  char buf[32];
  snprintf(buf, sizeof(buf), " (%zu byte%s)", chunk_len,
           chunk_len != 1 ? "s" : "");
  return buf;
}

static bool SpeedAEADChunk(const EVP_AEAD *aead, std::string name,
                           size_t chunk_len, size_t ad_len,
                           evp_aead_direction_t direction) {
  static const unsigned kAlignment = 16;

  name += ChunkLenSuffix(chunk_len);
  bssl::ScopedEVP_AEAD_CTX ctx;
  const size_t key_len = EVP_AEAD_key_length(aead);
  const size_t nonce_len = EVP_AEAD_nonce_length(aead);
  const size_t overhead_len = EVP_AEAD_max_overhead(aead);

  auto key = std::make_unique<uint8_t[]>(key_len);
  OPENSSL_memset(key.get(), 0, key_len);
  auto nonce = std::make_unique<uint8_t[]>(nonce_len);
  OPENSSL_memset(nonce.get(), 0, nonce_len);
  auto in_storage = std::make_unique<uint8_t[]>(chunk_len + kAlignment);
  // N.B. for EVP_AEAD_CTX_seal_scatter the input and output buffers may be the
  // same size. However, in the direction == evp_aead_open case we still use
  // non-scattering seal, hence we add overhead_len to the size of this buffer.
  auto out_storage =
      std::make_unique<uint8_t[]>(chunk_len + overhead_len + kAlignment);
  auto in2_storage =
      std::make_unique<uint8_t[]>(chunk_len + overhead_len + kAlignment);
  auto ad = std::make_unique<uint8_t[]>(ad_len);
  OPENSSL_memset(ad.get(), 0, ad_len);
  auto tag_storage = std::make_unique<uint8_t[]>(overhead_len + kAlignment);

  uint8_t *const in =
      static_cast<uint8_t *>(align_pointer(in_storage.get(), kAlignment));
  OPENSSL_memset(in, 0, chunk_len);
  uint8_t *const out =
      static_cast<uint8_t *>(align_pointer(out_storage.get(), kAlignment));
  OPENSSL_memset(out, 0, chunk_len + overhead_len);
  uint8_t *const tag =
      static_cast<uint8_t *>(align_pointer(tag_storage.get(), kAlignment));
  OPENSSL_memset(tag, 0, overhead_len);
  uint8_t *const in2 =
      static_cast<uint8_t *>(align_pointer(in2_storage.get(), kAlignment));

  if (!EVP_AEAD_CTX_init_with_direction(ctx.get(), aead, key.get(), key_len,
                                        EVP_AEAD_DEFAULT_TAG_LENGTH,
                                        evp_aead_seal)) {
    fprintf(stderr, "Failed to create EVP_AEAD_CTX.\n");
    ERR_print_errors_fp(stderr);
    return false;
  }

  // TODO(davidben): In most cases, this can be |TimeFunctionParallel|, but a
  // few stateful AEADs must be run serially.
  TimeResults results;
  if (direction == evp_aead_seal) {
    if (!TimeFunction(&results,
                      [chunk_len, nonce_len, ad_len, overhead_len, in, out, tag,
                       &ctx, &nonce, &ad]() -> bool {
                        size_t tag_len;
                        return EVP_AEAD_CTX_seal_scatter(
                            ctx.get(), out, tag, &tag_len, overhead_len,
                            nonce.get(), nonce_len, in, chunk_len, nullptr, 0,
                            ad.get(), ad_len);
                      })) {
      fprintf(stderr, "EVP_AEAD_CTX_seal failed.\n");
      ERR_print_errors_fp(stderr);
      return false;
    }
  } else {
    size_t out_len;
    EVP_AEAD_CTX_seal(ctx.get(), out, &out_len, chunk_len + overhead_len,
                      nonce.get(), nonce_len, in, chunk_len, ad.get(), ad_len);

    ctx.Reset();
    if (!EVP_AEAD_CTX_init_with_direction(ctx.get(), aead, key.get(), key_len,
                                          EVP_AEAD_DEFAULT_TAG_LENGTH,
                                          evp_aead_open)) {
      fprintf(stderr, "Failed to create EVP_AEAD_CTX.\n");
      ERR_print_errors_fp(stderr);
      return false;
    }

    if (!TimeFunction(&results,
                      [chunk_len, overhead_len, nonce_len, ad_len, in2, out,
                       out_len, &ctx, &nonce, &ad]() -> bool {
                        size_t in2_len;
                        // N.B. EVP_AEAD_CTX_open_gather is not implemented for
                        // all AEADs.
                        return EVP_AEAD_CTX_open(ctx.get(), in2, &in2_len,
                                                 chunk_len + overhead_len,
                                                 nonce.get(), nonce_len, out,
                                                 out_len, ad.get(), ad_len);
                      })) {
      fprintf(stderr, "EVP_AEAD_CTX_open failed.\n");
      ERR_print_errors_fp(stderr);
      return false;
    }
  }

  results.PrintWithBytes(
      name + (direction == evp_aead_seal ? " seal" : " open"), chunk_len);
  return true;
}

static bool SpeedAEAD(const EVP_AEAD *aead, const std::string &name,
                      size_t ad_len, const std::string &selected) {
  if (!selected.empty() && name.find(selected) == std::string::npos) {
    return true;
  }

  for (size_t chunk_len : g_chunk_lengths) {
    if (!SpeedAEADChunk(aead, name, chunk_len, ad_len, evp_aead_seal)) {
      return false;
    }
  }
  return true;
}

static bool SpeedAEADOpen(const EVP_AEAD *aead, const std::string &name,
                          size_t ad_len, const std::string &selected) {
  if (!selected.empty() && name.find(selected) == std::string::npos) {
    return true;
  }

  for (size_t chunk_len : g_chunk_lengths) {
    if (!SpeedAEADChunk(aead, name, chunk_len, ad_len, evp_aead_open)) {
      return false;
    }
  }

  return true;
}

static bool SpeedAESBlock(const std::string &name, unsigned bits,
                          const std::string &selected) {
  if (!selected.empty() && name.find(selected) == std::string::npos) {
    return true;
  }

  static const uint8_t kZero[32] = {0};

  {
    TimeResults results;
    if (!TimeFunctionParallel(&results, [&]() -> bool {
          AES_KEY key;
          return AES_set_encrypt_key(kZero, bits, &key) == 0;
        })) {
      fprintf(stderr, "AES_set_encrypt_key failed.\n");
      return false;
    }
    results.Print(name + " encrypt setup");
  }

  {
    AES_KEY key;
    if (AES_set_encrypt_key(kZero, bits, &key) != 0) {
      return false;
    }
    uint8_t block[16] = {0};
    TimeResults results;
    if (!TimeFunctionParallel(&results, [&]() -> bool {
          AES_encrypt(block, block, &key);
          return true;
        })) {
      fprintf(stderr, "AES_encrypt failed.\n");
      return false;
    }
    results.Print(name + " encrypt");
  }

  {
    TimeResults results;
    if (!TimeFunctionParallel(&results, [&]() -> bool {
          AES_KEY key;
          return AES_set_decrypt_key(kZero, bits, &key) == 0;
        })) {
      fprintf(stderr, "AES_set_decrypt_key failed.\n");
      return false;
    }
    results.Print(name + " decrypt setup");
  }

  {
    AES_KEY key;
    if (AES_set_decrypt_key(kZero, bits, &key) != 0) {
      return false;
    }
    uint8_t block[16] = {0};
    TimeResults results;
    if (!TimeFunctionParallel(&results, [&]() -> bool {
          AES_decrypt(block, block, &key);
          return true;
        })) {
      fprintf(stderr, "AES_decrypt failed.\n");
      return false;
    }
    results.Print(name + " decrypt");
  }

  return true;
}

static bool SpeedHashChunk(const EVP_MD *md, std::string name,
                           size_t chunk_len) {
  uint8_t input[16384] = {0};

  if (chunk_len > sizeof(input)) {
    return false;
  }

  name += ChunkLenSuffix(chunk_len);
  TimeResults results;
  if (!TimeFunctionParallel(&results, [md, chunk_len, &input]() -> bool {
        uint8_t digest[EVP_MAX_MD_SIZE];
        unsigned int md_len;

        bssl::ScopedEVP_MD_CTX ctx;
        return EVP_DigestInit_ex(ctx.get(), md, NULL /* ENGINE */) &&
               EVP_DigestUpdate(ctx.get(), input, chunk_len) &&
               EVP_DigestFinal_ex(ctx.get(), digest, &md_len);
      })) {
    fprintf(stderr, "EVP_DigestInit_ex failed.\n");
    ERR_print_errors_fp(stderr);
    return false;
  }

  results.PrintWithBytes(name, chunk_len);
  return true;
}

static bool SpeedHash(const EVP_MD *md, const std::string &name,
                      const std::string &selected) {
  if (!selected.empty() && name.find(selected) == std::string::npos) {
    return true;
  }

  for (size_t chunk_len : g_chunk_lengths) {
    if (!SpeedHashChunk(md, name, chunk_len)) {
      return false;
    }
  }

  return true;
}

static bool SpeedRandomChunk(std::string name, size_t chunk_len) {
  static constexpr size_t kMaxChunk = 16384;
  if (chunk_len > kMaxChunk) {
    return false;
  }

  name += ChunkLenSuffix(chunk_len);
  TimeResults results;
  if (!TimeFunctionParallel(&results, [chunk_len]() -> bool {
        uint8_t scratch[kMaxChunk];
        RAND_bytes(scratch, chunk_len);
        return true;
      })) {
    return false;
  }

  results.PrintWithBytes(name, chunk_len);
  return true;
}

static bool SpeedRandom(const std::string &selected) {
  if (!selected.empty() && selected != "RNG") {
    return true;
  }

  for (size_t chunk_len : g_chunk_lengths) {
    if (!SpeedRandomChunk("RNG", chunk_len)) {
      return false;
    }
  }

  return true;
}

static bool SpeedECDHCurve(const std::string &name, const EC_GROUP *group,
                           const std::string &selected) {
  if (!selected.empty() && name.find(selected) == std::string::npos) {
    return true;
  }

  bssl::UniquePtr<EC_KEY> peer_key(EC_KEY_new());
  if (!peer_key || !EC_KEY_set_group(peer_key.get(), group) ||
      !EC_KEY_generate_key(peer_key.get())) {
    return false;
  }

  size_t peer_value_len = EC_POINT_point2oct(
      EC_KEY_get0_group(peer_key.get()), EC_KEY_get0_public_key(peer_key.get()),
      POINT_CONVERSION_UNCOMPRESSED, nullptr, 0, nullptr);
  if (peer_value_len == 0) {
    return false;
  }
  auto peer_value = std::make_unique<uint8_t[]>(peer_value_len);
  peer_value_len = EC_POINT_point2oct(
      EC_KEY_get0_group(peer_key.get()), EC_KEY_get0_public_key(peer_key.get()),
      POINT_CONVERSION_UNCOMPRESSED, peer_value.get(), peer_value_len, nullptr);
  if (peer_value_len == 0) {
    return false;
  }

  TimeResults results;
  if (!TimeFunctionParallel(
          &results, [group, peer_value_len, &peer_value]() -> bool {
            bssl::UniquePtr<EC_KEY> key(EC_KEY_new());
            if (!key || !EC_KEY_set_group(key.get(), group) ||
                !EC_KEY_generate_key(key.get())) {
              return false;
            }
            bssl::UniquePtr<EC_POINT> point(EC_POINT_new(group));
            bssl::UniquePtr<EC_POINT> peer_point(EC_POINT_new(group));
            bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());
            bssl::UniquePtr<BIGNUM> x(BN_new());
            if (!point || !peer_point || !ctx || !x ||
                !EC_POINT_oct2point(group, peer_point.get(), peer_value.get(),
                                    peer_value_len, ctx.get()) ||
                !EC_POINT_mul(group, point.get(), nullptr, peer_point.get(),
                              EC_KEY_get0_private_key(key.get()), ctx.get()) ||
                !EC_POINT_get_affine_coordinates_GFp(
                    group, point.get(), x.get(), nullptr, ctx.get())) {
              return false;
            }

            return true;
          })) {
    return false;
  }

  results.Print(name);
  return true;
}

static bool SpeedECDSACurve(const std::string &name, const EC_GROUP *group,
                            const std::string &selected) {
  if (!selected.empty() && name.find(selected) == std::string::npos) {
    return true;
  }

  bssl::UniquePtr<EC_KEY> key(EC_KEY_new());
  if (!key || !EC_KEY_set_group(key.get(), group) ||
      !EC_KEY_generate_key(key.get())) {
    return false;
  }

  static constexpr size_t kMaxSignature = 256;
  if (ECDSA_size(key.get()) > kMaxSignature) {
    abort();
  }
  uint8_t digest[20];
  OPENSSL_memset(digest, 42, sizeof(digest));

  TimeResults results;
  if (!TimeFunctionParallel(&results, [&key, &digest]() -> bool {
        uint8_t out[kMaxSignature];
        unsigned out_len;
        return ECDSA_sign(0, digest, sizeof(digest), out, &out_len,
                          key.get()) == 1;
      })) {
    return false;
  }

  results.Print(name + " signing");

  uint8_t signature[kMaxSignature];
  unsigned sig_len;
  if (!ECDSA_sign(0, digest, sizeof(digest), signature, &sig_len, key.get())) {
    return false;
  }

  if (!TimeFunctionParallel(
          &results, [&key, &signature, &digest, sig_len]() -> bool {
            return ECDSA_verify(0, digest, sizeof(digest), signature, sig_len,
                                key.get()) == 1;
          })) {
    return false;
  }

  results.Print(name + " verify");

  return true;
}

static bool SpeedECDH(const std::string &selected) {
  return SpeedECDHCurve("ECDH P-224", EC_group_p224(), selected) &&
         SpeedECDHCurve("ECDH P-256", EC_group_p256(), selected) &&
         SpeedECDHCurve("ECDH P-384", EC_group_p384(), selected) &&
         SpeedECDHCurve("ECDH P-521", EC_group_p521(), selected);
}

static bool SpeedECDSA(const std::string &selected) {
  return SpeedECDSACurve("ECDSA P-224", EC_group_p224(), selected) &&
         SpeedECDSACurve("ECDSA P-256", EC_group_p256(), selected) &&
         SpeedECDSACurve("ECDSA P-384", EC_group_p384(), selected) &&
         SpeedECDSACurve("ECDSA P-521", EC_group_p521(), selected);
}

static bool Speed25519(const std::string &selected) {
  if (!selected.empty() && selected.find("25519") == std::string::npos) {
    return true;
  }

  TimeResults results;
  if (!TimeFunctionParallel(&results, []() -> bool {
        uint8_t public_key[32], private_key[64];
        ED25519_keypair(public_key, private_key);
        return true;
      })) {
    return false;
  }

  results.Print("Ed25519 key generation");

  uint8_t public_key[32], private_key[64];
  ED25519_keypair(public_key, private_key);
  static const uint8_t kMessage[] = {0, 1, 2, 3, 4, 5};

  if (!TimeFunctionParallel(&results, [&private_key]() -> bool {
        uint8_t out[64];
        return ED25519_sign(out, kMessage, sizeof(kMessage), private_key) == 1;
      })) {
    return false;
  }

  results.Print("Ed25519 signing");

  uint8_t signature[64];
  if (!ED25519_sign(signature, kMessage, sizeof(kMessage), private_key)) {
    return false;
  }

  if (!TimeFunctionParallel(&results, [&public_key, &signature]() -> bool {
        return ED25519_verify(kMessage, sizeof(kMessage), signature,
                              public_key) == 1;
      })) {
    fprintf(stderr, "Ed25519 verify failed.\n");
    return false;
  }

  results.Print("Ed25519 verify");

  if (!TimeFunctionParallel(&results, []() -> bool {
        uint8_t out[32], in[32];
        OPENSSL_memset(in, 0, sizeof(in));
        X25519_public_from_private(out, in);
        return true;
      })) {
    fprintf(stderr, "Curve25519 base-point multiplication failed.\n");
    return false;
  }

  results.Print("Curve25519 base-point multiplication");

  if (!TimeFunctionParallel(&results, []() -> bool {
        uint8_t out[32], in1[32], in2[32];
        OPENSSL_memset(in1, 0, sizeof(in1));
        OPENSSL_memset(in2, 0, sizeof(in2));
        in1[0] = 1;
        in2[0] = 9;
        return X25519(out, in1, in2) == 1;
      })) {
    fprintf(stderr, "Curve25519 arbitrary point multiplication failed.\n");
    return false;
  }

  results.Print("Curve25519 arbitrary point multiplication");

  return true;
}

static bool SpeedSPAKE2(const std::string &selected) {
  if (!selected.empty() && selected.find("SPAKE2") == std::string::npos) {
    return true;
  }

  TimeResults results;

  static const uint8_t kAliceName[] = {'A'};
  static const uint8_t kBobName[] = {'B'};
  static const uint8_t kPassword[] = "password";
  bssl::UniquePtr<SPAKE2_CTX> alice(
      SPAKE2_CTX_new(spake2_role_alice, kAliceName, sizeof(kAliceName),
                     kBobName, sizeof(kBobName)));
  uint8_t alice_msg[SPAKE2_MAX_MSG_SIZE];
  size_t alice_msg_len;

  if (!SPAKE2_generate_msg(alice.get(), alice_msg, &alice_msg_len,
                           sizeof(alice_msg), kPassword, sizeof(kPassword))) {
    fprintf(stderr, "SPAKE2_generate_msg failed.\n");
    return false;
  }

  if (!TimeFunctionParallel(&results, [&alice_msg, alice_msg_len]() -> bool {
        bssl::UniquePtr<SPAKE2_CTX> bob(
            SPAKE2_CTX_new(spake2_role_bob, kBobName, sizeof(kBobName),
                           kAliceName, sizeof(kAliceName)));
        uint8_t bob_msg[SPAKE2_MAX_MSG_SIZE], bob_key[64];
        size_t bob_msg_len, bob_key_len;
        if (!SPAKE2_generate_msg(bob.get(), bob_msg, &bob_msg_len,
                                 sizeof(bob_msg), kPassword,
                                 sizeof(kPassword)) ||
            !SPAKE2_process_msg(bob.get(), bob_key, &bob_key_len,
                                sizeof(bob_key), alice_msg, alice_msg_len)) {
          return false;
        }

        return true;
      })) {
    fprintf(stderr, "SPAKE2 failed.\n");
  }

  results.Print("SPAKE2 over Ed25519");

  return true;
}

static bool SpeedScrypt(const std::string &selected) {
  if (!selected.empty() && selected.find("scrypt") == std::string::npos) {
    return true;
  }

  TimeResults results;

  static const char kPassword[] = "password";
  static const uint8_t kSalt[] = "NaCl";

  if (!TimeFunctionParallel(&results, [&]() -> bool {
        uint8_t out[64];
        return !!EVP_PBE_scrypt(kPassword, sizeof(kPassword) - 1, kSalt,
                                sizeof(kSalt) - 1, 1024, 8, 16, 0 /* max_mem */,
                                out, sizeof(out));
      })) {
    fprintf(stderr, "scrypt failed.\n");
    return false;
  }
  results.Print("scrypt (N = 1024, r = 8, p = 16)");

  if (!TimeFunctionParallel(&results, [&]() -> bool {
        uint8_t out[64];
        return !!EVP_PBE_scrypt(kPassword, sizeof(kPassword) - 1, kSalt,
                                sizeof(kSalt) - 1, 16384, 8, 1, 0 /* max_mem */,
                                out, sizeof(out));
      })) {
    fprintf(stderr, "scrypt failed.\n");
    return false;
  }
  results.Print("scrypt (N = 16384, r = 8, p = 1)");

  return true;
}

static bool SpeedHRSS(const std::string &selected) {
  if (!selected.empty() && selected != "HRSS") {
    return true;
  }

  TimeResults results;

  if (!TimeFunctionParallel(&results, []() -> bool {
        struct HRSS_public_key pub;
        struct HRSS_private_key priv;
        uint8_t entropy[HRSS_GENERATE_KEY_BYTES];
        RAND_bytes(entropy, sizeof(entropy));
        return HRSS_generate_key(&pub, &priv, entropy);
      })) {
    fprintf(stderr, "Failed to time HRSS_generate_key.\n");
    return false;
  }

  results.Print("HRSS generate");

  struct HRSS_public_key pub;
  struct HRSS_private_key priv;
  uint8_t key_entropy[HRSS_GENERATE_KEY_BYTES];
  RAND_bytes(key_entropy, sizeof(key_entropy));
  if (!HRSS_generate_key(&pub, &priv, key_entropy)) {
    return false;
  }

  if (!TimeFunctionParallel(&results, [&pub]() -> bool {
        uint8_t entropy[HRSS_ENCAP_BYTES];
        uint8_t shared_key[HRSS_KEY_BYTES];
        uint8_t ciphertext[HRSS_CIPHERTEXT_BYTES];
        RAND_bytes(entropy, sizeof(entropy));
        return HRSS_encap(ciphertext, shared_key, &pub, entropy);
      })) {
    fprintf(stderr, "Failed to time HRSS_encap.\n");
    return false;
  }
  results.Print("HRSS encap");

  uint8_t entropy[HRSS_ENCAP_BYTES];
  uint8_t shared_key[HRSS_KEY_BYTES];
  uint8_t ciphertext[HRSS_CIPHERTEXT_BYTES];
  RAND_bytes(entropy, sizeof(entropy));
  if (!HRSS_encap(ciphertext, shared_key, &pub, entropy)) {
    return false;
  }

  if (!TimeFunctionParallel(&results, [&priv, &ciphertext]() -> bool {
        uint8_t shared_key2[HRSS_KEY_BYTES];
        return HRSS_decap(shared_key2, &priv, ciphertext, sizeof(ciphertext));
      })) {
    fprintf(stderr, "Failed to time HRSS_encap.\n");
    return false;
  }

  results.Print("HRSS decap");

  return true;
}

static bool SpeedMLDSA(const std::string &selected) {
  if (!selected.empty() && selected != "ML-DSA") {
    return true;
  }

  TimeResults results;

  auto encoded_public_key =
      std::make_unique<uint8_t[]>(MLDSA65_PUBLIC_KEY_BYTES);
  auto priv = std::make_unique<MLDSA65_private_key>();
  if (!TimeFunctionParallel(&results, [&]() -> bool {
        uint8_t seed[MLDSA_SEED_BYTES];
        if (!MLDSA65_generate_key(encoded_public_key.get(), seed, priv.get())) {
          fprintf(stderr, "Failure in MLDSA65_generate_key.\n");
          return false;
        }
        return true;
      })) {
    fprintf(stderr, "Failed to time MLDSA65_generate_key.\n");
    return false;
  }

  results.Print("MLDSA key generation");

  const char *message = "Hello world";
  size_t message_len = strlen(message);
  auto out_encoded_signature =
      std::make_unique<uint8_t[]>(MLDSA65_SIGNATURE_BYTES);
  if (!TimeFunctionParallel(&results, [&]() -> bool {
        if (!MLDSA65_sign(out_encoded_signature.get(), priv.get(),
                          (const uint8_t *)message, message_len, nullptr, 0)) {
          fprintf(stderr, "Failure in MLDSA65_sign.\n");
          return false;
        }
        return true;
      })) {
    fprintf(stderr, "Failed to time MLDSA65_sign.\n");
    return false;
  }

  results.Print("MLDSA sign (randomized)");

  auto pub = std::make_unique<MLDSA65_public_key>();

  if (!TimeFunctionParallel(&results, [&]() -> bool {
        CBS cbs;
        CBS_init(&cbs, encoded_public_key.get(), MLDSA65_PUBLIC_KEY_BYTES);
        if (!MLDSA65_parse_public_key(pub.get(), &cbs)) {
          fprintf(stderr, "Failure in MLDSA65_parse_public_key.\n");
          return false;
        }
        return true;
      })) {
    fprintf(stderr, "Failed to time MLDSA65_parse_public_key.\n");
    return false;
  }

  results.Print("MLDSA parse (valid) public key");

  if (!TimeFunctionParallel(&results, [&]() -> bool {
        if (!MLDSA65_verify(pub.get(), out_encoded_signature.get(),
                            MLDSA65_SIGNATURE_BYTES, (const uint8_t *)message,
                            message_len, nullptr, 0)) {
          fprintf(stderr, "Failed to verify MLDSA signature.\n");
          return false;
        }
        return true;
      })) {
    fprintf(stderr, "Failed to time MLDSA65_verify.\n");
    return false;
  }

  results.Print("MLDSA verify (valid signature)");

  out_encoded_signature[42] ^= 0x42;
  if (!TimeFunctionParallel(&results, [&]() -> bool {
        if (MLDSA65_verify(pub.get(), out_encoded_signature.get(),
                           MLDSA65_SIGNATURE_BYTES, (const uint8_t *)message,
                           message_len, nullptr, 0)) {
          fprintf(stderr, "MLDSA signature unexpectedly verified.\n");
          return false;
        }
        return true;
      })) {
    fprintf(stderr, "Failed to time MLDSA65_verify.\n");
    return false;
  }

  results.Print("MLDSA verify (invalid signature)");

  return true;
}

static bool SpeedMLKEM(const std::string &selected) {
  if (!selected.empty() && selected != "ML-KEM-768") {
    return true;
  }

  TimeResults results;

  uint8_t ciphertext[MLKEM768_CIPHERTEXT_BYTES];
  // This ciphertext is nonsense, but decap is constant-time so, for the
  // purposes of timing, it's fine.
  memset(ciphertext, 42, sizeof(ciphertext));
  if (!TimeFunctionParallel(&results, [&]() -> bool {
        MLKEM768_private_key priv;
        uint8_t encoded_public_key[MLKEM768_PUBLIC_KEY_BYTES];
        MLKEM768_generate_key(encoded_public_key, nullptr, &priv);
        uint8_t shared_secret[MLKEM_SHARED_SECRET_BYTES];
        MLKEM768_decap(shared_secret, ciphertext, sizeof(ciphertext), &priv);
        return true;
      })) {
    fprintf(stderr, "Failed to time MLKEM768_generate_key + MLKEM768_decap.\n");
    return false;
  }

  results.Print("ML-KEM-768 generate + decap");

  MLKEM768_private_key priv;
  uint8_t encoded_public_key[MLKEM768_PUBLIC_KEY_BYTES];
  MLKEM768_generate_key(encoded_public_key, nullptr, &priv);
  MLKEM768_public_key pub;
  if (!TimeFunctionParallel(&results, [&]() -> bool {
        CBS encoded_public_key_cbs;
        CBS_init(&encoded_public_key_cbs, encoded_public_key,
                 sizeof(encoded_public_key));
        if (!MLKEM768_parse_public_key(&pub, &encoded_public_key_cbs)) {
          return false;
        }
        uint8_t shared_secret[MLKEM_SHARED_SECRET_BYTES];
        MLKEM768_encap(ciphertext, shared_secret, &pub);
        return true;
      })) {
    fprintf(stderr, "Failed to time MLKEM768_encap.\n");
    return false;
  }

  results.Print("ML-KEM-768 parse + encap");

  return true;
}

static bool SpeedMLKEM1024(const std::string &selected) {
  if (!selected.empty() && selected != "ML-KEM-1024") {
    return true;
  }

  TimeResults results;

  uint8_t ciphertext[MLKEM1024_CIPHERTEXT_BYTES];
  auto priv = std::make_unique<MLKEM1024_private_key>();
  // This ciphertext is nonsense, but decap is constant-time so, for the
  // purposes of timing, it's fine.
  memset(ciphertext, 42, sizeof(ciphertext));
  if (!TimeFunctionParallel(&results, [&]() -> bool {
        uint8_t encoded_public_key[MLKEM1024_PUBLIC_KEY_BYTES];
        MLKEM1024_generate_key(encoded_public_key, nullptr, priv.get());
        uint8_t shared_secret[MLKEM_SHARED_SECRET_BYTES];
        MLKEM1024_decap(shared_secret, ciphertext, sizeof(ciphertext),
                        priv.get());
        return true;
      })) {
    fprintf(stderr, "Failed to time MLKEM768_generate_key + MLKEM768_decap.\n");
    return false;
  }

  results.Print("ML-KEM-1024 generate + decap");

  uint8_t encoded_public_key[MLKEM1024_PUBLIC_KEY_BYTES];
  MLKEM1024_generate_key(encoded_public_key, nullptr, priv.get());
  MLKEM1024_public_key pub;
  if (!TimeFunctionParallel(&results, [&]() -> bool {
        CBS encoded_public_key_cbs;
        CBS_init(&encoded_public_key_cbs, encoded_public_key,
                 sizeof(encoded_public_key));
        if (!MLKEM1024_parse_public_key(&pub, &encoded_public_key_cbs)) {
          return false;
        }
        uint8_t shared_secret[MLKEM_SHARED_SECRET_BYTES];
        MLKEM1024_encap(ciphertext, shared_secret, &pub);
        return true;
      })) {
    fprintf(stderr, "Failed to time MLKEM768_encap.\n");
    return false;
  }

  results.Print("ML-KEM-1024 parse + encap");

  return true;
}

static bool SpeedSLHDSA(const std::string &selected) {
  if (!selected.empty() && selected.find("SLH-DSA") == std::string::npos) {
    return true;
  }

  TimeResults results;
  if (!TimeFunctionParallel(&results, []() -> bool {
        uint8_t public_key[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES],
            private_key[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES];
        SLHDSA_SHA2_128S_generate_key(public_key, private_key);
        return true;
      })) {
    return false;
  }

  results.Print("SLHDSA-SHA2-128s key generation");

  uint8_t public_key[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES],
      private_key[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES];
  SLHDSA_SHA2_128S_generate_key(public_key, private_key);
  static const uint8_t kMessage[] = {0, 1, 2, 3, 4, 5};

  if (!TimeFunctionParallel(&results, [&private_key]() -> bool {
        uint8_t out[SLHDSA_SHA2_128S_SIGNATURE_BYTES];
        SLHDSA_SHA2_128S_sign(out, private_key, kMessage, sizeof(kMessage),
                              nullptr, 0);
        return true;
      })) {
    return false;
  }

  results.Print("SLHDSA-SHA2-128s signing");

  uint8_t signature[SLHDSA_SHA2_128S_SIGNATURE_BYTES];
  SLHDSA_SHA2_128S_sign(signature, private_key, kMessage, sizeof(kMessage),
                        nullptr, 0);

  if (!TimeFunctionParallel(&results, [&public_key, &signature]() -> bool {
        return SLHDSA_SHA2_128S_verify(signature, sizeof(signature), public_key,
                                       kMessage, sizeof(kMessage), nullptr,
                                       0) == 1;
      })) {
    fprintf(stderr, "SLHDSA-SHA2-128s verify failed.\n");
    return false;
  }

  results.Print("SLHDSA-SHA2-128s verify");

  return true;
}

static bool SpeedHashToCurve(const std::string &selected) {
  if (!selected.empty() && selected.find("hashtocurve") == std::string::npos) {
    return true;
  }

  uint8_t input[64];
  RAND_bytes(input, sizeof(input));

  static const uint8_t kLabel[] = "label";

  TimeResults results;
  {
    if (!TimeFunctionParallel(&results, [&]() -> bool {
          EC_JACOBIAN out;
          return ec_hash_to_curve_p256_xmd_sha256_sswu(EC_group_p256(), &out,
                                                       kLabel, sizeof(kLabel),
                                                       input, sizeof(input));
        })) {
      fprintf(stderr, "hash-to-curve failed.\n");
      return false;
    }
    results.Print("hash-to-curve P256_XMD:SHA-256_SSWU_RO_");

    if (!TimeFunctionParallel(&results, [&]() -> bool {
          EC_JACOBIAN out;
          return ec_hash_to_curve_p384_xmd_sha384_sswu(EC_group_p384(), &out,
                                                       kLabel, sizeof(kLabel),
                                                       input, sizeof(input));
        })) {
      fprintf(stderr, "hash-to-curve failed.\n");
      return false;
    }
    results.Print("hash-to-curve P384_XMD:SHA-384_SSWU_RO_");

    if (!TimeFunctionParallel(&results, [&]() -> bool {
          EC_SCALAR out;
          return ec_hash_to_scalar_p384_xmd_sha512_draft07(
              EC_group_p384(), &out, kLabel, sizeof(kLabel), input,
              sizeof(input));
        })) {
      fprintf(stderr, "hash-to-scalar failed.\n");
      return false;
    }
    results.Print("hash-to-scalar P384_XMD:SHA-512");
  }

  return true;
}

static bool SpeedBase64(const std::string &selected) {
  if (!selected.empty() && selected.find("base64") == std::string::npos) {
    return true;
  }

  static const char kInput[] =
      "MIIDtTCCAp2gAwIBAgIJALW2IrlaBKUhMA0GCSqGSIb3DQEBCwUAMEUxCzAJBgNV"
      "BAYTAkFVMRMwEQYDVQQIEwpTb21lLVN0YXRlMSEwHwYDVQQKExhJbnRlcm5ldCBX"
      "aWRnaXRzIFB0eSBMdGQwHhcNMTYwNzA5MDQzODA5WhcNMTYwODA4MDQzODA5WjBF"
      "MQswCQYDVQQGEwJBVTETMBEGA1UECBMKU29tZS1TdGF0ZTEhMB8GA1UEChMYSW50"
      "ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB"
      "CgKCAQEAugvahBkSAUF1fC49vb1bvlPrcl80kop1iLpiuYoz4Qptwy57+EWssZBc"
      "HprZ5BkWf6PeGZ7F5AX1PyJbGHZLqvMCvViP6pd4MFox/igESISEHEixoiXCzepB"
      "rhtp5UQSjHD4D4hKtgdMgVxX+LRtwgW3mnu/vBu7rzpr/DS8io99p3lqZ1Aky+aN"
      "lcMj6MYy8U+YFEevb/V0lRY9oqwmW7BHnXikm/vi6sjIS350U8zb/mRzYeIs2R65"
      "LUduTL50+UMgat9ocewI2dv8aO9Dph+8NdGtg8LFYyTTHcUxJoMr1PTOgnmET19W"
      "JH4PrFwk7ZE1QJQQ1L4iKmPeQistuQIDAQABo4GnMIGkMB0GA1UdDgQWBBT5m6Vv"
      "zYjVYHG30iBE+j2XDhUE8jB1BgNVHSMEbjBsgBT5m6VvzYjVYHG30iBE+j2XDhUE"
      "8qFJpEcwRTELMAkGA1UEBhMCQVUxEzARBgNVBAgTClNvbWUtU3RhdGUxITAfBgNV"
      "BAoTGEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZIIJALW2IrlaBKUhMAwGA1UdEwQF"
      "MAMBAf8wDQYJKoZIhvcNAQELBQADggEBAD7Jg68SArYWlcoHfZAB90Pmyrt5H6D8"
      "LRi+W2Ri1fBNxREELnezWJ2scjl4UMcsKYp4Pi950gVN+62IgrImcCNvtb5I1Cfy"
      "/MNNur9ffas6X334D0hYVIQTePyFk3umI+2mJQrtZZyMPIKSY/sYGQHhGGX6wGK+"
      "GO/og0PQk/Vu6D+GU2XRnDV0YZg1lsAsHd21XryK6fDmNkEMwbIWrts4xc7scRrG"
      "HWy+iMf6/7p/Ak/SIicM4XSwmlQ8pPxAZPr+E2LoVd9pMpWUwpW2UbtO5wsGTrY5"
      "sO45tFNN/y+jtUheB1C2ijObG/tXELaiyCdM+S/waeuv0MXtI4xnn1A=";

  TimeResults results;
  if (!TimeFunctionParallel(&results, [&]() -> bool {
        uint8_t out[sizeof(kInput)];
        size_t len;
        return EVP_DecodeBase64(out, &len, sizeof(out),
                                reinterpret_cast<const uint8_t *>(kInput),
                                strlen(kInput));
      })) {
    fprintf(stderr, "base64 decode failed.\n");
    return false;
  }
  results.PrintWithBytes("base64 decode", strlen(kInput));
  return true;
}

static bool SpeedSipHash(const std::string &selected) {
  if (!selected.empty() && selected.find("siphash") == std::string::npos) {
    return true;
  }

  uint64_t key[2] = {0};
  for (size_t len : g_chunk_lengths) {
    std::vector<uint8_t> input(len);
    TimeResults results;
    if (!TimeFunctionParallel(&results, [&]() -> bool {
          SIPHASH_24(key, input.data(), input.size());
          return true;
        })) {
      fprintf(stderr, "SIPHASH_24 failed.\n");
      ERR_print_errors_fp(stderr);
      return false;
    }
    results.PrintWithBytes("SipHash-2-4" + ChunkLenSuffix(len), len);
  }

  return true;
}

static TRUST_TOKEN_PRETOKEN *trust_token_pretoken_dup(
    const TRUST_TOKEN_PRETOKEN *in) {
  return static_cast<TRUST_TOKEN_PRETOKEN *>(
      OPENSSL_memdup(in, sizeof(TRUST_TOKEN_PRETOKEN)));
}

static bool SpeedTrustToken(std::string name, const TRUST_TOKEN_METHOD *method,
                            size_t batchsize, const std::string &selected) {
  if (!selected.empty() && selected.find("trusttoken") == std::string::npos) {
    return true;
  }

  TimeResults results;
  if (!TimeFunction(&results, [&]() -> bool {
        uint8_t priv_key[TRUST_TOKEN_MAX_PRIVATE_KEY_SIZE];
        uint8_t pub_key[TRUST_TOKEN_MAX_PUBLIC_KEY_SIZE];
        size_t priv_key_len, pub_key_len;
        return TRUST_TOKEN_generate_key(
            method, priv_key, &priv_key_len, TRUST_TOKEN_MAX_PRIVATE_KEY_SIZE,
            pub_key, &pub_key_len, TRUST_TOKEN_MAX_PUBLIC_KEY_SIZE, 0);
      })) {
    fprintf(stderr, "TRUST_TOKEN_generate_key failed.\n");
    return false;
  }
  results.Print(name + " generate_key");

  bssl::UniquePtr<TRUST_TOKEN_CLIENT> client(
      TRUST_TOKEN_CLIENT_new(method, batchsize));
  bssl::UniquePtr<TRUST_TOKEN_ISSUER> issuer(
      TRUST_TOKEN_ISSUER_new(method, batchsize));
  uint8_t priv_key[TRUST_TOKEN_MAX_PRIVATE_KEY_SIZE];
  uint8_t pub_key[TRUST_TOKEN_MAX_PUBLIC_KEY_SIZE];
  size_t priv_key_len, pub_key_len, key_index;
  if (!client || !issuer ||
      !TRUST_TOKEN_generate_key(
          method, priv_key, &priv_key_len, TRUST_TOKEN_MAX_PRIVATE_KEY_SIZE,
          pub_key, &pub_key_len, TRUST_TOKEN_MAX_PUBLIC_KEY_SIZE, 0) ||
      !TRUST_TOKEN_CLIENT_add_key(client.get(), &key_index, pub_key,
                                  pub_key_len) ||
      !TRUST_TOKEN_ISSUER_add_key(issuer.get(), priv_key, priv_key_len)) {
    fprintf(stderr, "failed to generate trust token key.\n");
    return false;
  }

  uint8_t public_key[32], private_key[64];
  ED25519_keypair(public_key, private_key);
  bssl::UniquePtr<EVP_PKEY> priv(
      EVP_PKEY_from_raw_private_key(EVP_pkey_ed25519(), private_key, 32));
  bssl::UniquePtr<EVP_PKEY> pub(
      EVP_PKEY_from_raw_public_key(EVP_pkey_ed25519(), public_key, 32));
  if (!priv || !pub) {
    fprintf(stderr, "failed to generate trust token SRR key.\n");
    return false;
  }

  TRUST_TOKEN_CLIENT_set_srr_key(client.get(), pub.get());
  TRUST_TOKEN_ISSUER_set_srr_key(issuer.get(), priv.get());
  uint8_t metadata_key[32];
  RAND_bytes(metadata_key, sizeof(metadata_key));
  if (!TRUST_TOKEN_ISSUER_set_metadata_key(issuer.get(), metadata_key,
                                           sizeof(metadata_key))) {
    fprintf(stderr, "failed to generate trust token metadata key.\n");
    return false;
  }

  if (!TimeFunction(&results, [&]() -> bool {
        uint8_t *issue_msg = NULL;
        size_t msg_len;
        int ok = TRUST_TOKEN_CLIENT_begin_issuance(client.get(), &issue_msg,
                                                   &msg_len, batchsize);
        OPENSSL_free(issue_msg);
        // Clear pretokens.
        sk_TRUST_TOKEN_PRETOKEN_pop_free(client->pretokens,
                                         TRUST_TOKEN_PRETOKEN_free);
        client->pretokens = sk_TRUST_TOKEN_PRETOKEN_new_null();
        return ok;
      })) {
    fprintf(stderr, "TRUST_TOKEN_CLIENT_begin_issuance failed.\n");
    return false;
  }
  results.Print(name + " begin_issuance");

  uint8_t *issue_msg = NULL;
  size_t msg_len;
  if (!TRUST_TOKEN_CLIENT_begin_issuance(client.get(), &issue_msg, &msg_len,
                                         batchsize)) {
    fprintf(stderr, "TRUST_TOKEN_CLIENT_begin_issuance failed.\n");
    return false;
  }
  bssl::UniquePtr<uint8_t> free_issue_msg(issue_msg);

  bssl::UniquePtr<STACK_OF(TRUST_TOKEN_PRETOKEN)> pretokens(
      sk_TRUST_TOKEN_PRETOKEN_deep_copy(client->pretokens,
                                        trust_token_pretoken_dup,
                                        TRUST_TOKEN_PRETOKEN_free));

  if (!TimeFunction(&results, [&]() -> bool {
        uint8_t *issue_resp = NULL;
        size_t resp_len, tokens_issued;
        int ok = TRUST_TOKEN_ISSUER_issue(issuer.get(), &issue_resp, &resp_len,
                                          &tokens_issued, issue_msg, msg_len,
                                          /*public_metadata=*/0,
                                          /*private_metadata=*/0,
                                          /*max_issuance=*/batchsize);
        OPENSSL_free(issue_resp);
        return ok;
      })) {
    fprintf(stderr, "TRUST_TOKEN_ISSUER_issue failed.\n");
    return false;
  }
  results.Print(name + " issue");

  uint8_t *issue_resp = NULL;
  size_t resp_len, tokens_issued;
  if (!TRUST_TOKEN_ISSUER_issue(issuer.get(), &issue_resp, &resp_len,
                                &tokens_issued, issue_msg, msg_len,
                                /*public_metadata=*/0, /*private_metadata=*/0,
                                /*max_issuance=*/batchsize)) {
    fprintf(stderr, "TRUST_TOKEN_ISSUER_issue failed.\n");
    return false;
  }
  bssl::UniquePtr<uint8_t> free_issue_resp(issue_resp);

  if (!TimeFunction(&results, [&]() -> bool {
        size_t key_index2;
        bssl::UniquePtr<STACK_OF(TRUST_TOKEN)> tokens(
            TRUST_TOKEN_CLIENT_finish_issuance(client.get(), &key_index2,
                                               issue_resp, resp_len));

        // Reset pretokens.
        client->pretokens = sk_TRUST_TOKEN_PRETOKEN_deep_copy(
            pretokens.get(), trust_token_pretoken_dup,
            TRUST_TOKEN_PRETOKEN_free);
        return !!tokens;
      })) {
    fprintf(stderr, "TRUST_TOKEN_CLIENT_finish_issuance failed.\n");
    return false;
  }
  results.Print(name + " finish_issuance");

  bssl::UniquePtr<STACK_OF(TRUST_TOKEN)> tokens(
      TRUST_TOKEN_CLIENT_finish_issuance(client.get(), &key_index, issue_resp,
                                         resp_len));
  if (!tokens || sk_TRUST_TOKEN_num(tokens.get()) < 1) {
    fprintf(stderr, "TRUST_TOKEN_CLIENT_finish_issuance failed.\n");
    return false;
  }

  const TRUST_TOKEN *token = sk_TRUST_TOKEN_value(tokens.get(), 0);

  const uint8_t kClientData[] = "\x70TEST CLIENT DATA";
  uint64_t kRedemptionTime = 13374242;

  if (!TimeFunction(&results, [&]() -> bool {
        uint8_t *redeem_msg = NULL;
        size_t redeem_msg_len;
        int ok = TRUST_TOKEN_CLIENT_begin_redemption(
            client.get(), &redeem_msg, &redeem_msg_len, token, kClientData,
            sizeof(kClientData) - 1, kRedemptionTime);
        OPENSSL_free(redeem_msg);
        return ok;
      })) {
    fprintf(stderr, "TRUST_TOKEN_CLIENT_begin_redemption failed.\n");
    return false;
  }
  results.Print(name + " begin_redemption");

  uint8_t *redeem_msg = NULL;
  size_t redeem_msg_len;
  if (!TRUST_TOKEN_CLIENT_begin_redemption(
          client.get(), &redeem_msg, &redeem_msg_len, token, kClientData,
          sizeof(kClientData) - 1, kRedemptionTime)) {
    fprintf(stderr, "TRUST_TOKEN_CLIENT_begin_redemption failed.\n");
    return false;
  }
  bssl::UniquePtr<uint8_t> free_redeem_msg(redeem_msg);

  if (!TimeFunction(&results, [&]() -> bool {
        uint32_t public_value;
        uint8_t private_value;
        TRUST_TOKEN *rtoken;
        uint8_t *client_data = NULL;
        size_t client_data_len;
        int ok = TRUST_TOKEN_ISSUER_redeem(
            issuer.get(), &public_value, &private_value, &rtoken, &client_data,
            &client_data_len, redeem_msg, redeem_msg_len);
        OPENSSL_free(client_data);
        TRUST_TOKEN_free(rtoken);
        return ok;
      })) {
    fprintf(stderr, "TRUST_TOKEN_ISSUER_redeem failed.\n");
    return false;
  }
  results.Print(name + " redeem");

  uint32_t public_value;
  uint8_t private_value;
  TRUST_TOKEN *rtoken;
  uint8_t *client_data = NULL;
  size_t client_data_len;
  if (!TRUST_TOKEN_ISSUER_redeem(issuer.get(), &public_value, &private_value,
                                 &rtoken, &client_data, &client_data_len,
                                 redeem_msg, redeem_msg_len)) {
    fprintf(stderr, "TRUST_TOKEN_ISSUER_redeem failed.\n");
    return false;
  }
  bssl::UniquePtr<uint8_t> free_client_data(client_data);
  bssl::UniquePtr<TRUST_TOKEN> free_rtoken(rtoken);

  return true;
}

static bool SpeedX509(const std::string &selected) {
  if (!selected.empty() && selected.find("x509") == std::string::npos) {
    return true;
  }

  static const uint8_t kCert[] = {
      0x30, 0x82, 0x01, 0x3b, 0x30, 0x81, 0xe2, 0xa0, 0x03, 0x02, 0x01, 0x02,
      0x02, 0x01, 0x01, 0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
      0x04, 0x03, 0x02, 0x30, 0x1c, 0x31, 0x1a, 0x30, 0x18, 0x06, 0x03, 0x55,
      0x04, 0x03, 0x13, 0x11, 0x42, 0x61, 0x73, 0x69, 0x63, 0x20, 0x43, 0x6f,
      0x6e, 0x73, 0x74, 0x72, 0x61, 0x69, 0x6e, 0x74, 0x73, 0x30, 0x20, 0x17,
      0x0d, 0x30, 0x30, 0x30, 0x31, 0x30, 0x31, 0x30, 0x30, 0x30, 0x30, 0x30,
      0x30, 0x5a, 0x18, 0x0f, 0x32, 0x31, 0x30, 0x30, 0x30, 0x31, 0x30, 0x31,
      0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x5a, 0x30, 0x1c, 0x31, 0x1a, 0x30,
      0x18, 0x06, 0x03, 0x55, 0x04, 0x03, 0x13, 0x11, 0x42, 0x61, 0x73, 0x69,
      0x63, 0x20, 0x43, 0x6f, 0x6e, 0x73, 0x74, 0x72, 0x61, 0x69, 0x6e, 0x74,
      0x73, 0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d,
      0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
      0x03, 0x42, 0x00, 0x04, 0x91, 0x2a, 0xd8, 0xbc, 0x55, 0x6d, 0x91, 0x92,
      0x66, 0xbe, 0x2a, 0xdf, 0x63, 0x42, 0x43, 0x0d, 0x8a, 0xd9, 0x42, 0xb3,
      0x49, 0x79, 0xc3, 0xcb, 0xb7, 0x49, 0x2c, 0x26, 0xec, 0x76, 0x51, 0x12,
      0xf9, 0x9c, 0x04, 0x22, 0x41, 0x8d, 0x52, 0x11, 0x11, 0xa7, 0x11, 0xa8,
      0x8d, 0x2e, 0x9a, 0x1c, 0xd1, 0xd9, 0x5e, 0x4d, 0x2f, 0x30, 0x41, 0x3f,
      0xdc, 0x8f, 0x0f, 0xf0, 0x3e, 0x0a, 0x1e, 0x57, 0xa3, 0x13, 0x30, 0x11,
      0x30, 0x0f, 0x06, 0x03, 0x55, 0x1d, 0x13, 0x01, 0x01, 0xff, 0x04, 0x05,
      0x30, 0x03, 0x01, 0x01, 0xff, 0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48,
      0xce, 0x3d, 0x04, 0x03, 0x02, 0x03, 0x48, 0x00, 0x30, 0x45, 0x02, 0x20,
      0x4c, 0xdb, 0x36, 0x69, 0x03, 0xc3, 0x66, 0xcf, 0x8f, 0x6a, 0x5e, 0x4b,
      0x03, 0x57, 0xc0, 0x2b, 0x20, 0xb8, 0x00, 0xa4, 0xcd, 0x37, 0xe2, 0x44,
      0xfe, 0xf1, 0x18, 0x9d, 0xd2, 0xa1, 0x17, 0x16, 0x02, 0x21, 0x00, 0xdf,
      0x6f, 0xb2, 0x23, 0x0e, 0x85, 0xf1, 0xff, 0x71, 0x81, 0x9e, 0xca, 0xe1,
      0xb7, 0x5e, 0x0d, 0x52, 0x6c, 0xd4, 0x05, 0xda, 0xa4, 0x41, 0xa7, 0xc9,
      0xbc, 0x2f, 0x9e, 0x1c, 0x87, 0x6d, 0x40};
  TimeResults results;
  if (!TimeFunctionParallel(&results, [&]() -> bool {
        const uint8_t *inp = kCert;
        bssl::UniquePtr<X509> x509(d2i_X509(nullptr, &inp, sizeof(kCert)));
        return x509 != nullptr;
      })) {
    fprintf(stderr, "d2i_X509 failed.\n");
    ERR_print_errors_fp(stderr);
    return false;
  }
  results.Print("Parse X.509 certificate");
  return true;
}

#if defined(BORINGSSL_FIPS)
static bool SpeedSelfTest(const std::string &selected) {
  if (!selected.empty() && selected.find("self-test") == std::string::npos) {
    return true;
  }

  TimeResults results;
  if (!TimeFunction(&results, []() -> bool { return BORINGSSL_self_test(); })) {
    fprintf(stderr, "BORINGSSL_self_test faileid.\n");
    ERR_print_errors_fp(stderr);
    return false;
  }

  results.Print("self-test");
  return true;
}
#endif

static const struct argument kArguments[] = {
    {
        "-filter",
        kOptionalArgument,
        "A filter on the speed tests to run",
    },
    {
        "-timeout",
        kOptionalArgument,
        "The number of seconds to run each test for (default is 1)",
    },
    {
        "-chunks",
        kOptionalArgument,
        "A comma-separated list of input sizes to run tests at (default is "
        "16,256,1350,8192,16384)",
    },
    {
        "-json",
        kBooleanArgument,
        "If this flag is set, speed will print the output of each benchmark in "
        "JSON format as follows: \"{\"description\": "
        "\"descriptionOfOperation\", \"numCalls\": 1234, "
        "\"timeInMicroseconds\": 1234567, \"bytesPerCall\": 1234}\". When "
        "there is no information about the bytes per call for an  operation, "
        "the JSON field for bytesPerCall will be omitted.",
    },
#if defined(OPENSSL_THREADS)
    {
        "-threads",
        kOptionalArgument,
        "The number of threads to benchmark in parallel (default is 1)",
    },
#endif
    {
        "",
        kOptionalArgument,
        "",
    },
};

bool Speed(const std::vector<std::string> &args) {
  std::map<std::string, std::string> args_map;
  if (!ParseKeyValueArguments(&args_map, args, kArguments)) {
    PrintUsage(kArguments);
    return false;
  }

  std::string selected;
  if (args_map.count("-filter") != 0) {
    selected = args_map["-filter"];
  }

  if (args_map.count("-json") != 0) {
    g_print_json = true;
  }

  if (args_map.count("-timeout") != 0) {
    g_timeout_seconds = atoi(args_map["-timeout"].c_str());
  }

#if defined(OPENSSL_THREADS)
  if (args_map.count("-threads") != 0) {
    g_threads = atoi(args_map["-threads"].c_str());
  }
#endif

  if (args_map.count("-chunks") != 0) {
    g_chunk_lengths.clear();
    const char *start = args_map["-chunks"].data();
    const char *end = start + args_map["-chunks"].size();
    while (start != end) {
      errno = 0;
      char *ptr;
      unsigned long long val = strtoull(start, &ptr, 10);
      if (ptr == start /* no numeric characters found */ ||
          errno == ERANGE /* overflow */ || static_cast<size_t>(val) != val) {
        fprintf(stderr, "Error parsing -chunks argument\n");
        return false;
      }
      g_chunk_lengths.push_back(static_cast<size_t>(val));
      start = ptr;
      if (start != end) {
        if (*start != ',') {
          fprintf(stderr, "Error parsing -chunks argument\n");
          return false;
        }
        start++;
      }
    }
  }

  // kTLSADLen is the number of bytes of additional data that TLS passes to
  // AEADs.
  static const size_t kTLSADLen = 13;
  // kLegacyADLen is the number of bytes that TLS passes to the "legacy" AEADs.
  // These are AEADs that weren't originally defined as AEADs, but which we use
  // via the AEAD interface. In order for that to work, they have some TLS
  // knowledge in them and construct a couple of the AD bytes internally.
  static const size_t kLegacyADLen = kTLSADLen - 2;

  if (g_print_json) {
    puts("[");
  }
  if (!SpeedRSA(selected) ||
      !SpeedAEAD(EVP_aead_aes_128_gcm(), "AES-128-GCM", kTLSADLen, selected) ||
      !SpeedAEAD(EVP_aead_aes_256_gcm(), "AES-256-GCM", kTLSADLen, selected) ||
      !SpeedAEAD(EVP_aead_chacha20_poly1305(), "ChaCha20-Poly1305", kTLSADLen,
                 selected) ||
      !SpeedAEAD(EVP_aead_des_ede3_cbc_sha1_tls(), "DES-EDE3-CBC-SHA1",
                 kLegacyADLen, selected) ||
      !SpeedAEAD(EVP_aead_aes_128_cbc_sha1_tls(), "AES-128-CBC-SHA1",
                 kLegacyADLen, selected) ||
      !SpeedAEAD(EVP_aead_aes_256_cbc_sha1_tls(), "AES-256-CBC-SHA1",
                 kLegacyADLen, selected) ||
      !SpeedAEADOpen(EVP_aead_aes_128_cbc_sha1_tls(), "AES-128-CBC-SHA1",
                     kLegacyADLen, selected) ||
      !SpeedAEADOpen(EVP_aead_aes_256_cbc_sha1_tls(), "AES-256-CBC-SHA1",
                     kLegacyADLen, selected) ||
      !SpeedAEAD(EVP_aead_aes_128_gcm_siv(), "AES-128-GCM-SIV", kTLSADLen,
                 selected) ||
      !SpeedAEAD(EVP_aead_aes_256_gcm_siv(), "AES-256-GCM-SIV", kTLSADLen,
                 selected) ||
      !SpeedAEADOpen(EVP_aead_aes_128_gcm_siv(), "AES-128-GCM-SIV", kTLSADLen,
                     selected) ||
      !SpeedAEADOpen(EVP_aead_aes_256_gcm_siv(), "AES-256-GCM-SIV", kTLSADLen,
                     selected) ||
      !SpeedAEAD(EVP_aead_aes_128_ccm_bluetooth(), "AES-128-CCM-Bluetooth",
                 kTLSADLen, selected) ||
      !SpeedAESBlock("AES-128", 128, selected) ||
      !SpeedAESBlock("AES-256", 256, selected) ||
      !SpeedHash(EVP_sha1(), "SHA-1", selected) ||
      !SpeedHash(EVP_sha256(), "SHA-256", selected) ||
      !SpeedHash(EVP_sha512(), "SHA-512", selected) ||
      !SpeedHash(EVP_blake2b256(), "BLAKE2b-256", selected) ||
      !SpeedRandom(selected) ||       //
      !SpeedECDH(selected) ||         //
      !SpeedECDSA(selected) ||        //
      !Speed25519(selected) ||        //
      !SpeedSPAKE2(selected) ||       //
      !SpeedScrypt(selected) ||       //
      !SpeedRSAKeyGen(selected) ||    //
      !SpeedHRSS(selected) ||         //
      !SpeedMLDSA(selected) ||        //
      !SpeedMLKEM(selected) ||        //
      !SpeedMLKEM1024(selected) ||    //
      !SpeedSLHDSA(selected) ||       //
      !SpeedHashToCurve(selected) ||  //
      !SpeedTrustToken("TrustToken-Exp1-Batch1", TRUST_TOKEN_experiment_v1(), 1,
                       selected) ||
      !SpeedTrustToken("TrustToken-Exp1-Batch10", TRUST_TOKEN_experiment_v1(),
                       10, selected) ||
      !SpeedTrustToken("TrustToken-Exp2VOPRF-Batch1",
                       TRUST_TOKEN_experiment_v2_voprf(), 1, selected) ||
      !SpeedTrustToken("TrustToken-Exp2VOPRF-Batch10",
                       TRUST_TOKEN_experiment_v2_voprf(), 10, selected) ||
      !SpeedTrustToken("TrustToken-Exp2PMB-Batch1",
                       TRUST_TOKEN_experiment_v2_pmb(), 1, selected) ||
      !SpeedTrustToken("TrustToken-Exp2PMB-Batch10",
                       TRUST_TOKEN_experiment_v2_pmb(), 10, selected) ||
      !SpeedBase64(selected) ||   //
      !SpeedSipHash(selected) ||  //
      !SpeedX509(selected)) {
    return false;
  }
#if defined(BORINGSSL_FIPS)
  if (!SpeedSelfTest(selected)) {
    return false;
  }
#endif
  if (g_print_json) {
    puts("\n]");
  }

  return true;
}
