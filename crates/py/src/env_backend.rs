// Typed per-operation Environment DATA-plane method table.

macro_rules! emit_backend_methods {
	(
		@collect
		[$($custom:tt)*]
		[$($methods:tt)*]
		request $name:ident, $operation:literal, [$($argument:literal),* $(,)?];
		$($remaining:tt)*
	) => {
		emit_backend_methods! {
			@collect
			[$($custom)*]
			[
				$($methods)*
				#[pyo3(signature = (*args, **kwargs))]
				fn $name(
					&self,
					py: Python<'_>,
					args: &Bound<'_, PyTuple>,
					kwargs: Option<&Bound<'_, PyDict>>,
				) -> PyResult<Py<PyAny>> {
					self.forward_request(py, $operation, &[$($argument),*], args, kwargs)
				}
			]
			$($remaining)*
		}
	};
	(
		@collect
		[$($custom:tt)*]
		[$($methods:tt)*]
		stream $name:ident, $operation:literal, [$($argument:literal),* $(,)?];
		$($remaining:tt)*
	) => {
		emit_backend_methods! {
			@collect
			[$($custom)*]
			[
				$($methods)*
				#[pyo3(signature = (*args, **kwargs))]
				fn $name(
					&self,
					py: Python<'_>,
					args: &Bound<'_, PyTuple>,
					kwargs: Option<&Bound<'_, PyDict>>,
				) -> PyResult<Py<PyAny>> {
					self.forward_stream(py, $operation, &[$($argument),*], args, kwargs)
				}
			]
			$($remaining)*
		}
	};
	(@collect [$($custom:tt)*] [$($methods:tt)*]) => {
		#[pymethods]
		impl PyEnvironmentBackend {
			$($custom)*
			$($methods)*

			#[pyo3(signature = (*args, **kwargs))]
			fn session_open(
				&self,
				py: Python<'_>,
				args: &Bound<'_, PyTuple>,
				kwargs: Option<&Bound<'_, PyDict>>,
			) -> PyResult<Py<PyAny>> {
				if args.len() > 3 {
					return Err(PyTypeError::new_err(
						"session_open takes at most 3 positional arguments",
					));
				}
				let arguments = PyDict::new(py);
				if let Some(kwargs) = kwargs {
					for (key, value) in kwargs {
						arguments.set_item(key, value)?;
					}
				}
				for (index, value) in args.iter().enumerate() {
					arguments.set_item(["cwd", "env", "pty"][index], value)?;
				}
				self.session(py, &arguments)
			}

			#[pyo3(signature = (*args, **kwargs))]
			fn http_request(
				&self,
				py: Python<'_>,
				args: &Bound<'_, PyTuple>,
				kwargs: Option<&Bound<'_, PyDict>>,
			) -> PyResult<Py<PyAny>> {
				if args.is_empty() {
					return Err(PyTypeError::new_err("http_request requires method"));
				}
				let method = args.iter().next().expect("nonempty args").extract::<String>()?;
				let operation = match method.as_str() {
					"GET" => "omp.env.http_get",
					"POST" => "omp.env.http_post",
					"PUT" => "omp.env.http_put",
					_ => return Err(PyValueError::new_err("HTTP method must be GET, POST, or PUT")),
				};
				let remaining = args.get_slice(1, args.len());
				self.forward_request(
					py,
					operation,
					&["url", "body", "headers", "timeout", "redirects"],
					&remaining,
					kwargs,
				)
			}
		}
	};
	(custom { $($custom:tt)* } $($methods:tt)*) => {
		emit_backend_methods!(@collect [$($custom)*] [] $($methods)*);
	};
}

