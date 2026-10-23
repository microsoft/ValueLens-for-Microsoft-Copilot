<!-- impeccable:product-schema 1 -->
# ValueLens — App Edition

## Platform
A web app hosted as a Copilot Studio / Cowork **Managed App** on the Copilot Managed Runtime. It is designed for desktop first (1280–1600px) and still works at 390px wide.

## Users
- **Adoption and change leads.** They track Microsoft 365 Copilot, Copilot Chat and agent use, and see how habits form. They decide where to focus enablement.
- **Value and ROI owners** in finance or the business. They estimate the hours and value Copilot saves using their own assumptions, and report that value to leadership.
- **IT and licence owners.** They decide who gets a Copilot licence next, which seats to review and reclaim, and where to roll out Cowork.

These users know Microsoft 365 well and often know the Power BI edition already. They open the app weekly or monthly, often to prepare for a review meeting.

## Purpose
This is the app version of the ValueLens Power BI report. It keeps **the same information as the report**: every measure, chart and table, with the same DAX definitions. Navigation is simpler: seven data tabs plus a Guide, with short sub-views, instead of sixteen report pages. The report's parameter tables become an Assumptions sheet: hourly rate, scenario, licence price and grading strictness.

## Data
- The input is the ValueLens CSVs: the processed Copilot interactions, the organisation and licence user list, and optionally the Agent 365 registry and the product feedback export. These are the same files that the Local CSV and SharePoint variants use. The other variants can export them.
- All parsing and calculation happens in the browser. Data never leaves the tenant.
- The app bundles a synthetic sample, which is always clearly labelled as sample data.

## Constraints
- Metric definitions must match the report's DAX. Any deliberate change is listed in the Guide.
- Privacy: behaviour charts on the agent lens show only agents with two or more users.
- No external CDNs, fonts or network calls. The Managed Runtime CSP blocks them.
- Accessibility: WCAG AA contrast, all controls reachable by keyboard, and visible focus.

## Brand and tone
Microsoft-adjacent, calm and analytical. A dark-teal header band over a white working surface, following a reference cost-dashboard design. Labels are in plain English, and the numbers are the hero. Value estimates are shown as estimates, with the report's caveats beside them.

## Anti-goals
- No marketing hero, decorative gradients or illustrations.
- No cards nested inside cards.
- Never drop a report metric to "simplify". Simplify by grouping and navigation instead.
- Never present estimated value as measured savings.
