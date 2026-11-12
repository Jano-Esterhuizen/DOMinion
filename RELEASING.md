# Releasing DOMinion

Releases are published by GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)) when a version tag is pushed. Nobody publishes from a laptop.

## One-time setup

1. **Package name.** Replace the placeholder `@yourorg/dominion` with the real scope in `package.json`. The code reads the name from `package.json` at runtime: templates, the generated `dominion.setup.ts`, and the `sessionHeaders` import. The tests and docs spell it out, so search and replace in `test/`, `README.md` and here too.
2. **Registry.**
   - Public npm: create an automation token and store it as the `NPM_TOKEN` repository secret.
   - Private registry (GitHub Packages, Artifactory, Nexus): set the repository variable `NPM_REGISTRY_URL` (for example `https://npm.pkg.github.com`) and store that registry's token as `NPM_TOKEN`.
   - Set the repository variable `NPM_ACCESS` to `restricted` for private packages. It defaults to `public`.
3. **License.** Decide on a license, add `LICENSE`, and set `license` in `package.json`. It is `UNLICENSED` until then.
4. **Approvals (optional).** The workflow publishes from the `release` environment. Add required reviewers to that environment in the repository settings if a person should approve each publish.
5. **Changelog links.** Point the compare links at the bottom of [CHANGELOG.md](CHANGELOG.md) at the real repository.

## Each release

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