backend_methods! {
	request worktree, "omp.env.worktree", [];
	request docs_open, "omp.env.docs.open", ["path", "language", "create"];
	request docs_read_bytes, "omp.env.docs.read_bytes", ["path"];
	request doc_read_bytes, "omp.env.docs.Doc.read_bytes", ["lease", "revision"];
	request doc_refresh, "omp.env.docs.Doc.refresh", ["lease"];
	request doc_lines, "omp.env.docs.Doc.lines", ["lease", "start", "end", "revision"];
	request doc_summary, "omp.env.docs.Doc.summary", ["lease", "options"];
	request doc_edit, "omp.env.docs.Doc.edit", ["lease", "edits"];
	request doc_write, "omp.env.docs.Doc.write", ["lease", "data"];
	request doc_hashline, "omp.env.docs.Doc.hashline", ["lease", "patch"];
	request doc_close, "omp.env.docs.Doc.close", ["lease"];
	stream doc_events, "omp.env.docs.Doc.events", ["lease"];
	request txn_commit, "omp.env.Txn.commit", ["txn_id", "operations"];
	request fs_stat, "omp.env.fs.stat", ["path"];
	request fs_lstat, "omp.env.fs.lstat", ["path"];
	request fs_canonicalize, "omp.env.fs.canonicalize", ["path"];
	request fs_list_dir, "omp.env.fs.list_dir", ["path", "follow"];
	request fs_read_link, "omp.env.fs.read_link", ["path"];
	request fs_mkdir, "omp.env.fs.mkdir", ["path", "parents", "exist_ok"];
	request fs_remove, "omp.env.fs.remove", ["path", "recursive", "revision"];
	request fs_rename, "omp.env.fs.rename", ["src", "dest", "overwrite", "src_revision", "dest_revision"];
	request fs_copy, "omp.env.fs.copy", ["src", "dest", "follow", "overwrite", "dest_revision"];
	request fs_symlink, "omp.env.fs.symlink", ["target", "link", "kind", "relative", "overwrite"];
	request fs_hard_link, "omp.env.fs.hard_link", ["src", "link", "follow", "overwrite"];
	request fs_chmod, "omp.env.fs.chmod", ["path", "read_only", "executable", "follow", "revision"];
	request lsp_bindings, "omp.env.lsp.bindings", ["path"];
	request lsp_request, "omp.env.lsp.request", ["server", "method", "params", "lease", "on_stale", "timeout"];
	request lsp_notify, "omp.env.lsp.notify", ["server", "method", "params"];
	stream lsp_events, "omp.env.lsp.events", [];
	request session_run, "omp.env.Session.run", ["session", "script"];
	request session_close, "omp.env.Session.close", ["session"];
	request run_stdin, "omp.env.Run.stdin", ["run", "data"];
	request run_eof, "omp.env.Run.eof", ["run"];
	request run_signal, "omp.env.Run.signal", ["run", "signal"];
	request run_resize, "omp.env.Run.resize", ["run", "rows", "columns"];
	request run_wait, "omp.env.Run.wait", ["run"];
	request run_detach, "omp.env.Run.detach", ["run", "name"];
	stream run_events, "omp.env.Run.events", ["run"];
	request process_info, "omp.env.Process.info", ["name", "generation"];
	request process_restart, "omp.env.Process.restart", ["name", "generation"];
	request process_send, "omp.env.Process.send", ["name", "generation", "data"];
	request process_eof, "omp.env.Process.eof", ["name", "generation"];
	request process_signal, "omp.env.Process.signal", ["name", "generation", "signal"];
	request process_stop, "omp.env.Process.stop", ["name", "generation", "grace"];
	stream process_output, "omp.env.Process.output", ["name", "generation", "after"];
	stream process_states, "omp.env.Process.states", ["name", "generation"];
	request proc_start, "omp.env.proc.start", ["name", "script", "cwd", "env", "pty", "restart", "ready"];
	request proc_ensure, "omp.env.proc.ensure", ["name", "script", "cwd", "env", "pty", "restart", "ready"];
	request proc_list, "omp.env.proc.list", [];
	request proc_adopt, "omp.env.proc.adopt", ["name"];
	request find_files, "omp.env.find.files", ["root"];
	request find_grep, "omp.env.find.grep", ["pattern", "root"];
	stream find_walk, "omp.env.find.walk", ["root"];
	stream find_search, "omp.env.find.search", ["pattern", "root"];
	request blobs_put_bytes, "omp.env.blobs.put", ["data"];
	request blobs_put_path, "omp.env.blobs.put", ["data"];
	request blobs_get, "omp.env.blobs.get", ["ref", "offset", "length"];
	request blobs_stat, "omp.env.blobs.stat", ["ref"];
	request blobs_delete, "omp.env.blobs.delete", ["ref"];
	stream blobs_stream, "omp.env.blobs.stream", ["ref", "offset", "length"];
	request blob_write, "omp.env.BlobWriter.write", ["upload", "chunk"];
	request blob_commit, "omp.env.BlobWriter.commit", ["upload"];
}
