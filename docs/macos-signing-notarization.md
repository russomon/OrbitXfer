# macOS Signing & Notarization

OrbitXfer macOS releases should be both code signed and notarized so Gatekeeper does not flag the app as damaged.

## What OrbitXfer now expects

- The Electron app is built with hardened runtime enabled.
- The bundled Rust CLI at `Contents/Resources/orbitxfer-iroh-cli` is explicitly signed as nested code.
- Tagged GitHub releases require both code-signing and notarization secrets on the macOS runner.
- The release can be checked locally with `npm run verify:mac:release`.

## Local prerequisites

1. Join the Apple Developer Program.
2. Install Xcode and accept its license.
3. Install a `Developer ID Application` certificate into your login keychain.
4. Create an App Store Connect API key for notarization, or create a `notarytool` keychain profile if you prefer local keychain credentials.
5. Run `security find-identity -v -p codesigning` and make sure your `Developer ID Application` certificate appears under `Valid identities only` before you attempt a signed local build.

## Local signed build

1. Copy `OrbitXfer-iroh-gui/electron-builder.env.example` to `OrbitXfer-iroh-gui/electron-builder.env`.
2. Replace the placeholder values with your real certificate identity and notarization credentials.
3. Build the Rust CLI:

   ```bash
   cd OrbitXfer-iroh-cli
   cargo build --release
   ```

4. Build the signed mac app:

   ```bash
   cd ../OrbitXfer-iroh-gui
   npm run build:mac
   ```

5. Verify the finished app:

   ```bash
   npm run verify:mac:release
   ```

## GitHub Actions secrets

Configure these repository secrets before cutting a tagged release:

- `CSC_LINK`: base64-encoded exported `.p12` for your `Developer ID Application` certificate.
- `CSC_KEY_PASSWORD`: password used when exporting that `.p12`.
- `APPLE_API_KEY`: contents of the `AuthKey_<KEYID>.p8` App Store Connect API key file.
- `APPLE_API_KEY_ID`: the 10-character App Store Connect key ID.
- `APPLE_API_ISSUER`: the App Store Connect issuer UUID.

The workflow writes the API key secret to a temporary `.p8` file on the macOS runner, exports the variables that `electron-builder` expects, builds the app, and then runs `npm run verify:mac:release` on tagged releases.

## Notes

- Untagged local or CI builds can still complete without those secrets, but they will remain unsigned or unnotarized.
- If a tagged macOS release is missing signing or notarization secrets, the workflow now fails instead of silently publishing an unsafe build.
- If `electron-builder` reports `CSSMERR_TP_NOT_TRUSTED`, the certificate is present but not trusted enough for signing; repair the certificate chain in Keychain Access before retrying.
