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

#include <array>
#include <memory>

#include <gtest/gtest.h>

#include <openssl/span.h>

#include "common_cert_errors.h"
#include "test_helpers.h"

BSSL_NAMESPACE_BEGIN
namespace {

::testing::AssertionResult LoadTestData(const char *token,
                                        const std::string &basename,
                                        std::string *result) {
  std::string path = "testdata/name_constraints_unittest/" + basename;

  const PemBlockMapping mappings[] = {
      {token, result},
  };

  return ReadTestDataFromPemFile(path, mappings);
}

::testing::AssertionResult LoadTestName(const std::string &basename,
                                        std::string *result) {
  return LoadTestData("NAME", basename, result);
}

::testing::AssertionResult LoadTestNameConstraint(const std::string &basename,
                                                  std::string *result) {
  return LoadTestData("NAME CONSTRAINTS", basename, result);
}

::testing::AssertionResult LoadTestSubjectAltNameData(
    const std::string &basename, std::string *result) {
  return LoadTestData("SUBJECT ALTERNATIVE NAME", basename, result);
}

::testing::AssertionResult LoadTestSubjectAltName(
    const std::string &basename, std::unique_ptr<GeneralNames> *result,
    std::string *result_der) {
  ::testing::AssertionResult load_result =
      LoadTestSubjectAltNameData(basename, result_der);
  if (!load_result) {
    return load_result;
  }
  CertErrors errors;
  *result = GeneralNames::Create(StringAsBytes(*result_der), &errors);
  if (!*result) {
    return ::testing::AssertionFailure() << "Create failed";
  }
  return ::testing::AssertionSuccess();
}

::testing::AssertionResult IsPermittedCert(
    const NameConstraints *name_constraints, der::Input subject_rdn_sequence,
    const GeneralNames *subject_alt_names) {
  CertErrors errors;
  name_constraints->IsPermittedCert(subject_rdn_sequence, subject_alt_names,
                                    &errors);
  if (!errors.ContainsAnyErrorWithSeverity(CertError::SEVERITY_HIGH)) {
    return ::testing::AssertionSuccess();
  }
  if (!errors.ContainsError(cert_errors::kNotPermittedByNameConstraints)) {
    ADD_FAILURE() << "unexpected error " << errors.ToDebugString();
  }
  return ::testing::AssertionFailure();
}

std::array<uint8_t, 4> IPAddress(uint8_t b0, uint8_t b1, uint8_t b2,
                                 uint8_t b3) {
  return {b0, b1, b2, b3};
}
std::array<uint8_t, 16> IPAddress(uint8_t b0, uint8_t b1, uint8_t b2,
                                  uint8_t b3, uint8_t b4, uint8_t b5,
                                  uint8_t b6, uint8_t b7, uint8_t b8,
                                  uint8_t b9, uint8_t b10, uint8_t b11,
                                  uint8_t b12, uint8_t b13, uint8_t b14,
                                  uint8_t b15) {
  return {b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13, b14, b15};
}

}  // namespace

class ParseNameConstraints
    : public ::testing::TestWithParam<::testing::tuple<bool>> {
 public:
  bool is_critical() const { return ::testing::get<0>(GetParam()); }
};

// Run the tests with the name constraints marked critical and non-critical. For
// supported name types, the results should be the same for both.
INSTANTIATE_TEST_SUITE_P(InstantiationName, ParseNameConstraints,
                         ::testing::Values(true, false));

TEST_P(ParseNameConstraints, DNSNames) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("dnsname.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_TRUE(name_constraints->IsPermittedDNSName("permitted.example.com"));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("permitted.example.com."));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("a.permitted.example.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("apermitted.example.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("apermitted.example.com."));
  EXPECT_TRUE(
      name_constraints->IsPermittedDNSName("alsopermitted.example.com"));
  EXPECT_FALSE(
      name_constraints->IsPermittedDNSName("excluded.permitted.example.com"));
  EXPECT_FALSE(
      name_constraints->IsPermittedDNSName("a.excluded.permitted.example.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName(
      "stillnotpermitted.excluded.permitted.example.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName(
      "a.stillnotpermitted.excluded.permitted.example.com"));
  EXPECT_FALSE(
      name_constraints->IsPermittedDNSName("extraneousexclusion.example.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName(
      "a.extraneousexclusion.example.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("other.example.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("other.com"));

  // Wildcard names:
  // Pattern could match excluded.permitted.example.com, thus should not be
  // allowed.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("*.permitted.example.com"));
  // Entirely within excluded name, obviously not allowed.
  EXPECT_FALSE(
      name_constraints->IsPermittedDNSName("*.excluded.permitted.example.com"));
  // Within permitted.example.com and cannot match any exclusion, thus these are
  // allowed.
  EXPECT_TRUE(
      name_constraints->IsPermittedDNSName("*.foo.permitted.example.com"));
  EXPECT_TRUE(
      name_constraints->IsPermittedDNSName("*.alsopermitted.example.com"));
  // Matches permitted.example2.com, but also matches other .example2.com names
  // which are not in either permitted or excluded, so not allowed.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("*.example2.com"));
  // Partial wildcards are not supported, so these name are permitted even if
  // it seems like they shouldn't be. It's fine, since certificate verification
  // won't treat them as wildcard names either.
  EXPECT_TRUE(
      name_constraints->IsPermittedDNSName("*xcluded.permitted.example.com"));
  EXPECT_TRUE(
      name_constraints->IsPermittedDNSName("exclude*.permitted.example.com"));
  EXPECT_TRUE(
      name_constraints->IsPermittedDNSName("excl*ded.permitted.example.com"));
  // Garbage wildcard data.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("*."));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("*.*"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName(".*"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("*"));
  // Matches SAN with trailing dot.
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("permitted.example3.com"));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("permitted.example3.com."));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("a.permitted.example3.com"));
  EXPECT_TRUE(
      name_constraints->IsPermittedDNSName("a.permitted.example3.com."));

  EXPECT_EQ(GENERAL_NAME_DNS_NAME, name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-permitted.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-excluded-dnsname.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-excluded-directoryname.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-excluded-ipaddress.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints,
       DNSNamesWithMultipleLevelsBetweenExcludedAndPermitted) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("dnsname2.pem", &a));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // Matches permitted exactly.
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("com"));
  // Contained within permitted and doesn't match excluded (foo.bar.com).
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("bar.com"));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("baz.bar.com"));
  // Matches excluded exactly.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("foo.bar.com"));
  // Contained within excluded.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("baz.foo.bar.com"));

  // Cannot match anything within excluded.
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("*.baz.bar.com"));
  // Wildcard hostnames only match a single label, so cannot match excluded
  // which has two labels before .com.
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("*.com"));

  // Partial match of foo.bar.com.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("*.bar.com"));
  // All expansions of wildcard are within excluded.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("*.foo.bar.com"));
}

