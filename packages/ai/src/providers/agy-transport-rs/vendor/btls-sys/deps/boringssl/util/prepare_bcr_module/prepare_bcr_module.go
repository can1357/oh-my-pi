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

// prepare_bcr_module prepares for a BCR release. It outputs a JSON
// configuration file that may be used by BCR's add_module tool.
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

var (
	outDir     = flag.String("out-dir", "", "The directory to place the script output, or a temporary directory if unspecified.")
	numWorkers = flag.Int("num-workers", runtime.NumCPU(), "Runs the given number of workers")

	moduleOverride    = flag.String("module-override", "", "The path to a file that overrides the MODULE.bazel file in the archive.")
	presubmitOverride = flag.String("presubmit-override", "", "The path to a file that overrides the presubmit.yml file in the archive.")
	skipArchiveCheck  = flag.Bool("skip-archive-check", false, "Skips checking the release tarball against the (potentially unstable) archive tarball.")
	pipe              = flag.Bool("pipe", false, "Prints output suitable for writing to a pipe instead of a terminal")

	githubOrg          = flag.String("github-org", "google", "The organization where the GitHub repository lives")
	githubRepo         = flag.String("github-repo", "boringssl", "The name of the GitHub repository")
	moduleName         = flag.String("module-name", "boringssl", "The name of the BCR module")
	compatibilityLevel = flag.String("compatibility-level", "2", "The compatibility_level setting for the BCR module")
)

// A bcrConfig is a configuration file for BCR's add_module tool. This is
// undocumented but can be seen in the Module Python class. (The JSON struct is
// simply the object's __dict__.)
type bcrConfig struct {
	Name                   string   `json:"name"`
	Version                string   `json:"version"`
	CompatibilityLevel     string   `json:"compatibility_level"`
	ModuleDotBazel         *string  `json:"module_dot_bazel"`
	URL                    *string  `json:"url"`
	StripPrefix            *string  `json:"strip_prefix"`
	Deps                   []string `json:"deps"`
	Patches                []string `json:"patches"`
	PatchStrip             int      `json:"patch_strip"`
	BuildFile              *string  `json:"build_file"`
	PresubmitYml           *string  `json:"presubmit_yml"`
	BuildTargets           []string `json:"build_targets"`
	TestModulePath         *string  `json:"test_module_path"`
	TestModuleBuildTargets []string `json:"test_module_build_targets"`
	TestModuleTestTargets  []string `json:"test_module_test_targets"`
}

func ptr[T any](t T) *T { return &t }

func archiveURL(tag string) string {
	return fmt.Sprintf("https://github.com/%s/%s/archive/refs/tags/%s.tar.gz", *githubOrg, *githubRepo, tag)
}

func releaseURL(tag string) string {
	return fmt.Sprintf("https://github.com/%s/%s/releases/download/%s/%s-%s.tar.gz", *githubOrg, *githubRepo, tag, *githubRepo, tag)
}

func releaseViewURL(tag string) string {
	return fmt.Sprintf("https://github.com/%s/%s/releases/tag/%s", *githubOrg, *githubRepo, tag)
}

func releaseEditURL(tag string) string {
	return fmt.Sprintf("https://github.com/%s/%s/releases/edit/%s", *githubOrg, *githubRepo, tag)
}

func fetch(url string) (*http.Response, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("got status code of %d from %q instead of 200", resp.StatusCode, url)
	}
	return resp, nil
}

type releaseFetchError struct{ error }
type releaseMismatchError struct{ error }

