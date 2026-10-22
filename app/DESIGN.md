---
name: ValueLens (App Edition)
description: Calm analyst workspace for Copilot value, adoption and readiness, computed in the browser from the ValueLens CSVs.
colors:
  canvas: "#f3f6f5"
  surface: "#ffffff"
  surface-2: "#f7faf9"
  ink: "#12201e"
  ink-2: "#445653"
  ink-3: "#5f716e"
  line: "#d9e2e0"
  line-2: "#e9efed"
  band: "#0b3d3a"
  band-ink-2: "#b9d3cf"
  band-accent: "#7fe0cf"
  accent: "#0f766e"
  accent-ink: "#0b5a52"
  accent-soft: "#e6f3f0"
  hover: "#eef5f3"
  licensed: "#0f766e"
  unlicensed: "#b45309"
  agent: "#6d28d9"
  cowork: "#2563eb"
  bad: "#b42318"
typography:
  page-title:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  kpi-value:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.15
    fontFeature: "tnum"
  panel-title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: 1.45
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  pill: "999px"
spacing:
  gutter: "16px"
  page-x: "28px"
  page-x-mobile: "14px"
components:
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "16px 18px 18px"
  kpi:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "14px 16px 15px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "36px"
  segmented-on:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "32px"
  table-header:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-2}"
---

# DESIGN.md: ValueLens (App Edition)

> This file records the shipped build: `src/index.css`, `src/ui/theme.ts` and the components in `src/ui/`. It reuses the AI in One App Edition design kit, so the two apps look and behave the same.

## Overview

**North star: the analyst's workbench.** The workspace is quiet and light, and the numbers carry the colour. A single dark-teal band at the top holds the brand, the Assumptions chip, the data source and the eight tabs. Below the band, white panels sit on a pale green-grey canvas. The layout follows a reference cost-dashboard design.

Navigation has four levels, always in the same place:
1. **Top tabs:** Adoption, Habits, Agents, Value, Fit, Readiness, Feedback, Guide.
2. **Segmented sub-views**, at the right of the page title. For example, Value has Tasks, Estimated value and Signal map.
3. **Filters**, in the toolbar under the title. Only the slicers the view uses are shown, and a filter that is set is tinted.
4. **Lens bar** (`.lens-bar`), above the content of a view. It is a labelled segmented control for a view-level switch: the population lens on Adoption, and the Cowork grading on Fit.

## Colors

- **Colour means something.** Each population colour is used only for that population: in KPI dots, bars, lines and bubbles.
  - Teal `licensed`: licensed users.
  - Amber `unlicensed`: unlicensed users.
  - Violet `agent`: agents.
  - Blue `cowork`: Cowork.
- **Graded data uses fixed palettes from `theme.ts`.**
  - Cowork fit grades (Strong, Fair, Worth a look): `GRADE_COLOR`.
  - Model fit (good match, lighter would do, could use stronger, not judged): `MODEL_COLOR`.
  - Agent lifecycle: `LIFECYCLE_COLOR`.
  - Seat dormancy: `DORMANCY_COLOR`.
  - Habit stages and the heatmap use the teal ramps `STAGE_COLOR` and `HEAT_RAMP`. Never a rainbow.
- `band` is only for the header. `band-accent` is only for the active-tab underline and for focus rings inside the band.
- `accent` (the same hue as `licensed`) marks interactive states: primary buttons, active sort arrows, set filters and selected rows.
- SVG chart colours are hex constants in `theme.ts`. Inside the Managed App host, SVG presentation attributes don't resolve CSS variables reliably.

## Typography

- The whole app uses the Segoe UI Variable family. Display is for page titles, KPI values and sheet titles. Text is for everything else. There are no web fonts, because the host's CSP blocks them.
- Numbers that line up use `font-variant-numeric: tabular-nums`: KPI values, table numbers, bar values and axes.
- The type scale is small:
  - Page title: 21px.
  - Section title: 16px.
  - Panel title: 15px.
  - Body: 14px.
  - Labels and notes: 12.5px.
