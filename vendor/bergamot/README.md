# Bergamot translation engine and English → Chinese model

Everything here is from Mozilla, unchanged, under the Mozilla Public License
2.0 (`LICENSE`). MinBrowser uses it to translate English pages to Simplified
Chinese on the user's computer, without any network access.

## `bergamot-translator.js` — the engine's JavaScript loader

- Copied from Firefox: `toolkit/components/translations/bergamot-translator/bergamot-translator.js`
- From: Firefox release 159.0.2 (github.com/mozilla-firefox/firefox, branch `release`)
- Engine release v0.6.0, revision `eea6e5a80aa4ddd86d9cc35ce9a65b79aa3ab96d` (github.com/mozilla/translations)
- SHA-256: `faff1ef6285b0d26f01787776fd49299dfb756ecb9688aa990c250e66797b47d`

## `models/` — the engine (WebAssembly) and the language model

zstd-compressed exactly as Mozilla publishes them in Firefox's Remote Settings:

| File | Remote Settings record |
|---|---|
| `engine.wasm.zst` | `translations-wasm-v2`: bergamot-translator 4.0 (matches the loader above) |
| `model.enzh.zst` | `translations-models-v2`: model.enzh.intgemm.alphas.bin, en → zh-Hans 3.0, base-memory |
| `lex.enzh.zst` | `translations-models-v2`: lex.50.50.enzh.s2t.bin, same model |
| `srcvocab.enzh.zst` | `translations-models-v2`: srcvocab.enzh.spm, same model |
| `trgvocab.enzh.zst` | `translations-models-v2`: trgvocab.enzh.spm, same model |

The SHA-256 of each file, compressed and decompressed, is pinned in
`src/main/translation-models.ts` (taken from the records' `attachment.hash`
and `decompressedHash`) and checked every time the files are loaded.

They ship with MinBrowser instead of being downloaded at run time because
Mozilla's attachment server (firefox-settings-attachments.cdn.mozilla.net)
refuses requests from Chromium-based browsers (HTTP 406).

## Updating

1. List the records (this works from any program):
   `https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/changeset?_expected=0`
   and the same for `translations-wasm-v2`. Pick the newest released en → zh-Hans
   version (no letter in the version, empty `filter_expression`) that the engine supports.
2. Download each `attachment.location` from
   `https://firefox-settings-attachments.cdn.mozilla.net/` with a tool that is not a
   browser (e.g. curl), check its SHA-256 against `attachment.hash`, and save it here
   under the names above.
3. Update the hashes in `src/main/translation-models.ts` and this table.
4. If the engine (WASM) changes, copy the loader from the matching Firefox release too:
   a loader and a WASM build must belong together.
5. Run the tests: `npm test` checks the files against the pinned hashes, and
   `npm run test:e2e` translates a page with the real engine.
