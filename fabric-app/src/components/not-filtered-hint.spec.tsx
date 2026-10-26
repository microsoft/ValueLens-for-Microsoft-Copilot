//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { FilterContext } from "@/hooks/filter.context";
import { defaultFilters, type FilterKey, type FilterState } from "@/lib/filters";
import { DEFAULT_ORG_ATTRIBUTE, describeOrgAttribute } from "@/lib/org-attribute";
import { NotFilteredHint } from "./not-filtered-hint";

const ACTIVE: FilterState = {
    ...defaultFilters,
    dateRange: { preset: "custom", from: "2026-01-01", to: "2026-03-31" },
    organizations: ["Sales"],
};

function Providers({ applicable, children }: { applicable: readonly FilterKey[]; children: ReactNode }) {
    return (
        <FilterContext.Provider
            value={{
                filters: ACTIVE,
                setFilters: () => undefined,
                options: undefined,
                optionsError: undefined,
                applicable,
                orgAttribute: describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE),
                orgAttributes: [DEFAULT_ORG_ATTRIBUTE],
                orgValues: undefined,
            }}
        >
            {children}
        </FilterContext.Provider>
    );
}

describe("NotFilteredHint", () => {
    it("names the filters each reason covers, once", () => {
        render(
            <Providers applicable={["dateRange", "organizations"]}>
                <NotFilteredHint
                    from={[
                        [{ key: "dateRange", reason: "it is billed for the tenant." }],
                        [
                            { key: "organizations", reason: "it is billed for the tenant." },
                            { key: "dateRange", reason: "it is billed for the tenant." },
                        ],
                    ]}
                />
            </Providers>,
        );

        const items = screen.getAllByRole("listitem");
        expect(items).toHaveLength(1);
        expect(items[0].textContent).toBe(
            `Not filtered by Date and ${describeOrgAttribute(DEFAULT_ORG_ATTRIBUTE).label}: it is billed for the tenant.`,
        );
    });

    it("explains deliberately ignored filters only when they are active on this page", () => {
        render(
            <Providers applicable={["organizations", "agentNames"]}>
                <NotFilteredHint ignored={["dateRange", "organizations", "agentNames"]} reason="it is fixed." />
            </Providers>,
        );

        expect(screen.getByRole("listitem").textContent).toMatch(/^Not filtered by \S+: it is fixed\.$/);
    });

    it("renders nothing when every filter applies", () => {
        const { container } = render(
            <Providers applicable={["dateRange"]}>
                <NotFilteredHint from={[[], undefined]} />
            </Providers>,
        );

        expect(container.innerHTML).toBe("");
    });
});
