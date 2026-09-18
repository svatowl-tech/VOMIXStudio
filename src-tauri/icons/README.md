# VOMIXStudio Application Icons

The Tauri v2 build pipeline requires application icon assets in `src-tauri/icons/`:

- `32x32.png`: 32x32 pixel PNG icon (taskbar / small icon)
- `128x128.png`: 128x128 pixel PNG icon (installer / desktop icon)
- `128x128@2x.png`: 256x256 pixel PNG icon (high DPI display icon)
- `icon.ico`: Windows multi-resolution icon container (16x16, 32x32, 48x48, 256x256)
- `icon.icns`: macOS icon container (optional for cross-platform builds)

To automatically generate all icon formats from a single `icon.png` (512x512) source file, run:

```bash
npx tauri icon public/icon.png
```
