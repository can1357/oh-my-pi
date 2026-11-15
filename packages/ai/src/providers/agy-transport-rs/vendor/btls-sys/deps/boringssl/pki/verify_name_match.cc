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

#include "verify_name_match.h"

#include <openssl/base.h>
#include <openssl/bytestring.h>

#include "cert_error_params.h"
#include "cert_errors.h"
#include "input.h"
#include "parse_name.h"
#include "parser.h"

BSSL_NAMESPACE_BEGIN

DEFINE_CERT_ERROR_ID(kFailedConvertingAttributeValue,
                     "Failed converting AttributeValue to string");
DEFINE_CERT_ERROR_ID(kFailedNormalizingString, "Failed normalizing string");

namespace {

// Types of character set checking that NormalizeDirectoryString can perform.
enum CharsetEnforcement {
  NO_ENFORCEMENT,
  ENFORCE_PRINTABLE_STRING,
  ENFORCE_ASCII,
};

// Normalizes |output|, a UTF-8 encoded string, as if it contained
// only ASCII characters.
//
// This could be considered a partial subset of RFC 5280 rules, and
// is compatible with RFC 2459/3280.
//
// In particular, RFC 5280, Section 7.1 describes how UTF8String
// and PrintableString should be compared - using the LDAP StringPrep
// profile of RFC 4518, with case folding and whitespace compression.
// However, because it is optional for 2459/3280 implementations and because
// it's desirable to avoid the size cost of the StringPrep tables,
// this function treats |output| as if it was composed of ASCII.
//
// That is, rather than folding all whitespace characters, it only
// folds ' '. Rather than case folding using locale-aware handling,
// it only folds A-Z to a-z.
//
// This gives better results than outright rejecting (due to mismatched
// encodings), or from doing a strict binary comparison (the minimum
// required by RFC 3280), and is sufficient for those certificates
// publicly deployed.
//
// If |charset_enforcement| is not NO_ENFORCEMENT and |output| contains any
// characters not allowed in the specified charset, returns false.
//
// NOTE: |output| will be modified regardless of the return.
[[nodiscard]] bool NormalizeDirectoryString(
    CharsetEnforcement charset_enforcement, std::string *output) {
  // Normalized version will always be equal or shorter than input.
  // Normalize in place and then truncate the output if necessary.
  std::string::const_iterator read_iter = output->begin();
  std::string::iterator write_iter = output->begin();

  for (; read_iter != output->end() && *read_iter == ' '; ++read_iter) {
    // Ignore leading whitespace.
  }

  for (; read_iter != output->end(); ++read_iter) {
    const unsigned char c = *read_iter;
    if (c == ' ') {
      // If there are non-whitespace characters remaining in input, compress
      // multiple whitespace chars to a single space, otherwise ignore trailing
      // whitespace.
      std::string::const_iterator next_iter = read_iter + 1;
      if (next_iter != output->end() && *next_iter != ' ') {
        *(write_iter++) = ' ';
      }
    } else if (c >= 'A' && c <= 'Z') {
      // Fold case.
      *(write_iter++) = c + ('a' - 'A');
    } else {
      // Note that these checks depend on the characters allowed by earlier
      // conditions also being valid for the enforced charset.
      switch (charset_enforcement) {
        case ENFORCE_PRINTABLE_STRING:
          // See NormalizePrintableStringValue comment for the acceptable list
          // of characters.
          if (!((c >= 'a' && c <= 'z') || (c >= '\'' && c <= ':') || c == '=' ||
                c == '?')) {
            return false;
          }
          break;
        case ENFORCE_ASCII:
          if (c > 0x7F) {
            return false;
          }
          break;
        case NO_ENFORCEMENT:
          break;
      }
      *(write_iter++) = c;
    }
  }
  if (write_iter != output->end()) {
    output->erase(write_iter, output->end());
  }
  return true;
}

// Converts the value of X509NameAttribute |attribute| to UTF-8, normalizes it,
// and stores in |output|. The type of |attribute| must be one of the types for
// which IsNormalizableDirectoryString is true.
//
// If the value of |attribute| can be normalized, returns true and sets
// |output| to the case folded, normalized value. If the value of |attribute|
// is invalid, returns false.
// NOTE: |output| will be modified regardless of the return.
[[nodiscard]] bool NormalizeValue(X509NameAttribute attribute,
                                  std::string *output, CertErrors *errors) {
  BSSL_CHECK(errors);

  if (!attribute.ValueAsStringUnsafe(output)) {
    errors->AddError(kFailedConvertingAttributeValue,
                     CreateCertErrorParams1SizeT("tag", attribute.value_tag));
    return false;
  }

  bool success = false;
  switch (attribute.value_tag) {
    case CBS_ASN1_PRINTABLESTRING:
      success = NormalizeDirectoryString(ENFORCE_PRINTABLE_STRING, output);
      break;
    case CBS_ASN1_BMPSTRING:
    case CBS_ASN1_UNIVERSALSTRING:
    case CBS_ASN1_UTF8STRING:
      success = NormalizeDirectoryString(NO_ENFORCEMENT, output);
      break;
    case CBS_ASN1_IA5STRING:
      success = NormalizeDirectoryString(ENFORCE_ASCII, output);
      break;
    default:
      // NOTREACHED
      success = false;
      break;
  }

  if (!success) {
    errors->AddError(kFailedNormalizingString,
                     CreateCertErrorParams1SizeT("tag", attribute.value_tag));
  }

  return success;
}

// Returns true if |tag| is a string type that NormalizeValue can handle.
bool IsNormalizableDirectoryString(CBS_ASN1_TAG tag) {
  switch (tag) {
    case CBS_ASN1_PRINTABLESTRING:
    case CBS_ASN1_UTF8STRING:
    // RFC 5280 only requires handling IA5String for comparing domainComponent
    // values, but handling it here avoids the need to special case anything.
    case CBS_ASN1_IA5STRING:
    case CBS_ASN1_UNIVERSALSTRING:
    case CBS_ASN1_BMPSTRING:
      return true;
    // TeletexString isn't normalized. Section 8 of RFC 5280 briefly
    // describes the historical confusion between treating TeletexString
    // as Latin1String vs T.61, and there are even incompatibilities within
    // T.61 implementations. As this time is virtually unused, simply
    // treat it with a binary comparison, as permitted by RFC 3280/5280.
    default:
      return false;
  }
}

// Returns true if the value of X509NameAttribute |a| matches |b|.
bool VerifyValueMatch(X509NameAttribute a, X509NameAttribute b) {
  if (IsNormalizableDirectoryString(a.value_tag) &&
      IsNormalizableDirectoryString(b.value_tag)) {
    std::string a_normalized, b_normalized;
    // TODO(eroman): Plumb this down.
    CertErrors unused_errors;
    if (!NormalizeValue(a, &a_normalized, &unused_errors) ||
        !NormalizeValue(b, &b_normalized, &unused_errors)) {
      return false;
    }
    return a_normalized == b_normalized;
  }
  // Attributes encoded with different types may be assumed to be unequal.
  if (a.value_tag != b.value_tag) {
    return false;
  }
  // All other types use binary comparison.
  return a.value == b.value;
}

// Verifies that |a_parser| and |b_parser| are the same length and that every
// AttributeTypeAndValue in |a_parser| has a matching AttributeTypeAndValue in
// |b_parser|.
bool VerifyRdnMatch(der::Parser *a_parser, der::Parser *b_parser) {
  RelativeDistinguishedName a_type_and_values, b_type_and_values;
  if (!ReadRdn(a_parser, &a_type_and_values) ||
      !ReadRdn(b_parser, &b_type_and_values)) {
    return false;
  }

  // RFC 5280 section 7.1:
  // Two relative distinguished names RDN1 and RDN2 match if they have the same
  // number of naming attributes and for each naming attribute in RDN1 there is
  // a matching naming attribute in RDN2.
  if (a_type_and_values.size() != b_type_and_values.size()) {
    return false;
  }

  // The ordering of elements may differ due to denormalized values sorting
  // differently in the DER encoding. Since the number of elements should be
  // small, a naive linear search for each element should be fine. (Hostile
  // certificates already have ways to provoke pathological behavior.)
  for (const auto &a : a_type_and_values) {
    auto b_iter = b_type_and_values.begin();
    for (; b_iter != b_type_and_values.end(); ++b_iter) {
      const auto &b = *b_iter;
      if (a.type == b.type && VerifyValueMatch(a, b)) {
        break;
      }
    }
    if (b_iter == b_type_and_values.end()) {
      return false;
    }
    // Remove the matched element from b_type_and_values to ensure duplicate
    // elements in a_type_and_values can't match the same element in
    // b_type_and_values multiple times.
    b_type_and_values.erase(b_iter);
  }

  // Every element in |a_type_and_values| had a matching element in
  // |b_type_and_values|.
  return true;
}

enum NameMatchType {
  EXACT_MATCH,
  SUBTREE_MATCH,
};

// Verify that |a| matches |b|. If |match_type| is EXACT_MATCH, returns true if
// they are an exact match as defined by RFC 5280 7.1. If |match_type| is
// SUBTREE_MATCH, returns true if |a| is within the subtree defined by |b| as
// defined by RFC 5280 7.1.
//
// |a| and |b| are ASN.1 RDNSequence values (not including the Sequence tag),
// defined in RFC 5280 section 4.1.2.4:
//
// Name ::= CHOICE { -- only one possibility for now --
//   rdnSequence  RDNSequence }
//
// RDNSequence ::= SEQUENCE OF RelativeDistinguishedName
//
// RelativeDistinguishedName ::=
//   SET SIZE (1..MAX) OF AttributeTypeAndValue
bool VerifyNameMatchInternal(der::Input a, der::Input b,
                             NameMatchType match_type) {
  // Empty Names are allowed.  RFC 5280 section 4.1.2.4 requires "The issuer
  // field MUST contain a non-empty distinguished name (DN)", while section
  // 4.1.2.6 allows for the Subject to be empty in certain cases. The caller is
  // assumed to have verified those conditions.

  // RFC 5280 section 7.1:
  // Two distinguished names DN1 and DN2 match if they have the same number of
  // RDNs, for each RDN in DN1 there is a matching RDN in DN2, and the matching
  // RDNs appear in the same order in both DNs.

  // As an optimization, first just compare the number of RDNs:
  der::Parser a_rdn_sequence_counter(a);
  der::Parser b_rdn_sequence_counter(b);
  while (a_rdn_sequence_counter.HasMore() && b_rdn_sequence_counter.HasMore()) {
    if (!a_rdn_sequence_counter.SkipTag(CBS_ASN1_SET) ||
        !b_rdn_sequence_counter.SkipTag(CBS_ASN1_SET)) {
      return false;
    }
  }
  // If doing exact match and either of the sequences has more elements than the
  // other, not a match. If doing a subtree match, the first Name may have more
  // RDNs than the second.
  if (b_rdn_sequence_counter.HasMore()) {
    return false;
  }
  if (match_type == EXACT_MATCH && a_rdn_sequence_counter.HasMore()) {
    return false;
  }

  // Verify that RDNs in |a| and |b| match.
  der::Parser a_rdn_sequence(a);
  der::Parser b_rdn_sequence(b);
  while (a_rdn_sequence.HasMore() && b_rdn_sequence.HasMore()) {
    der::Parser a_rdn, b_rdn;
    if (!a_rdn_sequence.ReadConstructed(CBS_ASN1_SET, &a_rdn) ||
        !b_rdn_sequence.ReadConstructed(CBS_ASN1_SET, &b_rdn)) {
      return false;
    }
    if (!VerifyRdnMatch(&a_rdn, &b_rdn)) {
      return false;
    }
  }

  return true;
}

}  // namespace

