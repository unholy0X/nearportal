# Aurora Portal logo assets

Current NearPortal identity. Source: the approved Aurora Portal reference in `design/aurora-portal/approved-logo-concept.png`.

## Assets

- `symbol.png`: full-color transparent mark for landing artwork and large brand placements.
- `logo-horizontal-light.png`: transparent lockup with plum lettering, for light surfaces.
- `logo-horizontal-dark.png`: opaque plum-background lockup with light lettering, for matching dark surfaces.
- `app-icon-master.png`: opaque square app artwork, no baked-in outer corner radius.
- `x-avatar-master.png`: opaque square profile picture with room for a circular crop.
- `favicon.ico`: 16/32/48-pixel PNG entries in an ICO container.
- `favicon-16.png`, `favicon-32.png`, `favicon-48.png`: browser icon exports.
- `apple-touch-icon.png`: 180-pixel touch icon.
- `app-icon-192.png`, `app-icon-512.png`, `app-icon-1024.png`: app/PWA artwork exports.
- `x-avatar-400.png`: profile-picture export.

Generated using built-in imagegen, then resized with macOS sips. Transparency is preserved for the symbol and light-background horizontal lockup. The dark lockup has a baked-in plum background because the transparent generation produced matte artifacts. All files are raster assets; they are not outlined vector masters. Generated variants should be compared with the approved reference before final brand publication.

Use the app icon for tiny browser and mobile placements; use the detailed symbol at larger sizes. Use the avatar for circular social crops. Keep the original aspect ratio and clear space. Do not add a second gradient, shadow, or glow.

These assets are prepared for later integration; the existing website favicon and header have not been replaced.
