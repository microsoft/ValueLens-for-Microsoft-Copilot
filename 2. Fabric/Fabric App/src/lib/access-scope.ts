//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { isMissingFromModelError } from "@/lib/model-errors";
import type { SummaryRow } from "@/lib/summary-row";

/** One of the signed-in person's scopes, as the installer or the Share panel granted it. */
export interface AccessScope {
    type: "all" | "hierarchy" | "org";
    /** The root person's email for `hierarchy`, the org value for `org`, empty for `all`. */
    value: string;
}

/**
 * - `off`: the model has no `Access Scope` table, so org-scoped access isn't turned on.
 * - `checking` / `unknown`: no answer yet, or the query failed for another reason. Nothing changes.
 * - `bypass`: the person can see everyone's scope rows, so a workspace role puts them above the filters.
 * - `scoped`: the person's own scopes, or the install's default ones when they have none of their own.
 * - `none`: org-scoped access is on and the person has no scope, so every page would be empty.
 */
export type AccessScopeState =
    | { kind: "off" | "checking" | "unknown" | "bypass" | "none" }
    | { kind: "scoped"; scopes: AccessScope[]; isDefault: boolean };

const OTHERS = "#others";

/**
 * The signed-in person's active scope rows, plus one marker row counting the rows the model
 * shows that belong to someone else. The role only shows a person their own rows and the
 * default (`*`) ones, so any other row means a workspace role is bypassing it.
 */
export const ACCESS_SCOPE_QUERY = `DEFINE
    VAR __me = LOWER(USERPRINCIPALNAME())
EVALUATE
UNION(
    ROW("Who", "${OTHERS}", "Type", FORMAT(COUNTROWS(FILTER('Access Scope', NOT ('Access Scope'[UserPrincipalName] IN {__me, "*"}))) + 0, "0"), "Value", ""),
    SELECTCOLUMNS(
        FILTER('Access Scope', 'Access Scope'[UserPrincipalName] IN {__me, "*"} && 'Access Scope'[Status] = "active"),
        "Who", 'Access Scope'[UserPrincipalName],
        "Type", 'Access Scope'[ScopeType],
        "Value", 'Access Scope'[ScopeValue]
    )
)`;

const SCOPE_TYPES = new Set<AccessScope["type"]>(["all", "hierarchy", "org"]);

const text = (row: SummaryRow, column: string) => {
    const value = row[`[${column}]`] ?? row[column];
    return typeof value === "string" ? value.trim() : "";
};

/** Reads the query's answer. */
export function readAccessScope(result: { rows?: SummaryRow[]; loaded: boolean; error?: string }): AccessScopeState {
    if (result.error !== undefined) return { kind: isMissingFromModelError(result.error) ? "off" : "unknown" };
    if (!result.loaded || !result.rows) return { kind: "checking" };

    const others = result.rows.find((row) => text(row, "Who") === OTHERS);
    if (Number(others ? text(others, "Type") : "0") > 0) return { kind: "bypass" };

    const toScope = (row: SummaryRow): AccessScope | undefined => {
        const type = text(row, "Type").toLowerCase() as AccessScope["type"];
        return SCOPE_TYPES.has(type) ? { type, value: type === "all" ? "" : text(row, "Value") } : undefined;
    };
    const rows = result.rows.filter((row) => text(row, "Who") !== OTHERS);
    const own = rows.filter((row) => text(row, "Who") !== "*").map(toScope).filter((s): s is AccessScope => !!s);
    const fallback = rows.filter((row) => text(row, "Who") === "*").map(toScope).filter((s): s is AccessScope => !!s);
    const scopes = own.length > 0 ? own : fallback;
    if (scopes.length === 0) return { kind: "none" };
    return { kind: "scoped", scopes, isDefault: own.length === 0 };
}

/** One scope in words. */
export function describeScope(scope: AccessScope): string {
    if (scope.type === "all") return "everyone";
    if (scope.type === "hierarchy") return `people below ${scope.value}`;
    return scope.value;
}

/**
 * What the header says about whose data is on screen, or `undefined` when there's nothing to
 * say: org-scoped access is off, or the answer isn't in yet.
 */
export function scopeSummary(state: AccessScopeState): string | undefined {
    if (state.kind === "bypass") return "Showing: everyone (your workspace role)";
    if (state.kind !== "scoped") return undefined;
    if (state.scopes.some((scope) => scope.type === "all")) return "Showing: everyone";
    const parts = [...new Set(state.scopes.map(describeScope))];
    const shown = parts.length > 3 ? [...parts.slice(0, 2), `${parts.length - 2} more`] : parts;
    return `Showing: ${shown.join(", ")}`;
}
