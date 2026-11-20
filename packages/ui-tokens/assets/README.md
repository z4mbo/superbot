# Application icons

Edit [the Superbot logo](../../../superbot-site/assets/logo.svg) and run
`pnpm --filter @rakazo/ui-tokens export:brand` to regenerate the platform icons.
The white circle is centred on both axes. The two eyes have equal dimensions,
opposite horizontal offsets and the same vertical centre.

The native Linux launcher and the website use the SVG. Windows uses a multi-size
ICO, and the native Mac installer builds its ICNS from a 1024-pixel PNG with Dock
margins. Electron on macOS and Expo on iOS use the generated face in
`Superbot.icon`. The Apple Watch target uses the opaque mobile icon.

Android composites the adaptive foreground on a black background. The face fits
inside the launcher's mask, and the themed launcher and notification use its alpha
silhouette. The mobile splash uses the rounded mark so both eyes remain visible
in light and dark appearances.

## Rakazo artwork

`Rakazo.icon` supplies the Rakazo marketing exports. The animated Rakazo avatar
uses SVG paths and gradients in `logo-avatar-art.ts` based on the orange
foreground's contour. To refresh the marketing social cards after exporting,
run `pnpm exec tsx apps/www/src/marketing/scripts/render-og.mjs`. Set
`CHROME_PATH` when Chrome is installed outside that script's default location.