func sha256Reader(r io.Reader) ([]byte, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

func run(tag string) error {
	// Check the tag does not contain any characters that would break the URL
	// or filesystem.
	for _, c := range tag {
		if c != '.' && !('0' <= c && c <= '9') && !('a' <= c && c <= 'z') && !('A' <= c && c <= 'Z') {
			return fmt.Errorf("invalid tag %q", tag)
		}
	}

	// Read the tag from git. We will use this to ensure the archive is correct.
	var expectedTree []treeEntry
	if err := step("Hashing tree from git", func(s *stepPrinter) error {
		var err error
		expectedTree, err = gitHashTree(s, tag)
		return err
	}); err != nil {
		return err
	}

	// Hash the archive tarball.
	//
	// BCR does not accept archive tarballs, due to concerns that GitHub may
	// change the hash, and instead prefers release tarballs. Release tarballs,
	// however, are uploaded by individual developers, with no guaranteed they
	// match the contents of the tag.
	//
	// This script checks the release tarball against the tag in the on-disk git
	// repository, so we validate the contents independent of GitHub. We
	// additionally check that release tarball matches the archive tarball. The
	// archive tarballs are stable in practice, and this is an easy, though
	// still GitHub-dependent, property that anyone can check. (This script
	// assumes GitHub did not change their tarballs in the short window between
	// when the release tarball was uploaded and this script runs.)
	var archiveSHA256 []byte
	if !*skipArchiveCheck {
		if err := step("Fetching archive tarball", func(s *stepPrinter) error {
			archive, err := fetch(archiveURL(tag))
			if err != nil {
				return err
			}
			defer archive.Body.Close()
			archiveSHA256, err = sha256Reader(s.httpBodyWithProgress(archive))
			return err
		}); err != nil {
			return err
		}
	}

	// Prepare an output directory.
	var dir string
	var err error
	if len(*outDir) != 0 {
		dir, err = filepath.Abs(*outDir)
	} else {
		dir, err = os.MkdirTemp("", "boringssl_bcr")
	}
	if err != nil {
		return err
	}

	// Fetch the release tarball. As we stream it, we do three things:
	//
	// 1. Compute the overall SHA-256 sum. This hash must be saved in the BCR
	//    configuration.
	//
	// 2. Hash the contents of each file in the tarball, to compare against the
	//    contents in git.
	//
	// 3. Extract MODULE.bazel and presubmit.yml, to save in the temporary
	//    directory. This is needed to work around limitations in BCR's tooling.
	//    See https://github.com/bazelbuild/bazel-central-registry/issues/2781
	var releaseTree []treeEntry
	releaseHash := sha256.New()
	stripPrefix := fmt.Sprintf("%s-%s/", *githubRepo, tag)
	if err := step("Fetching release tarball", func(s *stepPrinter) error {
		release, err := fetch(releaseURL(tag))
		if err != nil {
			return releaseFetchError{err}
		}
		defer release.Body.Close()

		// Hash the tarball as we read it.
		reader := s.httpBodyWithProgress(release)
		reader = io.TeeReader(reader, releaseHash)

		zlibReader, err := gzip.NewReader(reader)
		if err != nil {
			return fmt.Errorf("error reading release tarball: %w", err)
		}

		tarReader := tar.NewReader(zlibReader)
		var seenModule, seenPresubmit bool
		for {
			header, err := tarReader.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return fmt.Errorf("error reading release tarball: %w", err)
			}

			var mode treeEntryMode
			var fileReader io.Reader
			switch header.Typeflag {
			case tar.TypeDir:
				// Check directories have a suitable prefix, but otherwise ignore
				// them.
				if !strings.HasPrefix(header.Name, stripPrefix) {
					return fmt.Errorf("release tarball contained path %q which did not begin with %q", header.Name, stripPrefix)
				}
				continue
			case tar.TypeXGlobalHeader:
				continue
			case tar.TypeReg:
				if header.Mode&1 != 0 {
					mode = treeEntryExecutable
				} else {
					mode = treeEntryRegular
				}
				fileReader = tarReader
			case tar.TypeSymlink:
				mode = treeEntrySymlink
				fileReader = strings.NewReader(header.Linkname)
			default:
				return fmt.Errorf("path %q in release archive had unknown type %d", header.Name, header.Typeflag)
			}

			path, ok := strings.CutPrefix(header.Name, stripPrefix)
			if !ok {
				return fmt.Errorf("release tarball contained path %q which did not begin with %q", header.Name, stripPrefix)
			}

			var saveFile *os.File
			if mode == treeEntryRegular && path == "MODULE.bazel" {
				if seenModule {
					return fmt.Errorf("release tarball contained duplicate MODULE.bazel file")
				}
				saveFile, err = os.Create(filepath.Join(dir, "MODULE.bazel"))
				if err != nil {
					return err
				}
				seenModule = true
			} else if mode == treeEntryRegular && path == ".bcr/presubmit.yml" {
				if seenPresubmit {
					return fmt.Errorf("release tarball contained duplicate .bcr/presubmit.yml file")
				}
				saveFile, err = os.Create(filepath.Join(dir, "presubmit.yml"))
				if err != nil {
					return err
				}
				seenPresubmit = true
			}

			if saveFile != nil {
				fileReader = io.TeeReader(fileReader, saveFile)
			}

			sha256, err := sha256Reader(fileReader)
			saveFile.Close()
			if err != nil {
				return fmt.Errorf("error reading %q in release archive: %w", header.Name, err)
			}

			releaseTree = append(releaseTree, treeEntry{path: path, mode: mode, sha256: sha256})
		}

		sortTree(releaseTree)

		// Check the zlib checksum is correct.
		if err := zlibReader.Close(); err != nil {
			return fmt.Errorf("error reading release tarball: %w", err)
		}

		// Ensure we have read (and thus hashed) the entire archive.
		if _, err := io.Copy(io.Discard, reader); err != nil {
			return fmt.Errorf("error reading release archive: %w", err)
		}

		if !seenModule && len(*moduleOverride) == 0 {
			return fmt.Errorf("could not find MODULE.bazel in release tarball")
		}
		if !seenPresubmit && len(*presubmitOverride) == 0 {
			return fmt.Errorf("could not find .bcr/presubmit.yml in release tarball")
		}
		return nil
	}); err != nil {
		return err
	}

	releaseSHA256 := releaseHash.Sum(nil)
	if !*skipArchiveCheck && !bytes.Equal(archiveSHA256, releaseSHA256) {
		return releaseMismatchError{fmt.Errorf("release hash was %x, which did not match archive hash was %x", archiveSHA256, releaseSHA256)}
	}

	if err := compareTrees(releaseTree, expectedTree); err != nil {
		return err
	}

	config := bcrConfig{
		Name:               *moduleName,
		Version:            tag,
		CompatibilityLevel: *compatibilityLevel,
		ModuleDotBazel:     ptr(filepath.Join(dir, "MODULE.bazel")),
		URL:                ptr(releaseURL(tag)),
		StripPrefix:        &stripPrefix,
		PresubmitYml:       ptr(filepath.Join(dir, "presubmit.yml")),
		// encoding/json will encode nil slices as null instead of the empty array.
		Deps:                   []string{},
		Patches:                []string{},
		BuildTargets:           []string{},
		TestModuleBuildTargets: []string{},
		TestModuleTestTargets:  []string{},
	}

	if len(*moduleOverride) != 0 {
		override, err := filepath.Abs(*moduleOverride)
		if err != nil {
			return err
		}
		config.ModuleDotBazel = &override
	}
	if len(*presubmitOverride) != 0 {
		override, err := filepath.Abs(*presubmitOverride)
		if err != nil {
			return err
		}
		config.PresubmitYml = &override
	}

	configJSON, err := json.Marshal(config)
	if err != nil {
		return err
	}

	jsonPath := filepath.Join(dir, "bcr.json")
	if err := os.WriteFile(jsonPath, configJSON, 0666); err != nil {
		return err
	}

	fmt.Printf("\n")
	fmt.Printf("BCR configuration written to %q\n", dir)
	fmt.Printf("\n")
	fmt.Printf("Clone the BCR repository at:\n")
	fmt.Printf("  https://github.com/bazelbuild/bazel-central-registry\n")
	fmt.Printf("\n")
	fmt.Printf("Then, run the following command to prepare the module update:\n")
	fmt.Printf("  bazelisk run //tools:add_module -- --input %s\n", jsonPath)
	fmt.Printf("\n")
	fmt.Printf("Finally, commit the result and send the BCR repository a PR.\n")
	return nil
}

