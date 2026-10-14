# Mozilla CA certificate bundle

`cacert.pem` is the unmodified Mozilla CA certificate store converted to PEM
and published by the curl project. ZenPlay packages the dated 2026-09-25
revision on Windows so embedded libmpv/curl can validate HTTPS servers without
disabling TLS verification.

The exact source URL, SHA-256 digest and certificate count are recorded in
`source.json`. The bundle is licensed under MPL-2.0; the license text is in
`LICENSE-MPL-2.0.txt`.

To update the bundle, download a dated revision from
<https://curl.se/docs/caextract.html>, verify it against curl's matching
`.sha256` file, update `source.json`, and run the packaging identity and layout
tests. Never replace it with an unpinned `cacert.pem` download.
