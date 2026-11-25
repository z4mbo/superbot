/** Where official desktop releases are published; a fork changes it with its update key. */
export const RELEASES_URL = "https://github.com/z4mbo/superbot/releases";
export const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/** The page a system-package install sends the user to for a newer release. */
export function releasePageUrl(version: string) {
  if (!RELEASE_VERSION.test(version)) throw new Error("A release version is required.");
  return `${RELEASES_URL}/tag/v${version}`;
}