TEST_P(ParseNameConstraints, DNSNamesPermittedWithLeadingDot) {
  std::string a;
  ASSERT_TRUE(
      LoadTestNameConstraint("dnsname-permitted_with_leading_dot.pem", &a));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // A permitted dNSName constraint of ".bar.com" should only match subdomains
  // of .bar.com, but not bar.com itself.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("bar.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("foobar.com"));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("foo.bar.com"));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("*.bar.com"));
}

TEST_P(ParseNameConstraints, DNSNamesExcludedWithLeadingDot) {
  std::string a;
  ASSERT_TRUE(
      LoadTestNameConstraint("dnsname-excluded_with_leading_dot.pem", &a));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // An excluded dNSName constraint of ".bar.com" should only match subdomains
  // of .bar.com, but not bar.com itself.
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("com"));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("bar.com"));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("foobar.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("foo.bar.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("*.bar.com"));
}

TEST_P(ParseNameConstraints, DNSNamesPermittedTwoDot) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("dnsname-permitted_two_dot.pem", &a));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // A dNSName constraint of ".." isn't meaningful. Shouldn't match anything.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("com."));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("foo.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("*.com"));
}

TEST_P(ParseNameConstraints, DNSNamesExcludeOnly) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("dnsname-excluded.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // Only "excluded.permitted.example.com" is excluded, and since permitted is
  // empty, any dNSName outside that is allowed.
  EXPECT_TRUE(name_constraints->IsPermittedDNSName(""));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("foo.com"));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("permitted.example.com"));
  EXPECT_FALSE(
      name_constraints->IsPermittedDNSName("excluded.permitted.example.com"));
  EXPECT_FALSE(
      name_constraints->IsPermittedDNSName("a.excluded.permitted.example.com"));
}

TEST_P(ParseNameConstraints, DNSNamesExcludeAll) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("dnsname-excludeall.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // "permitted.example.com" is in the permitted section, but since "" is
  // excluded, nothing is permitted.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName(""));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("foo.com"));
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("permitted.example.com"));
  EXPECT_FALSE(
      name_constraints->IsPermittedDNSName("foo.permitted.example.com"));
}

TEST_P(ParseNameConstraints, DNSNamesExcludeDot) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("dnsname-exclude_dot.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // "." is excluded, which should match nothing.
  EXPECT_FALSE(name_constraints->IsPermittedDNSName("foo.com"));
  EXPECT_TRUE(name_constraints->IsPermittedDNSName("permitted.example.com"));
  EXPECT_TRUE(
      name_constraints->IsPermittedDNSName("foo.permitted.example.com"));
}

TEST_P(ParseNameConstraints, DNSNamesFailOnInvalidIA5String) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("dnsname.pem", &a));

  size_t replace_location = a.find("permitted.example2.com");
  ASSERT_NE(std::string::npos, replace_location);
  a.replace(replace_location, 1, 1, -1);

  CertErrors errors;
  EXPECT_FALSE(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
}

