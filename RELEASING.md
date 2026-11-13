# Releasing DOMinion

Releases are published by GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)) when a version tag is pushed. Nobody publishes from a laptop.

## Where it is published

- **Package:** `dominion-playwright` on the public npm registry. Anyone can run `npm install -D dominion-playwright`. The command it installs is `dominion`.
- **License:** proprietary, in [LICENSE](LICENSE); `package.json` says `SEE LICENSE IN LICENSE`. Anyone may install and run the unmodified package. Nobody may copy, modify, reuse or redistribute its code, prompts or templates. Files it generates belong to the people who generate them. npm always includes `LICENSE` in the package.
- **Provenance:** each release is published with npm provenance, which links the package to the GitHub commit and workflow that built it. npm only accepts provenance from a public repository, so keep this repository public, or remove `--provenance` from the workflow.
- The code reads the package name from `package.json` at runtime: templates, the generated `dominion.setup.ts`, and the `sessionHeaders` import. If the name ever changes, search and replace it in `test/`, `README.md` and `CHANGELOG.md` too.

## One-time setup

1. **npm account.** Sign in at [npmjs.com](https://www.npmjs.com) and turn on two-factor authentication.
2. **Token.** Create a granular access token with read and write access to packages:
   - Allow it to bypass two-factor authentication, so CI can publish.
   - Choose all packages for now: `dominion-playwright` doesn't exist until the first publish.
3. **Store the token** as the repository secret `NPM_TOKEN` (GitHub → Settings → Secrets and variables → Actions). Leave the variables `NPM_REGISTRY_URL` and `NPM_ACCESS` unset: they default to public npm and public access.
4. **After the first publish,** replace the token with one that can publish only `dominion-playwright`.
5. **Approvals (optional).** The workflow publishes from the `release` environment. Add required reviewers to that environment in the repository settings if a person should approve each publish.

## First release (0.1.0)

`package.json` is already at 0.1.0, so tag that version instead of bumping it:

1. Make sure `main` is pushed and green in CI.
2. In `CHANGELOG.md`, replace `## [0.1.0] - unreleased` with today's date, for example `## [0.1.0] - 2026-11-20`, and commit.
3. Tag and push:

   ```sh
   git tag -a v0.1.0 -m "release: v0.1.0"
   git push origin main --follow-tags
   ```

## Each later release

1. Make sure `main` is green in CI.
2. Pick the version with semver. A change to a default prompt that alters generated output is at least a **minor** version.
3. Move the `[Unreleased]` notes in `CHANGELOG.md` under the new version with today's date. Prompt changes go under **Prompts**.
4. Bump the version and tag it:

   ```sh
   npm version 0.2.0 -m "release: v%s"   # updates package.json and package-lock.json, commits, tags v0.2.0
   git push --follow-tags
   ```

5. The release workflow then:
   - checks that the tag matches `package.json`;
   - runs the typecheck and the full test suite;
   - builds the CLI, library and UI;
   - verifies the package contents with `npm pack --dry-run`;
   - publishes (with npm provenance on the public registry);
   - creates a GitHub release from the changelog section.

To check the tarball locally before tagging, run `npm run build && npm pack --dry-run`.