func main() {
	flag.Usage = func() {
		fmt.Fprint(os.Stderr, "Usage: go run ./util/prepare_bcr_module [FLAGS...] TAG\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintf(os.Stderr, "Expected exactly one tag specified.\n")
		flag.Usage()
		os.Exit(1)
	}

	tag := flag.Arg(0)
	if err := run(tag); err != nil {
		if _, ok := err.(releaseFetchError); ok {
			fmt.Fprintf(os.Stderr, "Error fetching release URL for %q: %s\n", tag, err)
			fmt.Fprintf(os.Stderr, "\n")
			fmt.Fprintf(os.Stderr, "To fix this, follow the following steps:\n")
			fmt.Fprintf(os.Stderr, "1. Open %s in a browser.\n", releaseViewURL(tag))
			fmt.Fprintf(os.Stderr, "2. Download the \"Source code (tar.gz)\" archive.\n")
			fmt.Fprintf(os.Stderr, "3. Click the edit icon, or open %s in your browser.\n", releaseEditURL(tag))
			fmt.Fprintf(os.Stderr, "4. Attach the downloaded boringssl-%s.tar.gz to the release.\n", tag)
			fmt.Fprintf(os.Stderr, "\n")
		} else if _, ok := err.(releaseMismatchError); ok {
			fmt.Fprintf(os.Stderr, "Invalid release tarball for %q: %s\n", tag, err)
			fmt.Fprintf(os.Stderr, "\n")
			fmt.Fprintf(os.Stderr, "To fix this, follow the following steps:\n")
			fmt.Fprintf(os.Stderr, "1. Open %s in a browser.\n", releaseViewURL(tag))
			fmt.Fprintf(os.Stderr, "2. Download the \"Source code (tar.gz)\" archive.\n")
			fmt.Fprintf(os.Stderr, "3. Click the edit icon, or open %s in your browser.\n", releaseEditURL(tag))
			fmt.Fprintf(os.Stderr, "4. Delete the old boringssl-%s.tar.gz from the release.\n", tag)
			fmt.Fprintf(os.Stderr, "5. Re-attach the downloaded boringssl-%s.tar.gz to the release.\n", tag)
			fmt.Fprintf(os.Stderr, "\n")
		} else {
			fmt.Fprintf(os.Stderr, "Error preparing release %q: %s\n", tag, err)
		}
		os.Exit(1)
	}
}
