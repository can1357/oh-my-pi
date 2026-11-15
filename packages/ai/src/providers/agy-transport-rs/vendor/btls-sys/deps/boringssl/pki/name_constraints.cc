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

#include "name_constraints.h"

#include <limits.h>

#include <memory>
#include <optional>

#include <openssl/base.h>
#include <openssl/bytestring.h>

#include "cert_errors.h"
#include "common_cert_errors.h"
#include "general_names.h"
#include "input.h"
#include "ip_util.h"
#include "parser.h"
#include "string_util.h"
#include "verify_name_match.h"

BSSL_NAMESPACE_BEGIN

namespace {

// The name types of GeneralName that are fully supported in name constraints.
//
// (The other types will have the minimal checking described by RFC 5280
// section 4.2.1.10: If a name constraints extension that is marked as critical
// imposes constraints on a particular name form, and an instance of
// that name form appears in the subject field or subjectAltName
// extension of a subsequent certificate, then the application MUST
// either process the constraint or reject the certificate.)
const int kSupportedNameTypes =
    GENERAL_NAME_RFC822_NAME | GENERAL_NAME_DNS_NAME |
    GENERAL_NAME_DIRECTORY_NAME | GENERAL_NAME_IP_ADDRESS;

// Controls wildcard handling of DNSNameMatches.
// If WildcardMatchType is WILDCARD_PARTIAL_MATCH "*.bar.com" is considered to
// match the constraint "foo.bar.com". If it is WILDCARD_FULL_MATCH, "*.bar.com"
// will match "bar.com" but not "foo.bar.com".
enum WildcardMatchType { WILDCARD_PARTIAL_MATCH, WILDCARD_FULL_MATCH };

// Returns true if |name| falls in the subtree defined by |dns_constraint|.
// RFC 5280 section 4.2.1.10:
// DNS name restrictions are expressed as host.example.com. Any DNS
// name that can be constructed by simply adding zero or more labels
// to the left-hand side of the name satisfies the name constraint. For
// example, www.host.example.com would satisfy the constraint but
// host1.example.com would not.
//
// |wildcard_matching| controls handling of wildcard names (|name| starts with
// "*."). Wildcard handling is not specified by RFC 5280, but certificate
// verification allows it, name constraints must check it similarly.
bool DNSNameMatches(std::string_view name, std::string_view dns_constraint,
                    WildcardMatchType wildcard_matching) {
  // Everything matches the empty DNS name constraint.
  if (dns_constraint.empty()) {
    return true;
  }

  // Normalize absolute DNS names by removing the trailing dot, if any.
  if (!name.empty() && *name.rbegin() == '.') {
    name.remove_suffix(1);
  }
  if (!dns_constraint.empty() && *dns_constraint.rbegin() == '.') {
    dns_constraint.remove_suffix(1);
  }

  // Wildcard partial-match handling ("*.bar.com" matching name constraint
  // "foo.bar.com"). This only handles the case where the the dnsname and the
  // constraint match after removing the leftmost label, otherwise it is handled
  // by falling through to the check of whether the dnsname is fully within or
  // fully outside of the constraint.
  if (wildcard_matching == WILDCARD_PARTIAL_MATCH && name.size() > 2 &&
      name[0] == '*' && name[1] == '.') {
    size_t dns_constraint_dot_pos = dns_constraint.find('.');
    if (dns_constraint_dot_pos != std::string::npos) {
      std::string_view dns_constraint_domain =
          dns_constraint.substr(dns_constraint_dot_pos + 1);
      std::string_view wildcard_domain = name.substr(2);
      if (bssl::string_util::IsEqualNoCase(wildcard_domain,
                                           dns_constraint_domain)) {
        return true;
      }
    }
  }

  if (!bssl::string_util::EndsWithNoCase(name, dns_constraint)) {
    return false;
  }

  // Exact match.
  if (name.size() == dns_constraint.size()) {
    return true;
  }
  // If dNSName constraint starts with a dot, only subdomains should match.
  // (e.g., "foo.bar.com" matches constraint ".bar.com", but "bar.com" doesn't.)
  // RFC 5280 is ambiguous, but this matches the behavior of other platforms.
  if (!dns_constraint.empty() && dns_constraint[0] == '.') {
    dns_constraint.remove_prefix(1);
  }
  // Subtree match.
  if (name.size() > dns_constraint.size() &&
      name[name.size() - dns_constraint.size() - 1] == '.') {
    return true;
  }
  // Trailing text matches, but not in a subtree (e.g., "foobar.com" is not a
  // match for "bar.com").
  return false;
}

// Parses a GeneralSubtrees |value| and store the contents in |subtrees|.
// The individual values stored into |subtrees| are not validated by this
// function.
// NOTE: |subtrees| is not pre-initialized by the function(it is expected to be
// a default initialized object), and it will be modified regardless of the
// return value.
[[nodiscard]] bool ParseGeneralSubtrees(der::Input value,
                                        GeneralNames *subtrees,
                                        CertErrors *errors) {
  BSSL_CHECK(errors);

  // GeneralSubtrees ::= SEQUENCE SIZE (1..MAX) OF GeneralSubtree
  //
  // GeneralSubtree ::= SEQUENCE {
  //      base                    GeneralName,
  //      minimum         [0]     BaseDistance DEFAULT 0,
  //      maximum         [1]     BaseDistance OPTIONAL }
  //
  // BaseDistance ::= INTEGER (0..MAX)
  der::Parser sequence_parser(value);
  // The GeneralSubtrees sequence should have at least 1 element.
  if (!sequence_parser.HasMore()) {
    return false;
  }
  while (sequence_parser.HasMore()) {
    der::Parser subtree_sequence;
    if (!sequence_parser.ReadSequence(&subtree_sequence)) {
      return false;
    }

    der::Input raw_general_name;
    if (!subtree_sequence.ReadRawTLV(&raw_general_name)) {
      return false;
    }

    if (!ParseGeneralName(raw_general_name,
                          GeneralNames::IP_ADDRESS_AND_NETMASK, subtrees,
                          errors)) {
      errors->AddError(kFailedParsingGeneralName);
      return false;
    }

    // RFC 5280 section 4.2.1.10:
    // Within this profile, the minimum and maximum fields are not used with any
    // name forms, thus, the minimum MUST be zero, and maximum MUST be absent.
    // However, if an application encounters a critical name constraints
    // extension that specifies other values for minimum or maximum for a name
    // form that appears in a subsequent certificate, the application MUST
    // either process these fields or reject the certificate.

    // Note that technically failing here isn't required: rather only need to
    // fail if a name of this type actually appears in a subsequent cert and
    // this extension was marked critical. However the minimum and maximum
    // fields appear uncommon enough that implementing that isn't useful.
    if (subtree_sequence.HasMore()) {
      return false;
    }
  }
  return true;
}

bool IsAlphaDigit(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
         (c >= 'A' && c <= 'Z');
}

// Returns true if 'local_part' contains only characters that are valid in a
// non-quoted mailbox local-part. Does not check any other part of the syntax
// requirements. Does not allow whitespace.
bool IsAllowedRfc822LocalPart(std::string_view local_part) {
  if (local_part.empty()) {
    return false;
  }
  for (char c : local_part) {
    if (!(IsAlphaDigit(c) || c == '!' || c == '#' || c == '$' || c == '%' ||
          c == '&' || c == '\'' || c == '*' || c == '+' || c == '-' ||
          c == '/' || c == '=' || c == '?' || c == '^' || c == '_' ||
          c == '`' || c == '{' || c == '|' || c == '}' || c == '~' ||
          c == '.')) {
      return false;
    }
  }
  return true;
}

// Returns true if 'domain' contains only characters that are valid in a
// mailbox domain. Does not check any other part of the syntax
// requirements. Does not allow IPv6-address-literal as text IPv6 addresses are
// non-unique. Does not allow other address literals either as how to handle
// them with domain/subdomain matching isn't specified/possible.
bool IsAllowedRfc822Domain(std::string_view domain) {
  if (domain.empty()) {
    return false;
  }
  for (char c : domain) {
    if (!(IsAlphaDigit(c) || c == '-' || c == '.')) {
      return false;
    }
  }
  return true;
}

enum class Rfc822NameMatchType { kPermitted, kExcluded };
bool Rfc822NameMatches(std::string_view local_part, std::string_view domain,
                       std::string_view rfc822_constraint,
                       Rfc822NameMatchType match_type,
                       bool case_insensitive_local_part) {
  // In case of parsing errors, return a value that will cause the name to not
  // be permitted.
  const bool error_value =
      match_type == Rfc822NameMatchType::kPermitted ? false : true;

  std::vector<std::string_view> constraint_components =
      bssl::string_util::SplitString(rfc822_constraint, '@');
  std::string_view constraint_local_part;
  std::string_view constraint_domain;
  if (constraint_components.size() == 1) {
    constraint_domain = constraint_components[0];
  } else if (constraint_components.size() == 2) {
    constraint_local_part = constraint_components[0];
    if (!IsAllowedRfc822LocalPart(constraint_local_part)) {
      return error_value;
    }
    constraint_domain = constraint_components[1];
  } else {
    // If we did the full parsing then it is possible for a @ to be in a quoted
    // local-part of the name, but we don't do that, so just error if @ appears
    // more than once.
    return error_value;
  }
  if (!IsAllowedRfc822Domain(constraint_domain)) {
    return error_value;
  }

  // RFC 5280 section 4.2.1.10:
  // To indicate a particular mailbox, the constraint is the complete mail
  // address.  For example, "root@example.com" indicates the root mailbox on
  // the host "example.com".
  if (!constraint_local_part.empty()) {
    return (case_insensitive_local_part
                ? string_util::IsEqualNoCase(local_part, constraint_local_part)
                : local_part == constraint_local_part) &&
           string_util::IsEqualNoCase(domain, constraint_domain);
  }

  // RFC 5280 section 4.2.1.10:
  // To specify any address within a domain, the constraint is specified with a
  // leading period (as with URIs).  For example, ".example.com" indicates all
  // the Internet mail addresses in the domain "example.com", but not Internet
  // mail addresses on the host "example.com".
  if (!constraint_domain.empty() && constraint_domain[0] == '.') {
    return string_util::EndsWithNoCase(domain, constraint_domain);
  }

  // RFC 5280 section 4.2.1.10:
  // To indicate all Internet mail addresses on a particular host, the
  // constraint is specified as the host name.  For example, the constraint
  // "example.com" is satisfied by any mail address at the host "example.com".
  return string_util::IsEqualNoCase(domain, constraint_domain);
}

}  // namespace

