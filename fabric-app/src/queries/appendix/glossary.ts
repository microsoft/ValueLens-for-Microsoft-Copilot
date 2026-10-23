//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { SummaryRow } from "@/lib/summary-row";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import appGlossary from "./app-glossary.json";
import query from "./glossary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Page]": { name: "Page", displayName: "Page" },
    "[Metric]": { name: "Metric", displayName: "Metric" },
    "[Description]": { name: "Description", displayName: "Description" },
    "[Page Order]": { name: "Page Order", displayName: "Page order", format: "0" },
    "[Metric Order]": { name: "Metric Order", displayName: "Metric order", format: "0" },
    "[Page Description]": { name: "Page Description", displayName: "Page description" },
};

/**
 * The report's metric glossary, one row per metric, in the order the report's
 * pages and cards present them. It is reference data, not activity, so no
 * filter applies to it.
 */
export function glossary() {
    return { connection, query, columnMetadata };
}

/**
 * Adds the app's own glossary entries, such as App host, to the model's rows.
 * The text ships with the app, as the task descriptions do, so models deployed
 * before the entries existed show them too. They join the model's page, after
 * its last metric; an entry the model already defines on that page is skipped.
 */
export function withAppGlossaryEntries(rows: readonly SummaryRow[]): SummaryRow[] {
    const pageRows = rows.filter((row) => row["[Page]"] === appGlossary.page);
    const existing = new Set(pageRows.map((row) => row["[Metric]"]));
    const first = pageRows[0];
    const pageOrder = typeof first?.["[Page Order]"] === "number" ? first["[Page Order]"] : appGlossary.pageOrder;
    const pageDescription = first ? (first["[Page Description]"] ?? null) : appGlossary.pageDescription;
    const lastOrder = Math.max(
        -1,
        ...pageRows.map((row) => (typeof row["[Metric Order]"] === "number" ? row["[Metric Order]"] : -1)),
    );

    const added = appGlossary.entries
        .filter((entry) => !existing.has(entry.metric))
        .map((entry, index) => ({
            "[Page]": appGlossary.page,
            "[Metric]": entry.metric,
            "[Description]": entry.description,
            "[Page Order]": pageOrder,
            "[Metric Order]": lastOrder + 1 + index,
            "[Page Description]": pageDescription,
        }));
    return [...rows, ...added];
}
