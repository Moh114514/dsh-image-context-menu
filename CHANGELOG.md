# Changelog

## 0.1.2

- Re-check the adapter against `dsh-codex-subscription` **3.2.11** (current latest): the card slot key, tool-view key, viewer overlay id, `dcsiv-*` classes and the `image/original/chunk` payload are unchanged from 3.2.6/3.2.7.
- Add `scripts/check-codex-contract.mjs`, which verifies those slot keys, viewer classes, chunk size and asset-id pattern against any installed upstream build, and cross-checks them with `src/core.js`.
- No adapter logic changes; the declared ranges stay `engines.dsh >=0.2.2-rc.1 <0.2.3-0` and peer `dsh-codex-subscription >=3.2.6 <3.3.0`.

## 0.1.1

- Track dsh-codex-subscription 3.2.7: the injected card, tool-row and viewer surfaces are unchanged from 3.2.6, so the adapter code is untouched.
- Declare an explicit range instead of one pinned release: `dsh-codex-subscription >=3.2.6 <3.3.0`.
- Replace the exact `engines.dsh` pin with `>=0.2.2-rc.1 <0.2.3-0`, which keeps prerelease hosts installable and admits the 0.2.2 stable line.
- State ranges rather than a single version in the README, the publishing notes and the bilingual market metadata.

## 0.1.0

- Independent companion plugin; does not overwrite installed plugin files.
- Five original-image operations on Codex-generated cards and its enhanced viewer.
- Session-authorized chunk reads with metadata, size and SHA-256 verification.
- Browser tabs and Desktop Harness image tabs.
- Preserve composer text; never automatically send a message.
- Scope wrappers to Codex 3.2.6 and declare the tested Harness 0.2.2-rc.1 compatibility.
