# DESIGN.md: ValueLens and Consumption Central Fabric App

This file records the shipped design: the tokens in [`src/global.css`](src/global.css) and the
shell in [`src/components/app-shell.tsx`](src/components/app-shell.tsx). It follows the design
of the ValueLens and Consumption Central apps (each repo's `app/`), so they look and navigate alike.
The difference is under the screens: those apps compute from uploaded CSVs in the browser, and
this app queries the semantic models live.

## Overview

**North star: the analyst's workbench.** The workspace is quiet and light, and the numbers carry
the colour. A single dark-teal band at the top holds the brand, the product switcher, the actions
and the product's pages as tabs. Below it, white panels sit on a pale green-grey canvas. The layout
follows a reference cost-dashboard design.

Navigation has four levels, always in the same place:

1. **Product switcher**, in the band of the joined app: ValueLens and Consumption Central. A
   product shows only when the app's variant includes it and the app is connected to its model
   (`availableProducts` in [`destinations.ts`](src/components/destinations.ts)). The single-product
   apps have no switcher, and the band's brand is the variant's name (`appName` in
   [`app-variant.ts`](src/lib/app-variant.ts)).
2. **Top tabs**, under the switcher: the product's pages. ValueLens has Summary, Adoption, Value,
   Efficiency, Leaderboards, Work patterns, Readiness, Governance, Feedback and Guide. Consumption
   Central's sections are its tabs.
3. **Segmented sub-views**, under the page title, when a page has more than one section.
4. **Filters**, in a bar under the sub-views. Only the slicers the page uses show. From 640px up,
   the bar sticks to the top as the page scrolls.

**Assumptions**, **Ask**, **Reports**, **Share** and the theme toggle are buttons at the top right
of the band (`placement: "band"` in `destinations.ts`). They keep the product you were on.

## Colours

The tokens are Tailwind theme variables, so every component reads them as utilities such as
`bg-card` and `text-muted-foreground`. Light and dark use the same teal family.

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | `#f3f6f5` | `#0e1615` | The page canvas |
| `card` | `#ffffff` | `#16211f` | Panels, KPI tiles, the page header |
| `foreground` | `#12201e` | `#e8f0ee` | Text |
| `muted-foreground` | `#5f716e` | `#9fb3af` | Notes, labels |
| `border` | `#d9e2e0` | `#2a3a37` | Hairlines |
| `primary`, `ring` | `#0f766e` | `#5fd0bd` | Primary actions, focus, set filters |
| `band` | `#0b3d3a` | `#08201e` | The header band only |
| `band-accent` | `#7fe0cf` | `#7fe0cf` | The active-tab underline and focus inside the band |
| `segment` | `#e8eeec` | `#1f2d2b` | The segmented-control trough |

- **Colour means something.** The `--vl-*` hues keep the CSV apps' roles: teal for licensed
  people, amber for unlicensed people, violet for agents, blue for Cowork, coral for bad.
  `positive`, `negative` and `caution` are the outcome colours on every page.
- **Chart series** come from `--color-data-1` to `-10`. Consumption (`.palette-consumption`) leads
  with the prepaid teal and puts pay-as-you-go amber second.
- **Vega and DataGrid** read the tokens at runtime through `useCssTheme()`, because SVG can't
  resolve `var()`. Don't hard-code colours in screens.

## Typography

- Segoe UI Variable throughout: Display for titles and KPI values, Text for everything else. No
  web fonts.
- Numbers that line up use tabular figures: KPI values, table numbers and axes.
- Page title 21px, section title 16px, panel title 15px, body 14px, labels 12.5px.
- Sentence case everywhere.

## Layout

- The content column is at most 1480px wide, with `--page-x` side padding: 28px, or 16px below
  640px. In-page sticky bars bleed to the column edge with `-mx-[var(--page-x)] px-[var(--page-x)]`.
- Below 640px the band stacks: brand, then the action buttons as icons, then the switcher and the
  tabs, which scroll sideways. Grids drop to one column and tables scroll inside their frame.
- Panels align to the top and never stretch to fill height.

## Elevation and shape

- Mostly flat. Panels and KPI tiles have a 1px `border` and `--shadow-card`. Popovers and sheets
  use `--shadow-16`.
- Corners: 10px for panels and tiles, 7px for controls, 5px for segment buttons. Pills only for
  the switcher and the band buttons.
- No nested cards. An area inside a panel gets a `muted` fill instead.

## Components

- **Band** (`app-shell.tsx`): brand, product switcher (`nav[aria-label=Products]`), band buttons
  (`band-button.ts`, `band-popover.tsx` for Reports and Share), and the tabs
  (`nav[aria-label=Sections]`).
- **Page header** (`report-header.tsx`): product crumb, title, question, data dates, and
  **Download PDF** and **Download PowerPoint**.
- **Sub-views** (`stage-tabs.tsx`): a segmented trough; the active segment is white with a hairline
  shadow.
- **KPI tile** (`kpi-card.tsx`), **section** (`section.tsx`), **segmented control**
  (`segmented-control.tsx`): restyled, with the same props as before.
- **Focus**: a 2px `ring` outline everywhere; `band-accent` inside the band.

## Do's and don'ts

**Do**

- Keep every figure on the model's own DAX measures, queried at the grain the view needs.
- Put new content in a sub-view, not a new top tab.
- Keep caveat text next to the visual it qualifies.

**Don't**

- Pull raw rows to compute in the browser. The Execute Queries API caps a query at 100,000 rows.
- Use population or outcome colours for decoration, gradient text or eyebrow labels.
- Load anything from a CDN or another origin.
