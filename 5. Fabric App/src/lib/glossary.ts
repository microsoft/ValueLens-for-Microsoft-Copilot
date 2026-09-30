//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DestinationId, StageId } from "@/components/destinations";
import { readNumber, readText, type SummaryRow } from "./summary-row";

export interface GlossaryEntry {
    metric: string;
    description: string;
}

export interface GlossaryPage {
    page: string;
    description?: string;
    entries: GlossaryEntry[];
}

/**
 * Groups glossary rows into report pages, pages and metrics each in the
 * report's own order. Rows without a metric name are dropped.
 */
export function toGlossaryPages(rows: readonly SummaryRow[]): GlossaryPage[] {
    const pages = new Map<string, { order: number; description?: string; entries: (GlossaryEntry & { order: number })[] }>();

    for (const row of rows) {
        const page = readText(row, "[Page]");
        const metric = readText(row, "[Metric]");
        if (!page || !metric) continue;

        let group = pages.get(page);
        if (!group) {
            group = { order: readNumber(row, "[Page Order]") ?? Number.MAX_SAFE_INTEGER, entries: [] };
            pages.set(page, group);
        }
        group.description ??= readText(row, "[Page Description]");
        group.entries.push({
            metric,
            description: readText(row, "[Description]") ?? "",
            order: readNumber(row, "[Metric Order]") ?? Number.MAX_SAFE_INTEGER,
        });
    }

    return [...pages.entries()]
        .sort(([pageA, a], [pageB, b]) => a.order - b.order || pageA.localeCompare(pageB))
        .map(([page, group]) => ({
            page,
            description: group.description,
            entries: group.entries
                .sort((a, b) => a.order - b.order || a.metric.localeCompare(b.metric))
                .map(({ metric, description }) => ({ metric, description })),
        }));
}

/**
 * The pages narrowed to metrics whose name or definition contains `term`.
 * A page whose own name matches keeps every metric; pages left empty drop out.
 */
export function searchGlossary(pages: readonly GlossaryPage[], term: string): GlossaryPage[] {
    const needle = term.trim().toLowerCase();
    if (!needle) return [...pages];

    return pages.flatMap((page) => {
        if (page.page.toLowerCase().includes(needle)) return [page];
        const entries = page.entries.filter(
            (entry) => entry.metric.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle),
        );
        return entries.length > 0 ? [{ ...page, entries }] : [];
    });
}

/** `text` split around each case-insensitive occurrence of `term`, for highlighting. */
export function highlightParts(text: string, term: string): { text: string; match: boolean }[] {
    const needle = term.trim().toLowerCase();
    if (!needle) return [{ text, match: false }];

    const parts: { text: string; match: boolean }[] = [];
    const haystack = text.toLowerCase();
    let start = 0;
    for (let found = haystack.indexOf(needle); found >= 0; found = haystack.indexOf(needle, start)) {
        if (found > start) parts.push({ text: text.slice(start, found), match: false });
        parts.push({ text: text.slice(found, found + needle.length), match: true });
        start = found + needle.length;
    }
    if (start < text.length) parts.push({ text: text.slice(start), match: false });
    return parts;
}

/**
 * Where each report page's metrics now live in the app. The app folded the
 * report's pages into destinations and renamed some, so the glossary says
 * where to look. A page a customer adds to their own glossary has no entry and
 * simply shows no location.
 */
export const GLOSSARY_PAGE_HOME: Readonly<Record<string, { destination: DestinationId; stage?: StageId }>> = {
    Activation: { destination: "adoption", stage: "activation" },
    "License & Cowork Readiness": { destination: "readiness" },
    Adoption: { destination: "adoption", stage: "adoption" },
    "Power Users": { destination: "adoption", stage: "habit-formation" },
    Activity: { destination: "value", stage: "task-breakdown" },
    "License Prioritisation": { destination: "readiness", stage: "license-readiness" },
    "Usage Efficiency": { destination: "efficiency", stage: "cowork-fit" },
    "Model Mix": { destination: "efficiency", stage: "model-fit" },
    Value: { destination: "value", stage: "estimated-value" },
    "Agent Health": { destination: "leaderboards", stage: "agent-registry" },
    Feedback: { destination: "feedback", stage: "feedback" },
    Heatmap: { destination: "adoption", stage: "trend-heatmap" },
    Leaderboard: { destination: "leaderboards", stage: "leaderboard" },
    "Appendix: Glossary": { destination: "appendix", stage: "glossary" },
    "Appendix: Signal - Impact Table": { destination: "appendix", stage: "signal-impact" },
};