NameConstraints::~NameConstraints() = default;

// static
std::unique_ptr<NameConstraints> NameConstraints::Create(
    der::Input extension_value, bool is_critical, CertErrors *errors) {
  BSSL_CHECK(errors);

  auto name_constraints = std::make_unique<NameConstraints>();
  if (!name_constraints->Parse(extension_value, is_critical, errors)) {
    return nullptr;
  }
  return name_constraints;
}

std::unique_ptr<NameConstraints> NameConstraints::CreateFromPermittedSubtrees(
    GeneralNames permitted_subtrees) {
  auto name_constraints = std::make_unique<NameConstraints>();

  name_constraints->constrained_name_types_ =
      permitted_subtrees.present_name_types;
  name_constraints->permitted_subtrees_ = std::move(permitted_subtrees);

  return name_constraints;
}

bool NameConstraints::Parse(der::Input extension_value, bool is_critical,
                            CertErrors *errors) {
  BSSL_CHECK(errors);

  der::Parser extension_parser(extension_value);
  der::Parser sequence_parser;

  // NameConstraints ::= SEQUENCE {
  //      permittedSubtrees       [0]     GeneralSubtrees OPTIONAL,
  //      excludedSubtrees        [1]     GeneralSubtrees OPTIONAL }
  if (!extension_parser.ReadSequence(&sequence_parser)) {
    return false;
  }
  if (extension_parser.HasMore()) {
    return false;
  }

  std::optional<der::Input> permitted_subtrees_value;
  if (!sequence_parser.ReadOptionalTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0,
          &permitted_subtrees_value)) {
    return false;
  }
  if (permitted_subtrees_value &&
      !ParseGeneralSubtrees(permitted_subtrees_value.value(),
                            &permitted_subtrees_, errors)) {
    return false;
  }
  constrained_name_types_ |=
      permitted_subtrees_.present_name_types &
      (is_critical ? GENERAL_NAME_ALL_TYPES : kSupportedNameTypes);

  std::optional<der::Input> excluded_subtrees_value;
  if (!sequence_parser.ReadOptionalTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 1,
          &excluded_subtrees_value)) {
    return false;
  }
  if (excluded_subtrees_value &&
      !ParseGeneralSubtrees(excluded_subtrees_value.value(),
                            &excluded_subtrees_, errors)) {
    return false;
  }
  constrained_name_types_ |=
      excluded_subtrees_.present_name_types &
      (is_critical ? GENERAL_NAME_ALL_TYPES : kSupportedNameTypes);

  // RFC 5280 section 4.2.1.10:
  // Conforming CAs MUST NOT issue certificates where name constraints is an
  // empty sequence. That is, either the permittedSubtrees field or the
  // excludedSubtrees MUST be present.
  if (!permitted_subtrees_value && !excluded_subtrees_value) {
    return false;
  }

  if (sequence_parser.HasMore()) {
    return false;
  }

  return true;
}

