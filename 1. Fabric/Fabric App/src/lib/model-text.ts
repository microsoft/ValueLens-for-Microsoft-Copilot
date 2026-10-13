//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { GradeTone } from "./grading-method";

/** The model decorates its narratives with emoji; the app's type carries the meaning. */
export function withoutEmoji(text: string): string {
    return text
        .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

/** Product names written in one word on purpose, left as they are. */
const KEEP_AS_WRITTEN = new Set([
    "SharePoint",
    "OneDrive",
    "OneNote",
    "PowerPoint",
    "PowerApps",
    "LinkedIn",
    "GitHub",
    "YouTube",
    "WorkIQ",
    "DevOps",
    "JavaScript",
    "TypeScript",
]);

const IDENTIFIER = /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g;

/**
 * An identifier such as a topic or error code, as words: "PolicyLookup"
 * reads "Policy lookup" and "VPNSetupGuide" reads "VPN setup guide".
 * Anything that is not one word in CamelCase comes back unchanged.
 */
export function humanizeIdentifier(value: string): string {
    if (KEEP_AS_WRITTEN.has(value) || !/^[A-Za-z0-9]+$/.test(value) || !/[a-z][A-Z]|[A-Z]{2}[a-z]/.test(value)) {
        return value;
    }
    const words = value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(" ");
    return words.map((word, index) => (index === 0 || /^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase())).join(" ");
}

/** Every CamelCase identifier in a sentence, as words. */
export function humanizeIdentifiers(text: string): string {
    return text.replace(IDENTIFIER, (match) => humanizeIdentifier(match));
}

/**
 * A narrative measure as plain prose: thumbs become words before the other
 * emoji are dropped, so "326 👍 / 154 👎" still says which is which, and the
 * " | " a Power BI card puts between two clauses becomes a semicolon.
 */
export function plainText(text: string | undefined): string | undefined {
    if (!text) return undefined;
    const spoken = text.replace(/\s*👍\u{FE0F}?/gu, " thumbs up").replace(/\s*👎\u{FE0F}?/gu, " thumbs down");
    const joined = spoken.replace(/([.!?])\s+\|\s+/g, "$1 ").replace(/\s+\|\s+/g, "; ");
    const plain = humanizeIdentifiers(withoutEmoji(joined));
    return plain === "" ? undefined : plain;
}

export interface Verdict {
    /** The measured part, such as "65.8% resolved". */
    figure: string | undefined;
    /** The judgement, such as "Below target". */
    label: string;
    tone: GradeTone;
}

const TONE_MARKS: readonly [RegExp, GradeTone][] = [
    [/🟢|✅/u, "positive"],
    [/🟡|🟠|⚠/u, "caution"],
    [/🔴|❌/u, "negative"],
];

/**
 * Splits the model's verdict strings, "65.8% resolved · 🟡 Below target",
 * into the figure, the judgement and the traffic light it carries.
 */
export function parseVerdict(text: string | undefined): Verdict | undefined {
    if (!text?.trim()) return undefined;
    const tone = TONE_MARKS.find(([mark]) => mark.test(text))?.[1] ?? "neutral";
    const parts = text.split("·").map((part) => plainText(part)).filter((part): part is string => Boolean(part));
    if (parts.length === 0) return undefined;
    if (parts.length === 1) return { figure: undefined, label: parts[0], tone };
    return { figure: parts.slice(0, -1).join(" · "), label: parts[parts.length - 1], tone };
}

/** The table with one text column rewritten, for labels the model writes for itself. */
export function relabelColumn(table: DataTable, columnName: string, relabel: (value: string) => string): DataTable {
    const index = table.columns.findIndex((column) => column.name === columnName);
    if (index < 0) return table;
    return {
        columns: table.columns,
        rows: table.rows.map((row) => {
            const value = row[index];
            if (typeof value !== "string") return row;
            const next = [...row];
            next[index] = relabel(value);
            return next;
        }),
    };
}
