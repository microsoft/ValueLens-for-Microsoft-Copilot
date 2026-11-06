# Customise ValueLens

Start with a copy. The CSV app, model-backed Fabric/Azure apps and Power BI report
have separate settings: a change in one does not automatically change the others.
Archived standalone Power Automate + Dataverse and Local CSV templates are not covered.
The CSV app and shared CSV helpers remain maintained.

## Branding or theme

1. **Power BI:** open a copy in Desktop, then use **View > Themes** and the
   formatting pane to change colours, titles and logos.
2. **Model-backed Fabric/Azure app:** use the header's light/dark button. For your
   own branding, a developer edits the matching app's `src/global.css` and header
   in `src/components/app-shell.tsx`: [Fabric app](../fabric-app/) or
   [installer/Azure app](../2.%20Fabric/Fabric%20App/). There is no logo-upload setting.
3. **CSV app:** a developer edits [colours](../app/src/index.css) and the
   [header](../app/src/App.tsx). Rebuild using the [app instructions](../app/README.md#develop);
   downloaded HTML copies do not update themselves.

## Labels and page visibility

1. **Power BI:** rename a page using its page tab; right-click the tab and select
   **Hide page** to remove it from normal navigation. Edit visual titles in the
   formatting pane.
2. **Apps:** there is no general page-renaming/hiding screen. A developer changes
   labels/navigation in the CSV app's [routes](../app/src/routes.ts), or the matching
   model-backed app's `src/components/destinations.ts`; keep route IDs and page
   rendering consistent. Optional model-backed pages also depend on connected models/data.
3. Preview the affected pages and navigation before distributing your copy.
   Hiding a page or changing a label is **not** an access control.

## Value assumptions: minutes saved and hourly rate

1. **CSV app:** open **Assumptions** in the header for hourly value, licence price,
   penalty and effort scenario. Changes apply immediately but are **not saved**.
   Per-task minutes require a developer edit to [estimates.json](../app/src/data/estimates.json)
   and a rebuild; there is no per-task editor in this app.
2. **Model-backed Fabric/Azure apps:** set hourly value/scenario on **Value** and
   minutes on **Assumptions > Time per task**. **Prices** changes licence price and
   currency. Saved task/price settings affect that app, not the Power BI report;
   Fabric shares them across app users, while Azure restricts writes by default
   to `AnalyticsHub.Admin`.
3. **Power BI:** choose the Estimated Value hourly-value and effort slicers.
   A model owner changes `Human Time Estimates` and `Assumptions` for persistent
   model defaults. Check one before/after example; see [setting meanings](METHODOLOGY.md#7-settings-you-can-change).

## Organisation attributes and grouping

1. Update the source org data first, keeping person keys consistent with audit
   and licence data. For CSV/SharePoint, keep the expected `Organization` column;
   renaming a display label does not remap a source.
2. **Model-backed apps:** use **Group by** when multiple org attributes are
   available. **CSV app:** its Organisation filter uses `Organization` only.
   **Power BI:** a report author changes the visual's grouping field to a loaded
   org attribute; new fields require a model/source change.
3. Reload/refresh and check missing-org rows and totals. Grouping filters do not
   change RLS; review security scopes separately.

## Refresh and data sources

1. **CSV app:** regenerate processed files, then use **Change data** in
   the app or **Refresh** in Desktop. In Desktop, **Transform data > Edit parameters**
   changes the template's file/folder or endpoint inputs.
2. **Fabric/Azure:** use your installer's data-source choices and existing
   pipeline/job schedule; for manual Fabric setups, edit the pipeline schedule.
   **SharePoint/PAX:** update the scheduled export/upload and the report's folder
   parameters. Follow your [deployment path](../README.md#choose-your-path).
3. Refresh the semantic model after ingestion; check credentials, load status and
   data dates. Reload the model-backed app to discard its in-memory results.
   A report refresh does not collect new source data.

## Row-level security and user-ID hashing

Follow [administrator security and privacy setup](SECURITY-PRIVACY-SETUP.md) for
portal role membership, route limitations and the coordinated identity cutover.
No shipped route currently has a supported end-to-end hashing switch.
