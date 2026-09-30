# mcpv brand assets

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="mcpv-lockup-dark.svg">
    <img src="mcpv-lockup-light.svg" height="64" alt="mcpv">
  </picture>
</p>

The mark is **`[v]`**: the brackets from `[redacted]`, the mask mcpv puts over
every secret, around a v. Use these files whenever you need to show mcpv, in a
README, a blog post, a slide or an integration list.

## Files

| File | What it is | Use it for |
| --- | --- | --- |
| [`mcpv-logo-light.svg`](mcpv-logo-light.svg) | Mark, white tile | Light backgrounds |
| [`mcpv-logo-dark.svg`](mcpv-logo-dark.svg) | Mark, dark tile | Dark backgrounds |
| [`mcpv-logo.svg`](mcpv-logo.svg) | Mark that follows the system light/dark setting | Favicons, and apps that follow the system theme (it's the mcpv web UI's icon) |
| [`mcpv-lockup-light.svg`](mcpv-lockup-light.svg) | Mark + "mcpv", dark text | Headers and banners on light backgrounds |
| [`mcpv-lockup-dark.svg`](mcpv-lockup-dark.svg) | Mark + "mcpv", light text | Headers and banners on dark backgrounds |
| [`png/`](png/) | PNG exports, transparent background | Places that don't take SVG |

PNG sizes: `mcpv-logo-{light,dark}-{16,32,64,128,256,512}.png`, and
`mcpv-lockup-{light,dark}@2x.png` (370×128) / `@4x.png` (740×256).

Prefer the SVGs: they're sharp at any size and a few hundred bytes. The
wordmark in the lockups is outlined (Geist SemiBold), so it looks the same
without the font installed.

## Which one do I use?

**In a GitHub README or Markdown doc.** Let GitHub pick the variant for the
reader's theme:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mcpmastersh/mcpv/main/brand/mcpv-logo-dark.svg">
  <img src="https://raw.githubusercontent.com/mcpmastersh/mcpv/main/brand/mcpv-logo-light.svg" width="48" height="48" alt="mcpv">
</picture>
```

Swap in `mcpv-lockup-*.svg` (and use `height="48"` without a width) to show the
name next to the mark.

**As a website favicon.** Use the adaptive SVG, with a PNG fallback:

```html
<link rel="icon" href="mcpv-logo.svg" type="image/svg+xml">
<link rel="icon" href="png/mcpv-logo-light-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="png/mcpv-logo-light-256.png">
```

**On a page with its own light/dark toggle.** Show `mcpv-logo-light.svg` in light
mode and `mcpv-logo-dark.svg` in dark mode. The adaptive file follows the system
setting, not your page's toggle.

**Social cards, app stores, avatars.** `png/mcpv-logo-{light,dark}-512.png`.

**In a list of integrations or tools.** The mark on its own, at the same size as
the other logos in the list.

## Colors

| | Light | Dark |
| --- | --- | --- |
| Tile | `#ffffff`, edge `#e1e1e8` | `#121216`, edge `#2e2e39` |
| Brackets | `#5a46f0` | `#8b7bff` |
| v | `#121216` | `#ffffff` |
| Wordmark | `#121216` | `#f2f2f5` |

## Please

- **Keep the tile.** The mark is designed as a rounded square; don't use the
  brackets or the v on their own.
- **Leave room.** Keep clear space of at least a quarter of the mark's width on
  every side (16 px around a 64 px mark).
- **Don't go below 16 px** for the mark, or 24 px tall for a lockup.
- **Match the background.** Light files on light backgrounds, dark files on
  dark ones.
- **Don't change it.** No recoloring, stretching, rotating, outlines, shadows
  or effects, and don't set "mcpv" in another font next to the mark: use a
  lockup file instead.
