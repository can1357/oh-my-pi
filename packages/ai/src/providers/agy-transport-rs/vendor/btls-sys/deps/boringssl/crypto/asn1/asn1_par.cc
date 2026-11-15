// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/asn1.h>


const char *ASN1_tag2str(int tag) {
  static const char *const tag2str[] = {
      "EOC",
      "BOOLEAN",
      "INTEGER",
      "BIT STRING",
      "OCTET STRING",
      "NULL",
      "OBJECT",
      "OBJECT DESCRIPTOR",
      "EXTERNAL",
      "REAL",
      "ENUMERATED",
      "<ASN1 11>",
      "UTF8STRING",
      "<ASN1 13>",
      "<ASN1 14>",
      "<ASN1 15>",
      "SEQUENCE",
      "SET",
      "NUMERICSTRING",
      "PRINTABLESTRING",
      "T61STRING",
      "VIDEOTEXSTRING",
      "IA5STRING",
      "UTCTIME",
      "GENERALIZEDTIME",
      "GRAPHICSTRING",
      "VISIBLESTRING",
      "GENERALSTRING",
      "UNIVERSALSTRING",
      "<ASN1 29>",
      "BMPSTRING",
  };

  if ((tag == V_ASN1_NEG_INTEGER) || (tag == V_ASN1_NEG_ENUMERATED)) {
    tag &= ~V_ASN1_NEG;
  }

  if (tag < 0 || tag > 30) {
    return "(unknown)";
  }
  return tag2str[tag];
}