TEST_P(ParseNameConstraints, DirectoryNames) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("directoryname.pem", &constraints_der));

  std::string name_us;
  ASSERT_TRUE(LoadTestName("name-us.pem", &name_us));
  std::string name_us_ca;
  ASSERT_TRUE(LoadTestName("name-us-california.pem", &name_us_ca));
  std::string name_us_ca_mountain_view;
  ASSERT_TRUE(LoadTestName("name-us-california-mountain_view.pem",
                           &name_us_ca_mountain_view));
  std::string name_us_az;
  ASSERT_TRUE(LoadTestName("name-us-arizona.pem", &name_us_az));
  std::string name_jp;
  ASSERT_TRUE(LoadTestName("name-jp.pem", &name_jp));
  std::string name_jp_tokyo;
  ASSERT_TRUE(LoadTestName("name-jp-tokyo.pem", &name_jp_tokyo));
  std::string name_de;
  ASSERT_TRUE(LoadTestName("name-de.pem", &name_de));
  std::string name_ca;
  ASSERT_TRUE(LoadTestName("name-ca.pem", &name_ca));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // Not in any permitted subtree.
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_ca)));
  // Within the permitted C=US subtree.
  EXPECT_TRUE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_us)));
  // Within the permitted C=US subtree.
  EXPECT_TRUE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_us_az)));
  // Within the permitted C=US subtree, however the excluded C=US,ST=California
  // subtree takes priority.
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_us_ca)));
  // Within the permitted C=US subtree as well as the permitted
  // C=US,ST=California,L=Mountain View subtree, however the excluded
  // C=US,ST=California subtree still takes priority.
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_us_ca_mountain_view)));
  // Not in any permitted subtree, and also inside the extraneous excluded C=DE
  // subtree.
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_de)));
  // Not in any permitted subtree.
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_jp)));
  // Within the permitted C=JP,ST=Tokyo subtree.
  EXPECT_TRUE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_jp_tokyo)));

  EXPECT_EQ(GENERAL_NAME_DIRECTORY_NAME,
            name_constraints->constrained_name_types());

  // Within the permitted C=US subtree.
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name_us),
                              nullptr /* subject_alt_names */));
  // Within the permitted C=US subtree, however the excluded C=US,ST=California
  // subtree takes priority.
  EXPECT_FALSE(IsPermittedCert(name_constraints.get(),
                               SequenceValueFromString(name_us_ca),
                               nullptr /* subject_alt_names */));

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-permitted.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-excluded-dnsname.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-excluded-directoryname.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-excluded-ipaddress.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, DirectoryNamesExcludeOnly) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("directoryname-excluded.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string name_empty;
  ASSERT_TRUE(LoadTestName("name-empty.pem", &name_empty));
  std::string name_us;
  ASSERT_TRUE(LoadTestName("name-us.pem", &name_us));
  std::string name_us_ca;
  ASSERT_TRUE(LoadTestName("name-us-california.pem", &name_us_ca));
  std::string name_us_ca_mountain_view;
  ASSERT_TRUE(LoadTestName("name-us-california-mountain_view.pem",
                           &name_us_ca_mountain_view));

  // Only "C=US,ST=California" is excluded, and since permitted is empty,
  // any directoryName outside that is allowed.
  EXPECT_TRUE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_empty)));
  EXPECT_TRUE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_us)));
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_us_ca)));
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_us_ca_mountain_view)));
}

TEST_P(ParseNameConstraints, DirectoryNamesExcludeAll) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("directoryname-excludeall.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string name_empty;
  ASSERT_TRUE(LoadTestName("name-empty.pem", &name_empty));
  std::string name_us;
  ASSERT_TRUE(LoadTestName("name-us.pem", &name_us));
  std::string name_us_ca;
  ASSERT_TRUE(LoadTestName("name-us-california.pem", &name_us_ca));
  std::string name_us_ca_mountain_view;
  ASSERT_TRUE(LoadTestName("name-us-california-mountain_view.pem",
                           &name_us_ca_mountain_view));
  std::string name_jp;
  ASSERT_TRUE(LoadTestName("name-jp.pem", &name_jp));

  // "C=US" is in the permitted section, but since an empty
  // directoryName is excluded, nothing is permitted.
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_empty)));
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_us)));
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_us_ca)));
  EXPECT_FALSE(name_constraints->IsPermittedDirectoryName(
      SequenceValueFromString(name_jp)));
}