bool NormalizeName(der::Input name_rdn_sequence,
                   std::string *normalized_rdn_sequence, CertErrors *errors) {
  BSSL_CHECK(errors);

  // RFC 5280 section 4.1.2.4
  // RDNSequence ::= SEQUENCE OF RelativeDistinguishedName
  der::Parser rdn_sequence_parser(name_rdn_sequence);

  bssl::ScopedCBB cbb;
  if (!CBB_init(cbb.get(), 0)) {
    return false;
  }

  while (rdn_sequence_parser.HasMore()) {
    // RelativeDistinguishedName ::= SET SIZE (1..MAX) OF AttributeTypeAndValue
    der::Parser rdn_parser;
    if (!rdn_sequence_parser.ReadConstructed(CBS_ASN1_SET, &rdn_parser)) {
      return false;
    }
    RelativeDistinguishedName type_and_values;
    if (!ReadRdn(&rdn_parser, &type_and_values)) {
      return false;
    }

    CBB rdn_cbb;
    if (!CBB_add_asn1(cbb.get(), &rdn_cbb, CBS_ASN1_SET)) {
      return false;
    }

    for (const auto &type_and_value : type_and_values) {
      // AttributeTypeAndValue ::= SEQUENCE {
      //   type     AttributeType,
      //   value    AttributeValue }
      CBB attribute_type_and_value_cbb, type_cbb, value_cbb;
      if (!CBB_add_asn1(&rdn_cbb, &attribute_type_and_value_cbb,
                        CBS_ASN1_SEQUENCE)) {
        return false;
      }

      // AttributeType ::= OBJECT IDENTIFIER
      if (!CBB_add_asn1(&attribute_type_and_value_cbb, &type_cbb,
                        CBS_ASN1_OBJECT) ||
          !CBB_add_bytes(&type_cbb, type_and_value.type.data(),
                         type_and_value.type.size())) {
        return false;
      }

      // AttributeValue ::= ANY -- DEFINED BY AttributeType
      if (IsNormalizableDirectoryString(type_and_value.value_tag)) {
        std::string normalized_value;
        if (!NormalizeValue(type_and_value, &normalized_value, errors)) {
          return false;
        }
        if (!CBB_add_asn1(&attribute_type_and_value_cbb, &value_cbb,
                          CBS_ASN1_UTF8STRING) ||
            !CBB_add_bytes(
                &value_cbb,
                reinterpret_cast<const uint8_t *>(normalized_value.data()),
                normalized_value.size())) {
          return false;
        }
      } else {
        if (!CBB_add_asn1(&attribute_type_and_value_cbb, &value_cbb,
                          type_and_value.value_tag) ||
            !CBB_add_bytes(&value_cbb, type_and_value.value.data(),
                           type_and_value.value.size())) {
          return false;
        }
      }

      if (!CBB_flush(&rdn_cbb)) {
        return false;
      }
    }

    // Ensure the encoded AttributeTypeAndValue values in the SET OF are sorted.
    if (!CBB_flush_asn1_set_of(&rdn_cbb) || !CBB_flush(cbb.get())) {
      return false;
    }
  }

  normalized_rdn_sequence->assign(CBB_data(cbb.get()),
                                  CBB_data(cbb.get()) + CBB_len(cbb.get()));
  return true;
}

