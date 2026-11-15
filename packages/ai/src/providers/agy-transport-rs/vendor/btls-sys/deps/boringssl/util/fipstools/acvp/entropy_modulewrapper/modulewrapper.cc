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

#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include <string.h>

#include "../../../../crypto/fipsmodule/entropy/sha512.cc.inc"
#include "../modulewrapper/modulewrapper.h"


namespace bssl {
namespace acvp {

static bool GetConfig(const Span<const uint8_t> args[],
                      ReplyCallback write_reply) {
  static constexpr char kConfig[] =
      R"([
      {
        "algorithm": "acvptool",
        "features": ["batch"]
      },
      {
        "algorithm": "SHA2-384",
        "revision": "1.0",
        "messageLength": [{
          "min": 0, "max": 65528, "increment": 8
        }]
      }
    ])";
  return write_reply({bssl::StringAsBytes(kConfig)});
}

constexpr size_t DigestLength = 48;

static void HashSHA384(uint8_t *out_digest, Span<const uint8_t> input) {
  bssl::entropy::SHA512_CTX ctx;
  bssl::entropy::SHA384_Init(&ctx);
  bssl::entropy::SHA384_Update(&ctx, input.data(), input.size());
  bssl::entropy::SHA384_Final(out_digest, &ctx);
}

static bool SHA384(const Span<const uint8_t> args[],
                   ReplyCallback write_reply) {
  uint8_t digest[DigestLength];
  HashSHA384(digest, args[0]);
  return write_reply({Span<const uint8_t>(digest)});
}

static bool SHA384MCT(const Span<const uint8_t> args[],
                      ReplyCallback write_reply) {
  if (args[0].size() != DigestLength) {
    return false;
  }

  uint8_t buf[DigestLength * 3];
  memcpy(buf, args[0].data(), DigestLength);
  memcpy(buf + DigestLength, args[0].data(), DigestLength);
  memcpy(buf + 2 * DigestLength, args[0].data(), DigestLength);

  for (size_t i = 0; i < 1000; i++) {
    uint8_t digest[DigestLength];
    HashSHA384(digest, buf);
    memmove(buf, buf + DigestLength, DigestLength * 2);
    memcpy(buf + DigestLength * 2, digest, DigestLength);
  }

  return write_reply({Span(buf).subspan(2 * DigestLength, DigestLength)});
}

static constexpr struct {
  char name[kMaxNameLength + 1];
  uint8_t num_expected_args;
  bool (*handler)(const Span<const uint8_t> args[], ReplyCallback write_reply);
} kFunctions[] = {
    {"getConfig", 0, GetConfig},
    {"SHA2-384", 1, SHA384},
    {"SHA2-384/MCT", 1, SHA384MCT},
};

Handler FindHandler(Span<const Span<const uint8_t>> args) {
  auto algorithm = bssl::BytesAsStringView(args[0]);
  for (const auto &func : kFunctions) {
    if (algorithm == func.name) {
      if (args.size() - 1 != func.num_expected_args) {
        fprintf(stderr,
                "\'%s\' operation received %zu arguments but expected %u.\n",
                func.name, args.size() - 1, func.num_expected_args);
        return nullptr;
      }

      return func.handler;
    }
  }

  fprintf(stderr, "Unknown operation: %s\n", std::string(algorithm).c_str());
  return nullptr;
}

}  // namespace acvp
}  // namespace bssl