TEST_P(ParseNameConstraints, IPAddresses) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("ipaddress.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // IPv4 tests:

  // Not in any permitted range.
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 169, 0, 1))));

  // Within the permitted 192.168.0.0/255.255.0.0 range.
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 0, 1))));

  // Within the permitted 192.168.0.0/255.255.0.0 range, however the
  // excluded 192.168.5.0/255.255.255.0 takes priority.
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 5, 1))));

  // Within the permitted 192.168.0.0/255.255.0.0 range as well as the
  // permitted 192.168.5.32/255.255.255.224 range, however the excluded
  // 192.168.5.0/255.255.255.0 still takes priority.
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 5, 33))));

  // Not in any permitted range. (Just outside the
  // 192.167.5.32/255.255.255.224 range.)
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 167, 5, 31))));

  // Within the permitted 192.167.5.32/255.255.255.224 range.
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 167, 5, 32))));

  // Within the permitted 192.167.5.32/255.255.255.224 range.
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 167, 5, 63))));

  // Not in any permitted range. (Just outside the
  // 192.167.5.32/255.255.255.224 range.)
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 167, 5, 64))));

  // Not in any permitted range, and also inside the extraneous excluded
  // 192.166.5.32/255.255.255.224 range.
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 166, 5, 32))));

  // IPv6 tests:

  // Not in any permitted range.
  EXPECT_FALSE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 0, 0, 0, 1))));

  // Within the permitted
  // 102:304:506:708:90a:b0c::/ffff:ffff:ffff:ffff:ffff:ffff:: range.
  EXPECT_TRUE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0, 0, 0, 1))));

  // Within the permitted
  // 102:304:506:708:90a:b0c::/ffff:ffff:ffff:ffff:ffff:ffff:: range, however
  // the excluded
  // 102:304:506:708:90a:b0c:500:0/ffff:ffff:ffff:ffff:ffff:ffff:ff00:0 takes
  // priority.
  EXPECT_FALSE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 5, 0, 0, 1))));

  // Within the permitted
  // 102:304:506:708:90a:b0c::/ffff:ffff:ffff:ffff:ffff:ffff:: range as well
  // as the permitted
  // 102:304:506:708:90a:b0c:520:0/ffff:ffff:ffff:ffff:ffff:ffff:ff60:0,
  // however the excluded
  // 102:304:506:708:90a:b0c:500:0/ffff:ffff:ffff:ffff:ffff:ffff:ff00:0 takes
  // priority.
  EXPECT_FALSE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 5, 33, 0, 1))));

  // Not in any permitted range. (Just outside the
  // 102:304:506:708:90a:b0b:520:0/ffff:ffff:ffff:ffff:ffff:ffff:ff60:0
  // range.)
  EXPECT_FALSE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 5, 31, 255, 255))));

  // Within the permitted
  // 102:304:506:708:90a:b0b:520:0/ffff:ffff:ffff:ffff:ffff:ffff:ff60:0 range.
  EXPECT_TRUE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 5, 32, 0, 0))));

  // Within the permitted
  // 102:304:506:708:90a:b0b:520:0/ffff:ffff:ffff:ffff:ffff:ffff:ff60:0 range.
  EXPECT_TRUE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 5, 63, 255, 255))));

  // Not in any permitted range. (Just outside the
  // 102:304:506:708:90a:b0b:520:0/ffff:ffff:ffff:ffff:ffff:ffff:ff60:0
  // range.)
  EXPECT_FALSE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 5, 64, 0, 0))));

  // Not in any permitted range, and also inside the extraneous excluded
  // 102:304:506:708:90a:b0a:520:0/ffff:ffff:ffff:ffff:ffff:ffff:ff60:0 range.
  EXPECT_FALSE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 10, 5, 33, 0, 1))));

  EXPECT_EQ(GENERAL_NAME_IP_ADDRESS,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-permitted.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-excluded-dnsname.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-excluded-directoryname.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-excluded-ipaddress.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, IPAddressesExcludeOnly) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("ipaddress-excluded.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // Only 192.168.5.0/255.255.255.0 is excluded, and since permitted is empty,
  // any iPAddress outside that is allowed.
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 0, 1))));
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 5, 1))));
  EXPECT_TRUE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 0, 0, 0, 1))));
}

TEST_P(ParseNameConstraints, IPAddressesExcludeAll) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("ipaddress-excludeall.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // 192.168.0.0/255.255.0.0 and
  // 102:304:506:708:90a:b0c::/ffff:ffff:ffff:ffff:ffff:ffff:: are permitted,
  // but since 0.0.0.0/0 and ::/0 are excluded nothing is permitted.
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 0, 1))));
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(1, 1, 1, 1))));
  EXPECT_FALSE(name_constraints->IsPermittedIP(
      der::Input(IPAddress(2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1))));
  EXPECT_FALSE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 0, 0, 0, 1))));
}

TEST_P(ParseNameConstraints, IPAddressesNetmaskPermitSingleHost) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("ipaddress-permit_singlehost.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(0, 0, 0, 0))));
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 1))));
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 2))));
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 3))));
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 4))));
  EXPECT_FALSE(name_constraints->IsPermittedIP(
      der::Input(IPAddress(255, 255, 255, 255))));
}

TEST_P(ParseNameConstraints, IPAddressesNetmaskPermitPrefixLen31) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("ipaddress-permit_prefix31.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(0, 0, 0, 0))));
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 1))));
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 2))));
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 3))));
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 4))));
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 5))));
  EXPECT_FALSE(name_constraints->IsPermittedIP(
      der::Input(IPAddress(255, 255, 255, 255))));
}

TEST_P(ParseNameConstraints, IPAddressesNetmaskPermitPrefixLen1) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("ipaddress-permit_prefix1.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(0, 0, 0, 0))));
  EXPECT_FALSE(name_constraints->IsPermittedIP(
      der::Input(IPAddress(0x7F, 0xFF, 0xFF, 0xFF))));
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(0x80, 0, 0, 0))));
  EXPECT_TRUE(name_constraints->IsPermittedIP(
      der::Input(IPAddress(0xFF, 0xFF, 0xFF, 0xFF))));
}

TEST_P(ParseNameConstraints, IPAddressesNetmaskPermitAll) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("ipaddress-permit_all.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(0, 0, 0, 0))));
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 1))));
  EXPECT_TRUE(name_constraints->IsPermittedIP(
      der::Input(IPAddress(255, 255, 255, 255))));
}

TEST_P(ParseNameConstraints, IPAddressesFailOnInvalidAddr) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("ipaddress-invalid_addr.pem", &a));

  CertErrors errors;
  EXPECT_FALSE(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
}

