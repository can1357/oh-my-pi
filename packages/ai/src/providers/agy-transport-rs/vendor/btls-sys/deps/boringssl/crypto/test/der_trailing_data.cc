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

#include "der_trailing_data.h"

#include <optional>

#include <openssl/bytestring.h>

static bool RewriteWithTrailingData(CBB *cbb, CBS *cbs,
                                    std::optional<size_t> *rewrite_counter) {
  CBS contents;
  CBS_ASN1_TAG tag;
  if (!CBS_get_any_asn1(cbs, &contents, &tag)) {
    return false;
  }

  if (!rewrite_counter->has_value() || (tag & CBS_ASN1_CONSTRUCTED) == 0) {
    return CBB_add_asn1_element(cbb, tag, CBS_data(&contents),
                                CBS_len(&contents));
  }

  CBB child;
  if (!CBB_add_asn1(cbb, &child, tag)) {
    return false;
  }

  if (rewrite_counter->value() == 0) {
    *rewrite_counter = std::nullopt;
    return CBB_add_bytes(&child, CBS_data(&contents), CBS_len(&contents)) &&
           // Add a BER EOC, which is always invalid in DER.
           CBB_add_u8(&child, 0) &&  //
           CBB_add_u8(&child, 0) &&  //
           CBB_flush(cbb);
  }

  *rewrite_counter = rewrite_counter->value() - 1;
  while (CBS_len(&contents) != 0) {
    if (!RewriteWithTrailingData(&child, &contents, rewrite_counter)) {
      return false;
    }
  }
  return CBB_flush(cbb);
}

bool TestDERTrailingData(
    bssl::Span<const uint8_t> in,
    std::function<void(bssl::Span<const uint8_t>, size_t)> func) {
  for (size_t elem_to_rewrite = 0; true; elem_to_rewrite++) {
    std::optional<size_t> rewrite_counter = elem_to_rewrite;
    CBS cbs = in;
    bssl::ScopedCBB cbb;
    if (!CBB_init(cbb.get(), in.size() + /* EOC */ 2 +
                                 /* in case lengths get larger */ 8) ||
        !RewriteWithTrailingData(cbb.get(), &cbs, &rewrite_counter) ||
        CBS_len(&cbs) != 0) {
      return false;
    }

    // We have exhausted every constructed element.
    if (rewrite_counter.has_value()) {
      return true;
    }

    func(bssl::Span(CBB_data(cbb.get()), CBB_len(cbb.get())), elem_to_rewrite);
  }
}
