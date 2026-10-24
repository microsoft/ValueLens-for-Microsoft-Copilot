//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { FilterContext } from "@/hooks/filter.context";
import { defaultFilters, filterLabel, tenantDefaultFilters, type FilterState } from "@/lib/filters";
import type { FilterOptions } from "@/queries/filters/filter-options";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { FilterBar } from "./filter-bar";

type FilterContextValue = ComponentProps<typeof FilterContext.Provider>["value"];

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

describe("FilterBar", () => {
    it("loads the menus' choices as a menu other than the dates opens", () => {
        const requestFilterChoices = vi.fn();
        const context: FilterContextValue = {
            filters: defaultFilters,
            setFilters: () => {},
            options: undefined,
            optionsError: undefined,
            applicable: ["dateRange", "organizations", "agentTypes", "agentNames"],
            orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
            orgAttributes: [DEFAULT_ORG_ATTRIBUTE, "Department"],
            orgValues: undefined,
            requestFilterChoices,
        };
        render(
            <FilterContext.Provider value={context}>
                <FilterBar destinationLabel="Agents" />
            </FilterContext.Provider>,
        );

        // Its presets and fields come with the page's filter options.
        openMenu(filterLabel("dateRange", ""));
        expect(requestFilterChoices).not.toHaveBeenCalled();

        const menus = [
            "Group by",
            describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE).label,
            filterLabel("agentTypes", ""),
            filterLabel("agentNames", ""),
        ];
        for (const menu of menus) {
            requestFilterChoices.mockClear();
            openMenu(menu);
            expect(requestFilterChoices, menu).toHaveBeenCalledOnce();
        }
    });

    it("keeps the org menu open as its column changes, and ends a search typed there", () => {
        const organizations = Array.from({ length: 9 }, (_, index) => `Org ${String.fromCharCode(65 + index)}`);
        const departments = Array.from({ length: 9 }, (_, index) => `Department ${index + 1}`);
        const bar = (column: string, orgValues: readonly string[]) => (
            <FilterContext.Provider
                value={{
                    filters: defaultFilters,
                    setFilters: () => {},
                    options: undefined,
                    optionsError: undefined,
                    applicable: ["organizations"],
                    orgAttribute: describeOrgAttribute(column),
                    orgAttributes: [DEFAULT_ORG_ATTRIBUTE, "Department"],
                    orgValues,
                    requestFilterChoices: () => {},
                }}
            >
                <FilterBar destinationLabel="Agents" />
            </FilterContext.Provider>
        );
        const choices = (panel: Element) => [...panel.querySelectorAll("li")].map((item) => item.textContent);
        const searchBox = (panel: Element) => panel.querySelector<HTMLInputElement>('input[type="search"]')!;

        const { rerender } = render(bar(DEFAULT_ORG_ATTRIBUTE, organizations));
        const label = describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE).label;
        openMenu(label);
        const panel = document.querySelector(`[role="dialog"][aria-label="${label}"]`)!;
        fireEvent.change(searchBox(panel), { target: { value: "Org A" } });
        expect(choices(panel)).toEqual(["Org A"]);

        rerender(bar("Department", departments));
        // The same panel, so the menu stays open: the org columns can change the column while it's open.
        expect(panel.isConnected).toBe(true);
        expect(panel.getAttribute("aria-label")).toBe(describeOrgAttribute("Department").label);
        expect(searchBox(panel).value).toBe("");
        expect(choices(panel)).toEqual(departments);

        rerender(bar(DEFAULT_ORG_ATTRIBUTE, organizations));
        expect(searchBox(panel).value).toBe("");
        expect(choices(panel)).toEqual(organizations);
    });
});

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
    function renderBar(tenant: FilterOptions | undefined, start: FilterState = tenantDefaultFilters) {
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
                        applicable: ["dateRange", "licence"],
                        orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
                        orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
                        orgValues: undefined,
                        requestFilterChoices: () => {},
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
        const seen = renderBar(options(true));
        expect(seen.filters.dateRange).toEqual(tenantDefaultFilters.dateRange);
        expect(screen.queryByText(/filter is set but doesn't/)).toBeNull();
    });
});
