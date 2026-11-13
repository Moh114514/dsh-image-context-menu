# Changelog

## 0.1.3

- Right-click menus for **images you send yourself**: the companion now shadows Codex's enhanced previews on `conversation.chat.user.images`, `conversation.chat.message.images`, `tool.call.images` and `conversation.trajectory.images` one priority layer above them, so those galleries get the same five actions while the upstream component keeps rendering every preview.
- User images are read through the session's attachment RPC (`remote.session.attachment`) and validated by media type, byte size and dimensions, plus SHA-256 whenever the attachment id is a digest. Reveal stays disabled for them because an attachment carries no host path.
- Fix activation on hosts that expose the remote service without the nested one: `inject` now declares `remote` next to `remote.session`, which previously threw `cannot get property "remote" without inject` during apply.
- `scripts/check-codex-contract.mjs` also verifies the four keyless preview slots, their `-10` priority and the `codexMessageImages`/`codexImageThumb` classes.
- Declare a storefront screenshot in `screenshots.json` and show it in both READMEs: a real capture of the five-item menu on Harness 0.2.2-rc.1 with dsh-codex-subscription 3.2.10. `scripts/check-package.mjs` validates that file (1-8 entries, relative PNG/JPEG/WebP paths that exist and are non-empty).

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
