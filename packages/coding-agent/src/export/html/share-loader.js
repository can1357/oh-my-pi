    (function() {
      'use strict';

      // ============================================================
      // SHARE VIEWER BOOTSTRAP
      // ============================================================
      //
      // Served by the omp relay at /s/<id>; the AES-256-GCM key rides in the
      // URL fragment and never leaves the browser. Resolves the session JSON
      // and hands it to template.js via `window.__OMP_SESSION_DATA__`:
      //   1. hex ids -> secret GitHub gist holding base64(sealed blob)
      //   2. anything else -> relay blob store at /s/<id>/raw
      // Sealed layout: [12B IV][AES-256-GCM(gzip(session JSON))].

      var GIST_ID_RE = /^[0-9a-f]{20,64}$/;
      var SHARE_PATH_RE = /\/s\/([A-Za-z0-9_-]{10,64})\/?$/;

      function decodeBase64(text) {
        var binary = atob(text);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }

      function decodeBase64Url(text) {
        var b64 = text.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        return decodeBase64(b64);
      }

      async function fetchGistBlob(id) {
        var res = await fetch('https://api.github.com/gists/' + id, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (res.status === 404) throw new Error('This share no longer exists (gist deleted?).');
        if (!res.ok) throw new Error('Gist fetch failed: HTTP ' + res.status);
        var gist = await res.json();
        var files = Object.values(gist.files || {});
        var file = files.find(function(f) { return /\.ompshare\.txt$/.test(f.filename); }) || files[0];
        if (!file) throw new Error('Gist has no files.');
        var text = file.content;
        if (!text || file.truncated) {
          var raw = await fetch(file.raw_url);
          if (!raw.ok) throw new Error('Gist raw fetch failed: HTTP ' + raw.status);
          text = await raw.text();
        }
        return decodeBase64(text.replace(/\s+/g, ''));
      }

      async function fetchServerBlob(id) {
        var res = await fetch('/s/' + id + '/raw');
        if (res.status === 404 || res.status === 410) {
          throw new Error('This share no longer exists (expired or deleted).');
        }
        if (!res.ok) throw new Error('Share fetch failed: HTTP ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
      }

      async function load() {
        var match = SHARE_PATH_RE.exec(location.pathname);
        if (!match) throw new Error('Bad share URL; expected /s/<id>.');
        var keyText = location.hash.replace(/^#/, '');
        if (!keyText) throw new Error('Share link is missing its #key fragment; paste the full link.');
        var keyBytes;
        try {
          keyBytes = decodeBase64Url(keyText);
        } catch (_err) {
          throw new Error('Share key is not valid base64url.');
        }
        if (keyBytes.length !== 32) throw new Error('Share key must decode to 32 bytes.');

        var id = match[1];
        var sealed = await (GIST_ID_RE.test(id) ? fetchGistBlob(id) : fetchServerBlob(id));
        if (sealed.length <= 12) throw new Error('Sealed session blob is truncated.');

        var key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
        var plain;
        try {
          plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: sealed.subarray(0, 12) },
            key,
            sealed.subarray(12)
          );
        } catch (_err) {
          throw new Error('Decryption failed: wrong or corrupted #key.');
        }

        var data = await new Response(
          new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))
        ).json();
        if (data && data.header && data.header.title) {
          document.title = data.header.title + ' — omp session';
        }
        return data;
      }

      var pending = load();
      // template.js surfaces the failure in-page; swallow the duplicate here
      // so the console does not report an unhandled rejection.
      pending.catch(function() {});
      window.__OMP_SESSION_DATA__ = pending;
    })();