TEST_P(ParseNameConstraints, IPAddressesFailOnInvalidMaskNotContiguous) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint(
      "ipaddress-invalid_mask_not_contiguous_1.pem", &a));
  CertErrors errors;
  EXPECT_FALSE(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));

  ASSERT_TRUE(LoadTestNameConstraint(
      "ipaddress-invalid_mask_not_contiguous_2.pem", &a));
  EXPECT_FALSE(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));

  ASSERT_TRUE(LoadTestNameConstraint(
      "ipaddress-invalid_mask_not_contiguous_3.pem", &a));
  EXPECT_FALSE(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));

  ASSERT_TRUE(LoadTestNameConstraint(
      "ipaddress-invalid_mask_not_contiguous_4.pem", &a));
  EXPECT_FALSE(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
}

// Test that v4/v6 mapping is not applied when evaluating name constraints.
TEST_P(ParseNameConstraints, IPAddressesMapped) {
  std::string a;
  ASSERT_TRUE(LoadTestNameConstraint("ipaddress-mapped_addrs.pem", &a));

  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(
      NameConstraints::Create(StringAsBytes(a), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  // 192.168.1.0/24 is a permitted subtree.
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 0))));
  // This does not cover ::ffff:192.168.1.0.
  EXPECT_FALSE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 192, 168, 1, 0))));
  // 192.168.1.1 is excluded.
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 1))));
  // ::ffff:192.168.1.2 is excluded, but that does not exclude 192.168.1.2.
  EXPECT_TRUE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 1, 2))));

  // ::ffff:192.168.2.0/120 is a permitted subtree.
  EXPECT_TRUE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 192, 168, 2, 0))));
  // This does not cover 192.168.2.0.
  EXPECT_FALSE(
      name_constraints->IsPermittedIP(der::Input(IPAddress(192, 168, 2, 0))));
  // ::ffff:192.168.2.1 is excluded.
  EXPECT_FALSE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 192, 168, 2, 1))));
  // 192.168.2.2 is excluded, but that does not exclude ::ffff:192.168.2.2.
  EXPECT_TRUE(name_constraints->IsPermittedIP(der::Input(
      IPAddress(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 192, 168, 2, 2))));
}