void NameConstraints::IsPermittedCert(der::Input subject_rdn_sequence,
                                      const GeneralNames *subject_alt_names,
                                      CertErrors *errors) const {
  // Checking NameConstraints is O(number_of_names * number_of_constraints).
  // Impose a hard limit to mitigate the use of name constraints as a DoS
  // mechanism. This mimics the similar check in BoringSSL x509/v_ncons.c
  // TODO(bbe): make both name constraint mechanisms subquadratic and remove
  // this check.

  const size_t kMaxChecks = 1048576;  // 1 << 20

  // Names all come from a certificate, which is bound by size_t, so adding them
  // up can not overflow a size_t.
  size_t name_count = 0;
  // Constraints all come from a certificate, which is bound by a size_t, so
  // adding them up can not overflow a size_t.
  size_t constraint_count = 0;
  if (subject_alt_names) {
    name_count = subject_alt_names->rfc822_names.size() +
                 subject_alt_names->dns_names.size() +
                 subject_alt_names->directory_names.size() +
                 subject_alt_names->ip_addresses.size();
    constraint_count = excluded_subtrees_.rfc822_names.size() +
                       permitted_subtrees_.rfc822_names.size() +
                       excluded_subtrees_.dns_names.size() +
                       permitted_subtrees_.dns_names.size() +
                       excluded_subtrees_.directory_names.size() +
                       permitted_subtrees_.directory_names.size() +
                       excluded_subtrees_.ip_address_ranges.size() +
                       permitted_subtrees_.ip_address_ranges.size();
  } else {
    constraint_count += excluded_subtrees_.directory_names.size() +
                        permitted_subtrees_.directory_names.size();
    name_count = subject_rdn_sequence.size();
  }
  // Upper bound the number of possible checks, checking for overflow.
  size_t check_count = constraint_count * name_count;
  if ((constraint_count > 0 && check_count / constraint_count != name_count) ||
      check_count > kMaxChecks) {
    errors->AddError(cert_errors::kTooManyNameConstraintChecks);
    return;
  }

  std::vector<std::string> subject_email_addresses_to_check;
  if (!subject_alt_names &&
      (constrained_name_types() & GENERAL_NAME_RFC822_NAME)) {
    if (!FindEmailAddressesInName(subject_rdn_sequence,
                                  &subject_email_addresses_to_check)) {
      // Error parsing |subject_rdn_sequence|.
      errors->AddError(cert_errors::kNotPermittedByNameConstraints);
      return;
    }
  }

  // Subject Alternative Name handling:
  //
  // RFC 5280 section 4.2.1.6:
  // id-ce-subjectAltName OBJECT IDENTIFIER ::=  { id-ce 17 }
  //
  // SubjectAltName ::= GeneralNames
  //
  // GeneralNames ::= SEQUENCE SIZE (1..MAX) OF GeneralName

  if (subject_alt_names) {
    // Check unsupported name types:
    // constrained_name_types() for the unsupported types will only be true if
    // that type of name was present in a name constraint that was marked
    // critical.
    //
    // RFC 5280 section 4.2.1.10:
    // If a name constraints extension that is marked as critical
    // imposes constraints on a particular name form, and an instance of
    // that name form appears in the subject field or subjectAltName
    // extension of a subsequent certificate, then the application MUST
    // either process the constraint or reject the certificate.
    if (constrained_name_types() & subject_alt_names->present_name_types &
        ~kSupportedNameTypes) {
      errors->AddError(cert_errors::kNotPermittedByNameConstraints);
      return;
    }

    // Check supported name types:

    // Only check rfc822 SANs if any rfc822 constraints are present, since we
    // might fail if there are email addresses we don't know how to parse but
    // are technically correct.
    if (constrained_name_types() & GENERAL_NAME_RFC822_NAME) {
      for (const auto &rfc822_name : subject_alt_names->rfc822_names) {
        if (!IsPermittedRfc822Name(
                rfc822_name, /*case_insensitive_exclude_localpart=*/false)) {
          errors->AddError(cert_errors::kNotPermittedByNameConstraints);
          return;
        }
      }
    }

    for (const auto &dns_name : subject_alt_names->dns_names) {
      if (!IsPermittedDNSName(dns_name)) {
        errors->AddError(cert_errors::kNotPermittedByNameConstraints);
        return;
      }
    }

    for (const auto &directory_name : subject_alt_names->directory_names) {
      if (!IsPermittedDirectoryName(directory_name)) {
        errors->AddError(cert_errors::kNotPermittedByNameConstraints);
        return;
      }
    }

    for (const auto &ip_address : subject_alt_names->ip_addresses) {
      if (!IsPermittedIP(ip_address)) {
        errors->AddError(cert_errors::kNotPermittedByNameConstraints);
        return;
      }
    }
  }

  // Subject handling:

  // RFC 5280 section 4.2.1.10:
  // Legacy implementations exist where an electronic mail address is embedded
  // in the subject distinguished name in an attribute of type emailAddress
  // (Section 4.1.2.6). When constraints are imposed on the rfc822Name name
  // form, but the certificate does not include a subject alternative name, the
  // rfc822Name constraint MUST be applied to the attribute of type emailAddress
  // in the subject distinguished name.
  for (const auto &rfc822_name : subject_email_addresses_to_check) {
    // Whether local_part should be matched case-sensitive or not is somewhat
    // unclear. RFC 2821 says that it should be case-sensitive. RFC 2985 says
    // that emailAddress attributes in a Name are fully case-insensitive.
    // Some other verifier implementations always do local-part comparison
    // case-sensitive, while some always do it case-insensitive. Many but not
    // all SMTP servers interpret addresses as case-insensitive.
    //
    // Give how poorly specified this is, and the conflicting implementations
    // in the wild, this implementation will do case-insensitive match for
    // excluded names from the subject to avoid potentially allowing
    // something that wasn't expected.
    if (!IsPermittedRfc822Name(rfc822_name,
                               /*case_insensitive_exclude_localpart=*/true)) {
      errors->AddError(cert_errors::kNotPermittedByNameConstraints);
      return;
    }
  }

  // RFC 5280 4.1.2.6:
  // If subject naming information is present only in the subjectAltName
  // extension (e.g., a key bound only to an email address or URI), then the
  // subject name MUST be an empty sequence and the subjectAltName extension
  // MUST be critical.
  // This code assumes that criticality condition is checked by the caller, and
  // therefore only needs to avoid the IsPermittedDirectoryName check against an
  // empty subject in such a case.
  if (subject_alt_names && subject_rdn_sequence.empty()) {
    return;
  }

  if (!IsPermittedDirectoryName(subject_rdn_sequence)) {
    errors->AddError(cert_errors::kNotPermittedByNameConstraints);
    return;
  }
}

