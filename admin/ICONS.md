# Admin icon registry

House rules for icons in the Hands admin (agreed in the icons/charts batch).
New icons must be added to the table below in the same PR.

## Spec

| Item | Rule |
| --- | --- |
| Sizes | **16px** UI icons (`size-4` / `h-4 w-4`); **20px** brand mark (logo) and only where a larger lead glyph is structurally needed; **36px** = chip container size — the glyph inside stays 16px |
| Stroke | fixed **2** (lucide default); no per-site overrides |
| Chips | soft fill, **no outline**: `bg-fill-muted` container + `text-foreground-muted` glyph (glyph ≥3:1 vs fill; verified elegant 9.9 / dark 7.4 / brutal 4.8–11) |
| Empty states | RUI `EmptyStateIcon` slot, rendered monochrome and `aria-hidden`; slot sizes the glyph per theme — elegant: 18px inside a soft-fill chip, brutal: 36px plain |
| Alignment | icon + text baselines via flex (`items-center`), never manual margins |
| Brand/platform marks | lucide approximations only; official brand glyphs and brand colors are **deferred** — brand hues would compete with status-color semantics in the same rows |
| Ad-hoc sizes | none (no 18px tier, no inline overrides) |

## Registry

| Surface | Icons |
| --- | --- |
| Sidebar nav (`App.tsx`) | Gauge (Overview) · Radio (Channels) · Rocket (Releases) · Package (Builds) · Plane (TestFlight) · Store (App Store) · Share2 (Shares) · MessageSquare (Feedback) · Bug (Crashes) · AlertTriangle (Errors) · Plug (Integrations) · ScrollText (Audit) · Settings |
| Shell controls | PanelLeftClose/PanelLeftOpen (sidebar) · ChevronDown (disclosure) · ChevronsUpDown (org switch) · Check (selection) · Plus (create) · LayoutGrid |
| Platform chips | Apple (TestFlight) · Play (Google Play) · Smartphone (AppGallery) |
| Status/badges | Archive (archived app) · AlertTriangle (attention) · Check (configured) · Package (product types) · Rocket (channels) |
| Empty states | AlertTriangle (errors) · Bug (crashes) · Package (builds) · Plane (TestFlight) · Share2 (shares) · LayoutGrid (apps list) |
| Charts | (no icons; series identified by legend swatches) |

## Chart series tokens

Series colors live in `src/index.css` as `--chart-*` custom properties:
light surfaces use darkened amber/green (≥3:1 vs canvas), dark surfaces keep
the brighter originals (3.5–9.6:1). Axis/legend text stays on
`--foreground-muted` (4.9–10.9:1 measured). Do not hard-code series hexes in
components.