bool VerifyNameMatch(der::Input a_rdn_sequence, der::Input b_rdn_sequence) {
  return VerifyNameMatchInternal(a_rdn_sequence, b_rdn_sequence, EXACT_MATCH);
}

bool VerifyNameInSubtree(der::Input name_rdn_sequence,
                         der::Input parent_rdn_sequence) {
  return VerifyNameMatchInternal(name_rdn_sequence, parent_rdn_sequence,
                                 SUBTREE_MATCH);
}

bool FindEmailAddressesInName(
    der::Input name_rdn_sequence,
    std::vector<std::string> *contained_email_addresses) {
  contained_email_addresses->clear();

  der::Parser rdn_sequence_parser(name_rdn_sequence);
  while (rdn_sequence_parser.HasMore()) {
    der::Parser rdn_parser;
    if (!rdn_sequence_parser.ReadConstructed(CBS_ASN1_SET, &rdn_parser)) {
      return false;
    }

    RelativeDistinguishedName type_and_values;
    if (!ReadRdn(&rdn_parser, &type_and_values)) {
      return false;
    }

    for (const auto &type_and_value : type_and_values) {
      if (type_and_value.type == der::Input(kTypeEmailAddressOid)) {
        std::string email_address;
        if (!type_and_value.ValueAsString(&email_address)) {
          return false;
        }
        contained_email_addresses->push_back(std::move(email_address));
      }
    }
  }

  return true;
}

BSSL_NAMESPACE_END
