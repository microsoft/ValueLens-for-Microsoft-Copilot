//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { FilterContext } from "@/hooks/filter.context";
import { filterLabel, tenantDefaultFilters, type FilterKey, type FilterState } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import type { FilterOptions } from "@/queries/filters/filter-options";
import { FilterBar } from "./filter-bar";

/** Opens a filter menu's panel, as the browser does for its popover. */
function openMenu(name: string) {
    const panel = document.querySelector(`[role="dialog"][aria-label="${name}"]`);
    if (!panel) throw new Error(`No filter menu named ${name}.`);
    const toggle = new Event("toggle");
    Object.defineProperty(toggle, "newState", { value: "open" });
    act(() => {
        panel.dispatchEvent(toggle);
    });
}

describe("FilterBar's tenant default dates", () => {
    const options = (largeTenant: boolean | undefined): FilterOptions => ({
        agentTypes: [],
        agentNames: [],
        activities: [],
        firstDate: "2026-01-01",
        lastDate: "2026-10-04",
        largeTenant,
    });

    /** The bar over real filter state, starting where a session does, with what it last set in `seen`. */
    function renderBar(
        tenant: FilterOptions | undefined,
        start: FilterState = tenantDefaultFilters,
        applicable: readonly FilterKey[] = ["dateRange", "licence"],
    ) {
        const seen: { filters: FilterState; sets: number } = { filters: start, sets: 0 };
        function Bar() {
            const [filters, setFilters] = useState(start);
            seen.filters = filters;
            return (
                <FilterContext.Provider
                    value={{
                        filters,
                        setFilters: (next) => {
                            seen.sets++;
                            setFilters(next);
                        },
                        options: tenant,
                        optionsError: undefined,
                        applicable,
                        orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
                        orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
                        orgValues: undefined,
                    }}
                >
                    <FilterBar destinationLabel="Adoption" />
                </FilterContext.Provider>
            );
        }
        render(<Bar />);
        return seen;
    }

    const dateButton = () => screen.getByRole("button", { name: /^Date/ });

    it("shows the last 12 weeks with their dates on a large tenant, says why, and widens to all dates in one click", () => {
        const seen = renderBar(options(true));
        expect(dateButton().textContent).toContain("Last 12 weeks · 13 Jul – 4 Oct 2026");
        expect(screen.getByText("Default for large organizations")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Show all dates" }));
        expect(seen.filters.dateRange).toBeUndefined();
        expect(dateButton().textContent).toContain("All dates");
        expect(screen.queryByText("Default for large organizations")).toBeNull();

        // Reset filters returns to the tenant's default, not to every date.
        fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
        expect(seen.filters).toEqual(tenantDefaultFilters);
        expect(dateButton().textContent).toContain("Last 12 weeks");
    });

    it("shows all dates on a small tenant, with nothing to reset, and keeps the default when All dates is picked", () => {
        const seen = renderBar(options(false));
        expect(dateButton().textContent).toContain("All dates");
        expect(screen.queryByText("Default for large organizations")).toBeNull();
        expect(screen.queryByRole("button", { name: "Show all dates" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();

        openMenu(filterLabel("dateRange", ""));
        const panel = document.querySelector(`[role="dialog"][aria-label="${filterLabel("dateRange", "")}"]`)!;
        const all = [...panel.querySelectorAll("button")].find((button) => button.textContent === "All dates")!;
        expect(all.getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(all);
        // The default already covers every date, so the state, and every query, stays as it is.
        expect(seen.sets).toBe(0);
        expect(seen.filters).toEqual(tenantDefaultFilters);
    });

    it("offers Reset filters on a small tenant only once a filter differs from its default", () => {
        renderBar(options(false), { ...tenantDefaultFilters, licence: "licensed" });
        expect(screen.getByRole("button", { name: "Reset filters" })).toBeTruthy();
    });

    it("says the dates are the default while the options load", () => {
        renderBar(undefined);
        expect(dateButton().textContent).toContain("Default dates");
        expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
    });

    it("never says the default dates don't apply where a destination has no date filter", () => {
        renderBar(options(true), tenantDefaultFilters, ["licence"]);
        expect(screen.queryByText(/filter is set but doesn't/)).toBeNull();
        expect(screen.queryByText(/filters are set but don't/)).toBeNull();
    });
});
