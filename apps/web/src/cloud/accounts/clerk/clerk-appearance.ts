/**
 * The sign-in form drawn with the app's own tokens. Each value is a CSS variable, so the form
 * follows the page's light or dark theme and the instance theme without being told.
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: "var(--primary)",
    colorPrimaryForeground: "var(--primary-foreground)",
    colorForeground: "var(--foreground)",
    colorMuted: "var(--muted)",
    colorMutedForeground: "var(--muted-foreground)",
    colorBackground: "var(--background)",
    colorInput: "var(--background)",
    colorInputForeground: "var(--foreground)",
    // The service draws borders as a small share of this color; the app's own borders are the
    // foreground at low alpha, so the result matches them.
    colorBorder: "var(--foreground)",
    colorRing: "var(--ring)",
    colorDanger: "var(--destructive)",
    colorShadow: "transparent",
    fontFamily: "var(--font-sans)",
    fontFamilyButtons: "var(--font-sans)",
    borderRadius: "var(--radius)",
  },
  elements: {
    cardBox: { boxShadow: "none", border: "1px solid var(--border)" },
    // Flat, like the app's own primary button.
    formButtonPrimary: {
      boxShadow: "none",
      "&::after": { display: "none" },
      "&:hover": { backgroundColor: "var(--primary-hover)" },
    },
  },
  options: {
    socialButtonsVariant: "blockButton",
    // A development instance's banner warns the developer; the people signing in cannot act on it.
    unsafe_disableDevelopmentModeWarnings: true,
  },
} as const;
