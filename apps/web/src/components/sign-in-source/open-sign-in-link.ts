/**
 * Open a link a sign-in source returned, exactly as it came. An app link (a scheme of the
 * provider's own) is handed to the system by navigating to it, which leaves this page in place; a
 * web link opens in a new tab, which the desktop app hands to the system browser.
 */
export function openSignInLink(link: string): void {
  if (link.startsWith("https:")) {
    window.open(link, "_blank", "noopener,noreferrer");
    return;
  }
  window.location.assign(link);
}
