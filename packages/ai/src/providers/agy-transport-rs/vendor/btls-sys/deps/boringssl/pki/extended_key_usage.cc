// Copyright 2015 The Chromium Authors
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

#include "extended_key_usage.h"

#include <openssl/bytestring.h>

#include "input.h"
#include "parser.h"

BSSL_NAMESPACE_BEGIN

bool ParseEKUExtension(der::Input extension_value,
                       std::vector<der::Input> *eku_oids) {
  der::Parser extension_parser(extension_value);
  der::Parser sequence_parser;
  if (!extension_parser.ReadSequence(&sequence_parser)) {
    return false;
  }

  // Section 4.2.1.12 of RFC 5280 defines ExtKeyUsageSyntax as:
  // ExtKeyUsageSyntax ::= SEQUENCE SIZE (1..MAX) OF KeyPurposeId
  //
  // Therefore, the sequence must contain at least one KeyPurposeId.
  if (!sequence_parser.HasMore()) {
    return false;
  }
  while (sequence_parser.HasMore()) {
    der::Input eku_oid;
    if (!sequence_parser.ReadTag(CBS_ASN1_OBJECT, &eku_oid)) {
      // The SEQUENCE OF must contain only KeyPurposeIds (OIDs).
      return false;
    }
    eku_oids->push_back(eku_oid);
  }
  if (extension_parser.HasMore()) {
    // The extension value must follow ExtKeyUsageSyntax - there is no way that
    // it could be extended to allow for something after the SEQUENCE OF.
    return false;
  }
  return true;
}

BSSL_NAMESPACE_END
