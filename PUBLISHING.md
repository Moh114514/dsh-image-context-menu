# Publishing / 发布

Approved publication identity: **Moh114514**, repository **Moh114514/dsh-image-context-menu**, MIT, GitHub Release distribution. No npm publication is required for this release.

## Release checklist

1. Build and run the tests and package checks from the README.
2. Inspect `npm pack --dry-run --ignore-scripts` before packing. Never include local profile files, accounts, credentials, generated user images, conversation logs or machine paths.
3. Commit the source, tests and matching built `lib` artifacts.
4. In GitHub Actions run **Publish release** with `version: 0.1.0`. It checks the version, tests, builds and packs, then publishes `v0.1.0` with the prebuilt archive and SHA-256 checksum. It uses only the repository-scoped `GITHUB_TOKEN` with `contents: write`; no personal token or npm login is needed.
5. Verify the release asset can be downloaded and installed before requesting market inclusion. The workflow can also be triggered by pushing the matching `v0.1.0` tag.

There are no install-time build hooks. The custom build script only combines this repository's browser-safe modules into the Harness lazy-factory format, importing React from the existing client module table.

## Community market submission

The installed community market reads the [awesome-dsh-plugin catalog](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), not a direct package-upload API. Follow its [current contribution rules](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md).

- The repository must be **at least one day old**; a new release does not bypass this gate.
- Add the `dsh-plugin` repository topic.
- Fork the catalog, add only `data/plugins/Moh114514__dsh-image-context-menu.yml`, and submit a PR to `main`.
- The proposed entry is under `market/` in this repository. Its `tarball` URL is valid only **after** the matching Release exists.
- Do not edit the catalog's generated README files.
- Passing CI is not approval; a catalog maintainer reviews the implementation. Submission, release publication and market listing are different states, and no listing time is guaranteed.

该仓库刚创建时，不能声称已经上架：应先完成公开发行，满一天后按目录规则提交收录 PR，等待 CI 与维护者审核。不要为了绕过仓库年龄限制修改其他条目或伪造创建时间。
