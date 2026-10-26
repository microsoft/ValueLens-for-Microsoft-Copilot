//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { ACCESS_SCOPE_QUERY, readAccessScope, scopeSummary } from "@/lib/access-scope";

const others = (n: number) => ({ "[Who]": "#others", "[Type]": String(n), "[Value]": "" });
const row = (who: string, type: string, value = "") => ({ "[Who]": who, "[Type]": type, "[Value]": value });

describe("readAccessScope", () => {
    it("reads a model without the access tables as off", () => {
        expect(readAccessScope({ loaded: false, error: "Cannot find table 'Access Scope'." })).toEqual({ kind: "off" });
    });

    it("leaves other failures and pending answers alone", () => {
        expect(readAccessScope({ loaded: false, error: "401 Unauthorized" })).toEqual({ kind: "unknown" });
        expect(readAccessScope({ loaded: false })).toEqual({ kind: "checking" });
    });

    it("treats seeing someone else's rows as a workspace role bypassing the filters", () => {
        expect(readAccessScope({ loaded: true, rows: [others(12), row("me@example.com", "org", "Finance")] })).toEqual({ kind: "bypass" });
    });

    it("prefers the person's own scopes over the default ones", () => {
        const state = readAccessScope({
            loaded: true,
            rows: [others(0), row("*", "all"), row("me@example.com", "hierarchy", "lead@example.com"), row("me@example.com", "org", "Finance")],
        });
        expect(state).toEqual({
            kind: "scoped",
            isDefault: false,
            scopes: [{ type: "hierarchy", value: "lead@example.com" }, { type: "org", value: "Finance" }],
        });
    });

    it("falls back to the default scopes", () => {
        expect(readAccessScope({ loaded: true, rows: [others(0), row("*", "ALL")] })).toEqual({
            kind: "scoped",
            isDefault: true,
            scopes: [{ type: "all", value: "" }],
        });
    });

    it("reads no rows as no scope", () => {
        expect(readAccessScope({ loaded: true, rows: [others(0)] })).toEqual({ kind: "none" });
        expect(readAccessScope({ loaded: true, rows: [others(0), row("me@example.com", "unknown", "x")] })).toEqual({ kind: "none" });
    });

    it("asks only for active rows", () => {
        expect(ACCESS_SCOPE_QUERY).toContain(`'Access Scope'[Status] = "active"`);
        expect(ACCESS_SCOPE_QUERY).toContain("LOWER(USERPRINCIPALNAME())");
    });
});

describe("scopeSummary", () => {
    it("says nothing when org-scoped access is off or still loading", () => {
        expect(scopeSummary({ kind: "off" })).toBeUndefined();
        expect(scopeSummary({ kind: "checking" })).toBeUndefined();
        expect(scopeSummary({ kind: "none" })).toBeUndefined();
    });

    it("names everyone, a person's org and an org value", () => {
        expect(scopeSummary({ kind: "bypass" })).toBe("Showing: everyone (your workspace role)");
        expect(scopeSummary({ kind: "scoped", isDefault: false, scopes: [{ type: "org", value: "Finance" }, { type: "all", value: "" }] }))
            .toBe("Showing: everyone");
        expect(scopeSummary({
            kind: "scoped",
            isDefault: false,
            scopes: [{ type: "hierarchy", value: "lead@example.com" }, { type: "org", value: "Finance" }],
        })).toBe("Showing: people below lead@example.com, Finance");
    });

    it("keeps a long list short", () => {
        const scopes = ["A", "B", "C", "D", "E"].map((value) => ({ type: "org" as const, value }));
        expect(scopeSummary({ kind: "scoped", isDefault: false, scopes })).toBe("Showing: A, B, 3 more");
    });
});
