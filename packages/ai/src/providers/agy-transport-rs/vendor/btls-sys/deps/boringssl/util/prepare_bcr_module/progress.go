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
	"fmt"
	"io"
	"net/http"
	"strings"
)

func step(desc string, f func(*stepPrinter) error) error {
	fmt.Printf("%s...", desc)
	if *pipe {
		fmt.Printf("\n")
	} else {
		fmt.Printf(" ")
	}
	s := stepPrinter{lastPercent: -1}
	err := f(&s)
	s.erasePercent()
	if err != nil {
		fmt.Printf("ERROR\n")
	} else {
		fmt.Printf("OK\n")
	}
	return err
}

type stepPrinter struct {
	lastPercent     int
	percentLen      int
	progress, total int
}

func (s *stepPrinter) erasePercent() {
	if !*pipe && s.percentLen > 0 {
		var erase strings.Builder
		for i := 0; i < s.percentLen; i++ {
			erase.WriteString("\b \b")
		}
		fmt.Printf("%s", erase.String())
		s.percentLen = 0
	}
}

func (s *stepPrinter) setTotal(total int) {
	s.progress = 0
	s.total = total
	s.printPercent()
}

func (s *stepPrinter) addProgress(delta int) {
	s.progress += delta
	s.printPercent()
}

func (s *stepPrinter) printPercent() {
	if s.total <= 0 {
		return
	}

	percent := 100
	if s.progress < s.total {
		percent = 100 * s.progress / s.total
	}
	if *pipe {
		percent -= percent % 10
	}
	if percent == s.lastPercent {
		return
	}

	s.erasePercent()

	s.lastPercent = percent
	str := fmt.Sprintf("%d%%", percent)
	s.percentLen = len(str)
	fmt.Printf("%s", str)
	if *pipe {
		fmt.Printf("\n")
	}
}

func (s *stepPrinter) progressWriter(total int) io.Writer {
	s.setTotal(total)
	return &progressWriter{step: s}
}

func (s *stepPrinter) httpBodyWithProgress(r *http.Response) io.Reader {
	// This does not always give any progress. It seems GitHub will sometimes
	// provide a Content-Length header and sometimes not, for the same URL.
	return io.TeeReader(r.Body, s.progressWriter(int(r.ContentLength)))
}

type progressWriter struct {
	step *stepPrinter
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.step.addProgress(len(b))
	return len(b), nil
}