- Use sentence case everywhere. The only uppercase is the small lens-bar label.

## Layout

- The content column is at most 1480px wide, with 28px side padding. At 600px and below the padding drops to 14px.
- **KPI row:** a row of tiles that wraps, each at least 170px wide.
- **Headline row:** one or two pale teal callouts above the KPIs. They carry the report's narrative headline measures.
- **Panel grids:** `grid-2`, `grid-3`, `grid-2-1` and `grid-1-2`, with a 16px gap.
  - Panels align to the top, so they never stretch to fill empty height.
  - Wide tables always take the full width.
- Grid tracks that contain charts must be `minmax(0, 1fr)`. Charts measure their own width, and an `auto` track locks them at the first size they measure.
- Panel headers wrap, so a segmented control in a header (for example "Group by" on Model fit) moves under the title on narrow screens.
- **Breakpoints:**
  - 1100px: three-column grids become two.
  - 900px: every grid becomes one column, and the toolbar stacks.
  - 600px: the filters become a two-column grid, and the KPIs show two per row.
  - Tables scroll sideways inside their own frame.

## Elevation & Depth

The design is mostly flat. Panels and KPIs have a 1px `line` border and a hairline shadow: `0 1px 2px rgb(16 40 37 / .06)`.

The only real elevation is `0 8px 28px rgb(16 40 37 / .18)`. It is used for tooltips, info pops and dialogs.

There are no nested cards. An area inside a panel gets a `surface-2` fill instead of another bordered box. Examples are the stat grid, the file drop and the definitions list.

## Shapes

- Corner radius:
  - Panels and KPIs: 10px.
  - Controls: 7–8px.
  - Bars: 2–3px.
- Pills (999px) are only for status: the source chip, the Assumptions chip, review tags and child counts.

## Components

- **KPI tile:**
  - A coloured population dot, the label and an info button with the report's glossary text.
  - Then the value, and a line underneath with context (for example "of 160 graded").
- **Panel:** the title on the left, with an optional note and an info button.
  - The note says in plain words what the visual counts.
  - `.panel-foot` holds the report's caveat text under a visual.
- **Charts:**
  - **BarList:** ranked bars, with an optional "Show all N" and a hint line under each label.
  - **Stack100:** 100% stacked rows. Selecting a row filters the table next to it.
  - **Tornado:** a two-sided bar comparing active and inactive users.
  - **ColumnChart** and **LineChart:** for trends.
  - **Scatter:** bubble charts on the Readiness views.
  - **Distribution:** a single proportion bar.
  - **Heatmap**, **TermCloud**.
- Treemaps, donuts and pies from the report become ranked bars or a proportion bar, with the same values.
- **DataTable:**
  - Fixed layout, sortable headers and search.
  - An Organisation > Person tree, with a twisty and a child count. The tree column is always the first column. Put rank or score columns after it.
  - Numbers are right-aligned and tabular. In-cell bars sit in a grey track.
  - Long text is clipped, with the full value in `title`.
  - "Show more" pages through the rows.
- **Agent drawer:** a native `<dialog>` side sheet showing one agent's registry details and usage.
- **Assumptions sheet:** opened from the Assumptions chip. It replaces the report's parameter tables.
- **Data source dialog:** a centred sheet with a file drop. It also reloads the sample.
- **Segmented control:** a grey trough. The active segment is white, with a hairline shadow.
- **Focus:** a 2px `accent` outline with a 2px offset everywhere. Inside the header band, `band-accent` is used instead.

## Do's and Don'ts

**Do**
- Keep every Power BI measure, chart and table. To simplify, reorganise them into tabs and views. Don't drop them.
- Put each metric's definition behind its info button, sourced from the report's glossary.
- Keep the report's caveat and notice text next to the visual it qualifies.
- Put new content in a sub-view, not a new top tab.

**Don't**
- Use eyebrow labels, gradient text, or side-stripe accents thicker than 1px.
- Use population or grade colours for decoration.
- Load anything from a CDN or another origin.
- Add motion beyond the sheet entrance and the spinner. Respect `prefers-reduced-motion`.