TEST_P(ParseNameConstraints, OtherNamesInPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("othername-permitted.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  if (is_critical()) {
    EXPECT_EQ(GENERAL_NAME_OTHER_NAME,
              name_constraints->constrained_name_types());
  } else {
    EXPECT_EQ(0, name_constraints->constrained_name_types());
  }

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-othername.pem", &san, &san_der));
  EXPECT_EQ(!is_critical(),
            IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, OtherNamesInExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("othername-excluded.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  if (is_critical()) {
    EXPECT_EQ(GENERAL_NAME_OTHER_NAME,
              name_constraints->constrained_name_types());
  } else {
    EXPECT_EQ(0, name_constraints->constrained_name_types());
  }

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-othername.pem", &san, &san_der));
  EXPECT_EQ(!is_critical(),
            IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NamesInPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("rfc822name-permitted.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-domaincase.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-localpartcase.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-subdomain.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-no-at.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-two-ats.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-quoted.pem", &san, &san_der));
  // `"foo"@example.com` and `foo@example.com` are the same address, but we
  // don't support quoted address at all.
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-ipv4.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-multiple.pem", &san, &san_der));
  // SAN contains multiple email addresses, only the first matches the
  // permitted constraint.
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NamesInExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("rfc822name-excluded.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-domaincase.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-localpartcase.pem", &san,
                                     &san_der));
  // Excluded names are matched case-sensitive in the local-part for addresses
  // from subjectAlternativeName, so this is allowed.
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-subdomain.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-no-at.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-two-ats.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-ipv4.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NameHostnameInPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-permitted-hostname.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-domaincase.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-localpartcase.pem", &san,
                                     &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-subdomain.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-no-at.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-two-ats.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-empty-localpart.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-quoted.pem", &san, &san_der));
  // `"foo"@example.com` would match `example.com` hostname, but we don't
  // support quoted address at all.
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-multiple.pem", &san, &san_der));
  // SAN contains multiple email addresses, all match the permitted hostname.
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NameHostnameInExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-excluded-hostname.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-domaincase.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-localpartcase.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-subdomain.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-no-at.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-two-ats.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-empty-localpart.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NameHostnameWithAtInPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-permitted-hostnamewithat.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-empty-localpart.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-domaincase.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-localpartcase.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-subdomain.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-no-at.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-two-ats.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NameHostnameWithAtInExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-excluded-hostnamewithat.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-empty-localpart.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-domaincase.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-localpartcase.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-subdomain.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-no-at.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-two-ats.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NameSubdomainInPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-permitted-subdomains.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-subdomain.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-subdomaincase.pem", &san,
                                     &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-subdomain-no-at.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-subdomain-two-ats.pem",
                                     &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NameSubdomainInExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-excluded-subdomains.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-subdomain.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-subdomaincase.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-subdomain-no-at.pem", &san,
                                     &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name-subdomain-two-ats.pem",
                                     &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NameEmptyPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-permitted-empty.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-empty.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NameEmptyExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-excluded-empty.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-empty.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NameIPv4Permitted) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-permitted-ipv4.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-empty.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-ipv4.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, Rfc822NameIPv4Excluded) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("rfc822name-excluded-ipv4.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  EXPECT_EQ(GENERAL_NAME_RFC822_NAME,
            name_constraints->constrained_name_types());

  std::string san_der;
  std::unique_ptr<GeneralNames> san;

  ASSERT_TRUE(LoadTestSubjectAltName("san-rfc822name.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-empty.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));

  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-ipv4.pem", &san, &san_der));
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, QuotedRfc822SanWithNoRfc822Constraints) {
  // Load an unrelated (non-rfc822) constraint.
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("othername-excluded.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-quoted.pem", &san, &san_der));
  // A rfc822 in SAN with quotes should be allowed since we only try to parse
  // the name if we are enforcing a constraint against it.
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, QuotedRfc822SanMatchesQuotedPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-permitted-quoted.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-quoted.pem", &san, &san_der));
  // Both SAN and constraint are `"foo"@example.com`, but we don't support
  // quoted address at all.
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, UnquotedRfc822SanNotMatchingQuotedExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-excluded-quoted.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(
      LoadTestSubjectAltName("san-rfc822name-subdomain.pem", &san, &san_der));
  // The name `foo@subdomain.example.com` should be allowed since it doesn't
  // match an exclude of `"foo"@example.com`, but we don't support quoted
  // address at all so this is not allowed.
  EXPECT_FALSE(
      IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, X400AddresssInPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("x400address-permitted.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  if (is_critical()) {
    EXPECT_EQ(GENERAL_NAME_X400_ADDRESS,
              name_constraints->constrained_name_types());
  } else {
    EXPECT_EQ(0, name_constraints->constrained_name_types());
  }

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-x400address.pem", &san, &san_der));
  EXPECT_EQ(!is_critical(),
            IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, X400AddresssInExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("x400address-excluded.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  if (is_critical()) {
    EXPECT_EQ(GENERAL_NAME_X400_ADDRESS,
              name_constraints->constrained_name_types());
  } else {
    EXPECT_EQ(0, name_constraints->constrained_name_types());
  }

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-x400address.pem", &san, &san_der));
  EXPECT_EQ(!is_critical(),
            IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, EdiPartyNamesInPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("edipartyname-permitted.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  if (is_critical()) {
    EXPECT_EQ(GENERAL_NAME_EDI_PARTY_NAME,
              name_constraints->constrained_name_types());
  } else {
    EXPECT_EQ(0, name_constraints->constrained_name_types());
  }

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-edipartyname.pem", &san, &san_der));
  EXPECT_EQ(!is_critical(),
            IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, EdiPartyNamesInExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("edipartyname-excluded.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  if (is_critical()) {
    EXPECT_EQ(GENERAL_NAME_EDI_PARTY_NAME,
              name_constraints->constrained_name_types());
  } else {
    EXPECT_EQ(0, name_constraints->constrained_name_types());
  }

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-edipartyname.pem", &san, &san_der));
  EXPECT_EQ(!is_critical(),
            IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, URIsInPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("uri-permitted.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  if (is_critical()) {
    EXPECT_EQ(GENERAL_NAME_UNIFORM_RESOURCE_IDENTIFIER,
              name_constraints->constrained_name_types());
  } else {
    EXPECT_EQ(0, name_constraints->constrained_name_types());
  }

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-uri.pem", &san, &san_der));
  EXPECT_EQ(!is_critical(),
            IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, URIsInExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("uri-excluded.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  if (is_critical()) {
    EXPECT_EQ(GENERAL_NAME_UNIFORM_RESOURCE_IDENTIFIER,
              name_constraints->constrained_name_types());
  } else {
    EXPECT_EQ(0, name_constraints->constrained_name_types());
  }

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-uri.pem", &san, &san_der));
  EXPECT_EQ(!is_critical(),
            IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, RegisteredIDsInPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("registeredid-permitted.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  if (is_critical()) {
    EXPECT_EQ(GENERAL_NAME_REGISTERED_ID,
              name_constraints->constrained_name_types());
  } else {
    EXPECT_EQ(0, name_constraints->constrained_name_types());
  }

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-registeredid.pem", &san, &san_der));
  EXPECT_EQ(!is_critical(),
            IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints, RegisteredIDsInExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("registeredid-excluded.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  if (is_critical()) {
    EXPECT_EQ(GENERAL_NAME_REGISTERED_ID,
              name_constraints->constrained_name_types());
  } else {
    EXPECT_EQ(0, name_constraints->constrained_name_types());
  }

  std::string san_der;
  std::unique_ptr<GeneralNames> san;
  ASSERT_TRUE(LoadTestSubjectAltName("san-registeredid.pem", &san, &san_der));
  EXPECT_EQ(!is_critical(),
            IsPermittedCert(name_constraints.get(), der::Input(), san.get()));
}

TEST_P(ParseNameConstraints,
       failsOnGeneralSubtreeWithMinimumZeroEncodedUnnecessarily) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("dnsname-with_min_0.pem", &constraints_der));
  // The value should not be in the DER encoding if it is the default. But this
  // could be changed to allowed if there are buggy encoders out there that
  // include it anyway.
  CertErrors errors;
  EXPECT_FALSE(NameConstraints::Create(StringAsBytes(constraints_der),
                                       is_critical(), &errors));
}

TEST_P(ParseNameConstraints, FailsOnGeneralSubtreeWithMinimum) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("dnsname-with_min_1.pem", &constraints_der));
  CertErrors errors;
  EXPECT_FALSE(NameConstraints::Create(StringAsBytes(constraints_der),
                                       is_critical(), &errors));
}

TEST_P(ParseNameConstraints,
       failsOnGeneralSubtreeWithMinimumZeroEncodedUnnecessarilyAndMaximum) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("dnsname-with_min_0_and_max.pem",
                                     &constraints_der));
  CertErrors errors;
  EXPECT_FALSE(NameConstraints::Create(StringAsBytes(constraints_der),
                                       is_critical(), &errors));
}

TEST_P(ParseNameConstraints, FailsOnGeneralSubtreeWithMinimumAndMaximum) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("dnsname-with_min_1_and_max.pem",
                                     &constraints_der));
  CertErrors errors;
  EXPECT_FALSE(NameConstraints::Create(StringAsBytes(constraints_der),
                                       is_critical(), &errors));
}

