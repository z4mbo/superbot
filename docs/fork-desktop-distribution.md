# Fork macOS releases

A fork of Superbot can publish signed macOS updates through the existing `release-desktop`
workflow. Set the repository variable `DESKTOP_RELEASE_MAC_ONLY` to `true` to build only macOS.
Leaving it unset (or `false`) retains the normal three-platform release. Use macOS-only mode only
for repositories that distribute macOS exclusively: making a partial release the latest release
interrupts update checks for existing Windows and Linux installations. The packaged macOS update
feed points to the repository running the workflow; the app identity and signing checks stay
unchanged.

Configure these repository secrets for your own signing account (see
[desktop releases](desktop-release.md) for every platform's credentials):

- `DESKTOP_MAC_CSC_LINK`: base64-encoded Developer ID Application certificate and private key in a P12.
- `DESKTOP_MAC_CSC_KEY_PASSWORD`: the P12 password.
- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`: an account API key authorized for notarization.
- `DESKTOP_MAC_PROVISIONING_PROFILE` (optional): enables system passkeys; without it the build hides them.

Keep certificates and keys out of the repository. The workflow requires code signing,
notarization, ticket verification and matching update metadata before publishing, and fails
without them rather than shipping an unsigned build. A distribution certificate used for iPhone
builds is not a Developer ID Application certificate.

The workflow requires a branch named `main`, and the release tag must point to a commit on it.
Prepare a normal version and changelog release, merge it into `main` after review, then tag that merge.
The workflow validates the tag and publishes installers and update metadata only after every
selected platform succeeds. Users switching from an app signed by another team must install
the first fork release manually; later updates must retain the fork's signing identity.

Only the macOS feed follows the repository running the workflow. Windows and Linux builds keep the
feed in `apps/desktop/package.json`, and Linux AppImage updates are verified against the public
key compiled into the app, so a fork shipping those platforms changes both first.
