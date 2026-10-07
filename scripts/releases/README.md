# Public release catalog

`catalog.mjs` defines schema version 1 and source validation. The website keeps a byte-identical copy; desktop coordination remains private. Catalog revisions may change availability, but a version/platform/purpose must keep the same package bytes and updater signature. macOS installation DMGs and update archives are different artifacts.

From the product repository root, after building, signing and uploading the existing GitHub release:

```sh
node scripts/releases/generate-catalog.mjs
node scripts/releases/publish-atomgit.mjs                 # local validation and dry run
node scripts/releases/publish-atomgit.mjs --publish       # immutable upload + anonymous full readback
node scripts/releases/publish-atomgit.mjs --publish --acceptance release/atomgit-acceptance.json
node scripts/releases/publish-routing.mjs                # review metadata publication
node scripts/releases/publish-routing.mjs --publish --website ../tianshu-website
```

AtomGit requires the version tag to be mirrored beforehand. The publisher consumes `ATOMGIT_ACCESS_TOKEN` or the system Git credential helper without displaying either. It uses the official upload-address API and PUT headers, then checks the stable anonymous download entry, full SHA-256, size, HEAD and Range. No signed temporary URL is persisted. Missing credentials, login requirements, conflicting existing attachments or failed package checks stop publication. Provider quota and multi-network acceptance still need real measurements; this script does not certify unlimited bandwidth.

Anonymous byte verification alone leaves the source disabled. `--acceptance` must identify `schemaVersion: 1`, the exact `version`, `platform` and `sha256`, plus true `tauriRedirectVerified`, `stableEntryVerified`, `disconnectRetryVerified`, a nonempty `limitsObserved` record and at least two distinct `networks` observations (`name`, `checkedAt`, `passed: true`). Populate these only from actual tests. Without that record, the public package/signature/checksum/standard manifest may be uploaded, but an enabled routing catalog is not published. After qualification, retrying preserves proof timestamps and revision instead of rewriting immutable metadata.

For several platforms, run `--platform <platform> --publish --assets-only` for each intended platform before publishing metadata once. Adding platforms after immutable metadata has already been uploaded requires a new release or a separately reviewed metadata revision; the script refuses to overwrite conflicting existing files. Repeating a partially completed publication preserves verified proof timestamps and the revision.

Only the catalog is published to GitHub/OSS by `publish-routing.mjs`; the existing package upload workflow remains responsible for OSS backup files. It checks an existing GitHub catalog for immutable artifact identity and monotonic revisions, then uploads the small catalog and requests the website's existing `tianshu-release` dispatch. GitHub and OSS permissions plus website dispatch access must be configured on the publishing host. The site's daily deployment remains a compensating run. Files uploaded before a later failure stay in place for idempotent retry.

Old OSS `latest.json` is unchanged unless the operator supplies `--enable-legacy-atomgit`. That option refuses to redirect Windows unless the catalog contains verified anonymous AtomGit evidence and the original signature matches. New clients never select an OSS package automatically; a manual OSS attempt still verifies the original updater signature and catalog SHA-256 before installing. CLI/npm updates are unchanged.

Desktop source and terminal download events are stored in the application's data directory as `update-downloads.jsonl`. `report-routing.mjs <ledger>` reports source choice, fallbacks, success/failure and received bytes. These are client observations, **not** OSS billed egress or website click counts. Retrieve those separately from provider billing/access logs and website analytics.

Checks:

```sh
node --test scripts/releases/catalog.test.mjs
node scripts/releases/verify-restored-defects.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml update_routing --lib
python3 desktop/scripts/verify-update-rust-defects.py
cd desktop
node --import tsx scripts/verify-update-routing.mjs
```

Human-facing release summaries live in `docs/releases/summaries/<version>.json`. Supply both languages and no more than three reviewed highlights. `generate-catalog.mjs` adds the optional `releaseNotesUrl` only when a matching validated summary exists. `publish-routing.mjs` publishes `release-notes.json` before the catalog and refuses to replace different bytes for the same version. The desktop bundles these same files for offline display. Existing catalogs and notes-free releases remain supported.

Before publishing a catalog with `releaseNotesUrl`, a release owner must review both localized summaries and supply `--release-notes-reviewed`. The checked-in 3.28.0 summary is a reviewable initial draft, not evidence of that human approval. No notes or routing data are uploaded by the desktop build.