TEST_P(ParseNameConstraints, FailsOnGeneralSubtreeWithMaximum) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("dnsname-with_max.pem", &constraints_der));
  CertErrors errors;
  EXPECT_FALSE(NameConstraints::Create(StringAsBytes(constraints_der),
                                       is_critical(), &errors));
}

TEST_P(ParseNameConstraints, FailsOnEmptyExtensionValue) {
  std::string constraints_der = "";
  CertErrors errors;
  EXPECT_FALSE(NameConstraints::Create(StringAsBytes(constraints_der),
                                       is_critical(), &errors));
}

TEST_P(ParseNameConstraints, FailsOnNoPermittedAndExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("invalid-no_subtrees.pem", &constraints_der));
  CertErrors errors;
  EXPECT_FALSE(NameConstraints::Create(StringAsBytes(constraints_der),
                                       is_critical(), &errors));
}

TEST_P(ParseNameConstraints, FailsOnEmptyPermitted) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("invalid-empty_permitted_subtree.pem",
                                     &constraints_der));
  CertErrors errors;
  EXPECT_FALSE(NameConstraints::Create(StringAsBytes(constraints_der),
                                       is_critical(), &errors));
}

TEST_P(ParseNameConstraints, FailsOnEmptyExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("invalid-empty_excluded_subtree.pem",
                                     &constraints_der));
  CertErrors errors;
  EXPECT_FALSE(NameConstraints::Create(StringAsBytes(constraints_der),
                                       is_critical(), &errors));
}

TEST_P(ParseNameConstraints,
       IsPermittedCertSubjectEmailAddressNoEmailConstraint) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("directoryname.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string name;
  ASSERT_TRUE(LoadTestName("name-us-arizona-email.pem", &name));
  // Name constraints don't contain rfc822Name, so emailAddress in subject is
  // allowed regardless.
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name),
                              /*subject_alt_names=*/nullptr));

  ASSERT_TRUE(LoadTestName("name-us-arizona-email-invalidstring.pem", &name));
  // Name constraints don't contain rfc822Name, so emailAddress in subject is
  // allowed regardless.
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name),
                              /*subject_alt_names=*/nullptr));
}

TEST_P(ParseNameConstraints, IsPermittedCertSubjectEmailAddressIsOk) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("rfc822name-permitted-hostname.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string name;
  ASSERT_TRUE(LoadTestName("name-us-arizona-email.pem", &name));

  // Name constraints contain rfc822Name, and the address matches the
  // constraint (which is all addresses on the hostname.)
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name),
                              /*subject_alt_names=*/nullptr));

  ASSERT_TRUE(LoadTestName("name-us-arizona-email-invalidstring.pem", &name));
  // The bytes of the name string match, but the string type is VISIBLESTRING
  // which is not supported, so this should fail.
  EXPECT_FALSE(IsPermittedCert(name_constraints.get(),
                               SequenceValueFromString(name),
                               /*subject_alt_names=*/nullptr));

  ASSERT_TRUE(LoadTestName("name-us-arizona-email-multiple.pem", &name));
  // Subject contains multiple rfc822Names, and they all match the constraint
  // (which is all addresses on the hostname.)
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name),
                              /*subject_alt_names=*/nullptr));
}

TEST_P(ParseNameConstraints, IsPermittedCertSubjectEmailAddressIsNotOk) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("rfc822name-permitted.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string name;
  ASSERT_TRUE(LoadTestName("name-us-arizona-email.pem", &name));

  // Name constraints contain rfc822Name, and the address does not match the
  // constraint.
  EXPECT_FALSE(IsPermittedCert(name_constraints.get(),
                               SequenceValueFromString(name),
                               /*subject_alt_names=*/nullptr));

  // Address is a case-insensitive match, but name constraints (permitted) are
  // case-sensitive, so this fails.
  ASSERT_TRUE(LoadTestName("name-us-arizona-email-localpartcase.pem", &name));
  EXPECT_FALSE(IsPermittedCert(name_constraints.get(),
                               SequenceValueFromString(name),
                               /*subject_alt_names=*/nullptr));

  ASSERT_TRUE(LoadTestName("name-us-arizona-email-multiple.pem", &name));
  // Subject contains multiple rfc822Names, and only the first one matches the
  // constraint.
  EXPECT_FALSE(IsPermittedCert(name_constraints.get(),
                               SequenceValueFromString(name),
                               /*subject_alt_names=*/nullptr));
}

