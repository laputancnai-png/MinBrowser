# Bergamot translation engine (JavaScript loader)

`bergamot-translator.js` is the Emscripten loader for Mozilla's Bergamot
translation engine, copied unchanged from Firefox's source:

- File: `toolkit/components/translations/bergamot-translator/bergamot-translator.js`
- From: Firefox release 159.0.2 (github.com/mozilla-firefox/firefox, branch `release`)
- Engine release v0.6.0, revision `eea6e5a80aa4ddd86d9cc35ce9a65b79aa3ab96d` (github.com/mozilla/translations)
- SHA-256: `faff1ef6285b0d26f01787776fd49299dfb756ecb9688aa990c250e66797b47d`
- License: MPL-2.0 (see `LICENSE`)

The matching WebAssembly binary is not stored here. MinBrowser downloads it on
first use from Mozilla's Remote Settings (`translations-wasm-v2`, record
`bergamot-translator` 4.0) and only accepts the exact file pinned in
`src/main/translation-models.ts`, because a loader and a WASM build must match.

To update: copy the new loader from the same Firefox path, then pin the WASM
record that Firefox release uses alongside it.