bool NameConstraints::IsPermittedRfc822Name(
    std::string_view name, bool case_insensitive_exclude_localpart) const {
  // RFC 5280 4.2.1.6.  Subject Alternative Name
  //
  // When the subjectAltName extension contains an Internet mail address,
  // the address MUST be stored in the rfc822Name.  The format of an
  // rfc822Name is a "Mailbox" as defined in Section 4.1.2 of [RFC2821].
  // A Mailbox has the form "Local-part@Domain".  Note that a Mailbox has
  // no phrase (such as a common name) before it, has no comment (text
  // surrounded in parentheses) after it, and is not surrounded by "<" and
  // ">".  Rules for encoding Internet mail addresses that include
  // internationalized domain names are specified in Section 7.5.

  // Relevant parts from RFC 2821 & RFC 2822
  //
  // Mailbox = Local-part "@" Domain
  // Local-part = Dot-string / Quoted-string
  //       ; MAY be case-sensitive
  //
  // Dot-string = Atom *("." Atom)
  // Atom = 1*atext
  // Quoted-string = DQUOTE *qcontent DQUOTE
  //
  //
  // atext           =       ALPHA / DIGIT / ; Any character except controls,
  //                         "!" / "#" /     ;  SP, and specials.
  //                         "$" / "%" /     ;  Used for atoms
  //                         "&" / "'" /
  //                         "*" / "+" /
  //                         "-" / "/" /
  //                         "=" / "?" /
  //                         "^" / "_" /
  //                         "`" / "{" /
  //                         "|" / "}" /
  //                         "~"
  //
  // atom            =       [CFWS] 1*atext [CFWS]
  //
  //
  // qtext           =       NO-WS-CTL /     ; Non white space controls
  //                         %d33 /          ; The rest of the US-ASCII
  //                         %d35-91 /       ;  characters not including "\"
  //                         %d93-126        ;  or the quote character
  //
  // quoted-pair     =       ("\" text) / obs-qp
  // qcontent        =       qtext / quoted-pair
  //
  //
  // Domain = (sub-domain 1*("." sub-domain)) / address-literal
  // sub-domain = Let-dig [Ldh-str]
  //
  // Let-dig = ALPHA / DIGIT
  // Ldh-str = *( ALPHA / DIGIT / "-" ) Let-dig
  //
  // address-literal = "[" IPv4-address-literal /
  //                       IPv6-address-literal /
  //                       General-address-literal "]"
  //       ; See section 4.1.3

  // However, no one actually implements all that. Known implementations just
  // do string comparisons, but that is technically incorrect. (Ex: a
  // constraint excluding |foo@example.com| should exclude a SAN of
  // |"foo"@example.com|, while a naive direct comparison will allow it.)
  //
  // We don't implement all that either, but do something a bit more fail-safe
  // by rejecting any addresses that contain characters that are not allowed in
  // the non-quoted formats.

  std::vector<std::string_view> name_components =
      bssl::string_util::SplitString(name, '@');
  if (name_components.size() != 2) {
    // If we did the full parsing then it is possible for a @ to be in a quoted
    // local-part of the name, but we don't do that, so just fail if @ appears
    // more than once.
    return false;
  }
  if (!IsAllowedRfc822LocalPart(name_components[0]) ||
      !IsAllowedRfc822Domain(name_components[1])) {
    return false;
  }

  for (const auto &excluded_name : excluded_subtrees_.rfc822_names) {
    if (Rfc822NameMatches(name_components[0], name_components[1], excluded_name,
                          Rfc822NameMatchType::kExcluded,
                          case_insensitive_exclude_localpart)) {
      return false;
    }
  }

  // If permitted subtrees are not constrained, any name that is not excluded is
  // allowed.
  if (!(permitted_subtrees_.present_name_types & GENERAL_NAME_RFC822_NAME)) {
    return true;
  }

  for (const auto &permitted_name : permitted_subtrees_.rfc822_names) {
    if (Rfc822NameMatches(name_components[0], name_components[1],
                          permitted_name, Rfc822NameMatchType::kPermitted,
                          /*case_insenitive_local_part=*/false)) {
      return true;
    }
  }

  return false;
}