TEST_P(ParseNameConstraints, IsPermittedCertSubjectEmailAddressExcluded) {
  std::string constraints_der;
  ASSERT_TRUE(
      LoadTestNameConstraint("rfc822name-excluded.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string name;
  ASSERT_TRUE(LoadTestName("name-us-arizona-email.pem", &name));

  // Name constraints contain excluded rfc822Name, and the address does not
  // match the constraint.
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name),
                              /*subject_alt_names=*/nullptr));

  // Name constraints for excluded are done case-insensitive in the local part,
  // so this is not allowed.
  ASSERT_TRUE(LoadTestName("name-us-arizona-email-localpartcase.pem", &name));
  EXPECT_FALSE(IsPermittedCert(name_constraints.get(),
                               SequenceValueFromString(name),
                               /*subject_alt_names=*/nullptr));

  ASSERT_TRUE(LoadTestName("name-us-arizona-email-multiple.pem", &name));
  // Subject contains multiple rfc822Names, and one of them is excluded by the
  // constraint.
  EXPECT_FALSE(IsPermittedCert(name_constraints.get(),
                               SequenceValueFromString(name),
                               /*subject_alt_names=*/nullptr));
}

// Hostname in commonName is not allowed (crbug.com/308330), so these are tests
// are not particularly interesting, just verifying that the commonName is
// ignored for dNSName constraints.
TEST_P(ParseNameConstraints, IsPermittedCertSubjectDnsNames) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint("directoryname_and_dnsname.pem",
                                     &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string name_us_az_foocom;
  ASSERT_TRUE(LoadTestName("name-us-arizona-foo.com.pem", &name_us_az_foocom));
  // The subject is within permitted directoryName constraints, so permitted.
  // (The commonName hostname is not within permitted dNSName constraints, so
  // this would not be permitted if hostnames in commonName were checked.)
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name_us_az_foocom),
                              nullptr /* subject_alt_names */));

  std::string name_us_az_permitted;
  ASSERT_TRUE(LoadTestName("name-us-arizona-permitted.example.com.pem",
                           &name_us_az_permitted));
  // The subject is in permitted directoryName and the commonName is within
  // permitted dNSName constraints, so this should be permitted regardless if
  // hostnames in commonName are checked or not.
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name_us_az_permitted),
                              nullptr /* subject_alt_names */));

  std::string name_us_ca_permitted;
  ASSERT_TRUE(LoadTestName("name-us-california-permitted.example.com.pem",
                           &name_us_ca_permitted));
  // The subject is within the excluded C=US,ST=California directoryName, so
  // this should not be allowed, regardless of checking the
  // permitted.example.com in commonName.
  EXPECT_FALSE(IsPermittedCert(name_constraints.get(),
                               SequenceValueFromString(name_us_ca_permitted),
                               nullptr /* subject_alt_names */));
}

// IP addresses in commonName are not allowed (crbug.com/308330), so these are
// tests are not particularly interesting, just verifying that the commonName is
// ignored for iPAddress constraints.
TEST_P(ParseNameConstraints, IsPermittedCertSubjectIpAddresses) {
  std::string constraints_der;
  ASSERT_TRUE(LoadTestNameConstraint(
      "directoryname_and_dnsname_and_ipaddress.pem", &constraints_der));
  CertErrors errors;
  std::unique_ptr<NameConstraints> name_constraints(NameConstraints::Create(
      StringAsBytes(constraints_der), is_critical(), &errors));
  ASSERT_TRUE(name_constraints);

  std::string name_us_az_1_1_1_1;
  ASSERT_TRUE(LoadTestName("name-us-arizona-1.1.1.1.pem", &name_us_az_1_1_1_1));
  // The subject is within permitted directoryName constraints, so permitted.
  // (The commonName IP address is not within permitted iPAddresses constraints,
  // so this would not be permitted if IP addresses in commonName were checked.)
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name_us_az_1_1_1_1),
                              nullptr /* subject_alt_names */));

  std::string name_us_az_192_168_1_1;
  ASSERT_TRUE(
      LoadTestName("name-us-arizona-192.168.1.1.pem", &name_us_az_192_168_1_1));
  // The subject is in permitted directoryName and the commonName is within
  // permitted iPAddress constraints, so this should be permitted regardless if
  // IP addresses in commonName are checked or not.
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name_us_az_192_168_1_1),
                              nullptr /* subject_alt_names */));

  std::string name_us_ca_192_168_1_1;
  ASSERT_TRUE(LoadTestName("name-us-california-192.168.1.1.pem",
                           &name_us_ca_192_168_1_1));
  // The subject is within the excluded C=US,ST=California directoryName, so
  // this should not be allowed, regardless of checking the
  // IP address in commonName.
  EXPECT_FALSE(IsPermittedCert(name_constraints.get(),
                               SequenceValueFromString(name_us_ca_192_168_1_1),
                               nullptr /* subject_alt_names */));

  std::string name_us_az_ipv6;
  ASSERT_TRUE(LoadTestName("name-us-arizona-ipv6.pem", &name_us_az_ipv6));
  // The subject is within permitted directoryName constraints, so permitted.
  // (The commonName is an ipv6 address which wasn't supported in the past, but
  // since commonName checking is ignored entirely, this is permitted.)
  EXPECT_TRUE(IsPermittedCert(name_constraints.get(),
                              SequenceValueFromString(name_us_az_ipv6),
                              nullptr /* subject_alt_names */));
}

BSSL_NAMESPACE_END
