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

package main

import (
	"bytes"
	"cmp"
	"crypto/sha256"
	"fmt"
	"os/exec"
	"slices"
	"strings"
	"sync"
)

type treeEntryMode int

const (
	treeEntryRegular treeEntryMode = iota
	treeEntryExecutable
	treeEntrySymlink
)

func (m treeEntryMode) String() string {
	switch m {
	case treeEntryRegular:
		return "regular file"
	case treeEntryExecutable:
		return "executable file"
	case treeEntrySymlink:
		return "symbolic link"
	}
	panic(fmt.Sprintf("unknown mode %d", m))
}

type treeEntry struct {
	path   string
	mode   treeEntryMode
	sha256 []byte
}

func sortTree(tree []treeEntry) {
	slices.SortFunc(tree, func(a, b treeEntry) int { return cmp.Compare(a.path, b.path) })
}

func compareTrees(got, want []treeEntry) error {
	// Check for duplicate files.
	for i := 0; i < len(got)-1; i++ {
		if got[i].path == got[i+1].path {
			return fmt.Errorf("duplicate file %q in archive", got[i].path)
		}
	}

	// Check for differences between the two trees.
	for i := 0; i < len(got) && i < len(want); i++ {
		if got[i].path == want[i].path {
			if got[i].mode != want[i].mode {
				return fmt.Errorf("file %q was a %s but should have been a %s", got[i].path, got[i].mode, want[i].mode)
			}
			if !bytes.Equal(got[i].sha256, want[i].sha256) {
				return fmt.Errorf("hash of %q was %x but should have been %x", got[i].path, got[i].sha256, want[i].sha256)
			}
		} else if got[i].path < want[i].path {
			return fmt.Errorf("unexpected file %q", got[i].path)
		} else {
			return fmt.Errorf("missing file %q", want[i].path)
		}
	}
	if len(want) < len(got) {
		return fmt.Errorf("unexpected file %q", got[len(want)].path)
	}
	if len(got) < len(want) {
		return fmt.Errorf("missing file %q", want[len(got)].path)
	}
	return nil
}

type gitTreeEntry struct {
	path       string
	mode       treeEntryMode
	objectName string
}

func gitListTree(treeish string) ([]gitTreeEntry, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.Command("git", "ls-tree", "-r", "-z", treeish)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("error listing git tree %q: %w\n%s\n", treeish, err, stderr.String())
	}
	lines := strings.Split(stdout.String(), "\x00")
	ret := make([]gitTreeEntry, 0, len(lines))
	for _, line := range lines {
		if len(line) == 0 {
			continue
		}

		idx := strings.IndexByte(line, '\t')
		if idx < 0 {
			return nil, fmt.Errorf("could not parse ls-tree output %q", line)
		}

		info, path := line[:idx], line[idx+1:]
		infos := strings.Split(info, " ")
		if len(infos) != 3 {
			return nil, fmt.Errorf("could not parse ls-tree output %q", line)
		}

		perms, objectType, objectName := infos[0], infos[1], infos[2]
		if objectType != "blob" {
			return nil, fmt.Errorf("unexpected object type in ls-tree output %q", line)
		}

		var mode treeEntryMode
		switch perms {
		case "100644":
			mode = treeEntryRegular
		case "100755":
			mode = treeEntryExecutable
		case "120000":
			mode = treeEntrySymlink
		default:
			return nil, fmt.Errorf("unexpected file mode in ls-tree output %q", line)
		}

		ret = append(ret, gitTreeEntry{path: path, mode: mode, objectName: objectName})
	}
	return ret, nil
}

func gitHashBlob(objectName string) ([]byte, error) {
	h := sha256.New()
	var stderr bytes.Buffer
	cmd := exec.Command("git", "cat-file", "blob", objectName)
	cmd.Stdout = h
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("error hashing git object %q: %w\n%s\n", objectName, err, stderr.String())
	}
	return h.Sum(nil), nil
}

func gitHashTree(s *stepPrinter, treeish string) ([]treeEntry, error) {
	gitTree, err := gitListTree(treeish)
	if err != nil {
		return nil, err
	}

	s.setTotal(len(gitTree))

	// Hashing objects one by one is slow, so parallelize. Ideally we could
	// just use the object name, but git uses SHA-1, so checking a SHA-265
	// hash seems prudent.
	var workerErr error
	var workerLock sync.Mutex

	var wg sync.WaitGroup
	jobs := make(chan gitTreeEntry, *numWorkers)
	results := make(chan treeEntry, *numWorkers)
	for i := 0; i < *numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				workerLock.Lock()
				shouldStop := workerErr != nil
				workerLock.Unlock()
				if shouldStop {
					break
				}

				sha256, err := gitHashBlob(job.objectName)
				if err != nil {
					workerLock.Lock()
					if workerErr == nil {
						workerErr = err
					}
					workerLock.Unlock()
					break
				}

				results <- treeEntry{path: job.path, mode: job.mode, sha256: sha256}
			}
		}()
	}

	go func() {
		for _, job := range gitTree {
			jobs <- job
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()

	tree := make([]treeEntry, 0, len(gitTree))
	for result := range results {
		s.addProgress(1)
		tree = append(tree, result)
	}

	if workerErr != nil {
		return nil, workerErr
	}

	if len(tree) != len(gitTree) {
		panic("input and output sizes did not match")
	}

	sortTree(tree)
	return tree, nil
}