bool NameConstraints::IsPermittedDNSName(std::string_view name) const {
  for (const auto &excluded_name : excluded_subtrees_.dns_names) {
    // When matching wildcard hosts against excluded subtrees, consider it a
    // match if the constraint would match any expansion of the wildcard. Eg,
    // *.bar.com should match a constraint of foo.bar.com.
    if (DNSNameMatches(name, excluded_name, WILDCARD_PARTIAL_MATCH)) {
      return false;
    }
  }

  // If permitted subtrees are not constrained, any name that is not excluded is
  // allowed.
  if (!(permitted_subtrees_.present_name_types & GENERAL_NAME_DNS_NAME)) {
    return true;
  }

  for (const auto &permitted_name : permitted_subtrees_.dns_names) {
    // When matching wildcard hosts against permitted subtrees, consider it a
    // match only if the constraint would match all expansions of the wildcard.
    // Eg, *.bar.com should match a constraint of bar.com, but not foo.bar.com.
    if (DNSNameMatches(name, permitted_name, WILDCARD_FULL_MATCH)) {
      return true;
    }
  }

  return false;
}

bool NameConstraints::IsPermittedDirectoryName(
    der::Input name_rdn_sequence) const {
  for (const auto &excluded_name : excluded_subtrees_.directory_names) {
    if (VerifyNameInSubtree(name_rdn_sequence, excluded_name)) {
      return false;
    }
  }

  // If permitted subtrees are not constrained, any name that is not excluded is
  // allowed.
  if (!(permitted_subtrees_.present_name_types & GENERAL_NAME_DIRECTORY_NAME)) {
    return true;
  }

  for (const auto &permitted_name : permitted_subtrees_.directory_names) {
    if (VerifyNameInSubtree(name_rdn_sequence, permitted_name)) {
      return true;
    }
  }

  return false;
}

bool NameConstraints::IsPermittedIP(der::Input ip) const {
  for (const auto &excluded_ip : excluded_subtrees_.ip_address_ranges) {
    if (IPAddressMatchesWithNetmask(ip, excluded_ip.first,
                                    excluded_ip.second)) {
      return false;
    }
  }

  // If permitted subtrees are not constrained, any name that is not excluded is
  // allowed.
  if (!(permitted_subtrees_.present_name_types & GENERAL_NAME_IP_ADDRESS)) {
    return true;
  }

  for (const auto &permitted_ip : permitted_subtrees_.ip_address_ranges) {
    if (IPAddressMatchesWithNetmask(ip, permitted_ip.first,
                                    permitted_ip.second)) {
      return true;
    }
  }

  return false;
}

BSSL_NAMESPACE_END
