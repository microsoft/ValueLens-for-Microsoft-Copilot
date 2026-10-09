//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { FilterMenu } from "@/components/filter-menu";
import { TermsForm, type TermField } from "@/components/terms-form";
import { useCommercialTerms } from "@/hooks/commercial-terms.context";
import { cn } from "@/lib/utils";
import { hasCommercialTerms, type BudgetKey, type CommercialTermKey } from "@/queries/consumption";
import { SMALL } from "./data";

const FIELDS: readonly { key: CommercialTermKey; label: string; hint: string; unit: "rate" | "credits" }[] = [
    {
        key: "creditRate",
        label: "Pay-as-you-go rate",
        hint: "$ per credit, for Cowork, Work IQ and Copilot Studio",
        unit: "rate",
    },
    { key: "prepaidCreditRate", label: "Prepaid rate", hint: "$ per Capacity Pack credit", unit: "rate" },
    {
        key: "prepaidCreditBalance",
        label: "Capacity Pack balance",
        hint: "Credits Cowork uses before it pays as it goes",
        unit: "credits",
    },
];

function formatTerm(value: number | undefined, unit: "rate" | "credits"): string {
    if (value === undefined) return "not set";
    return unit === "rate"
        ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`
        : `${value.toLocaleString("en-US", { maximumFractionDigits: 0 })} credits`;
}

const BUDGETS: readonly { key: BudgetKey; label: string }[] = [
    { key: "budgetCowork", label: "Cowork / Work IQ" },
    { key: "budgetStudio", label: "Copilot Studio" },
    { key: "budgetAzure", label: "Azure" },
];

function budgetSummary(count: number): string {
    if (count === 0) return "Not set";
    return count === BUDGETS.length ? "All set" : `${count} of ${BUDGETS.length} set`;
}

/** Monthly budgets per product, for the budget runway, saved with the rates. */
function BudgetsMenu({ azureCurrency }: { azureCurrency: string | undefined }) {
    const { status, saved } = useCommercialTerms();
    const count = BUDGETS.filter((budget) => saved?.[budget.key] !== undefined).length;
    const fields = useMemo<TermField[]>(
        () =>
            BUDGETS.map((budget) => ({
                key: budget.key,
                label: budget.label,
                hint:
                    budget.key === "budgetAzure"
                        ? `A month, in ${azureCurrency ?? "Azure's billing currency"}, for the solution and Foundry together`
                        : budget.key === "budgetCowork"
                          ? "$ a month, Cowork and Work IQ together"
                          : "$ a month",
                inputMode: "decimal",
            })),
        [azureCurrency],
    );
    return (
        <FilterMenu
            label="Monthly budgets"
            summary={status === "loading" ? "Loading…" : budgetSummary(count)}
            active={count > 0}
            panelClassName="w-[320px]"
        >
            {(close) => (
                <TermsForm
                    fields={fields}
                    intro="What each product may spend in a calendar month. Budget runway tracks this month's spend against them. Leave a box empty for no budget."
                    resetLabel="Clear budgets"
                    unavailableText="Budgets can't be saved here right now."
                    note="The Power BI report has no budgets."
                    close={close}
                />
            )}
        </FilterMenu>
    );
}

/**
 * The rates and pack balance every cost on the Consumption page is priced
 * at, with a form to set them for everyone who opens the app, and the
 * monthly budgets the budget runway tracks. Sits where the filter bar does
 * on the other destinations.
 */
export function RatesBar({ azureCurrency }: { azureCurrency?: string }) {
    const { status, saved, model } = useCommercialTerms();
    const overridden = hasCommercialTerms(saved ?? undefined);
    const summary = status === "loading" ? "Loading…" : overridden ? "Set in this app" : "From the model";

    const inUse = FIELDS.map((field) => {
        const own = saved?.[field.key];
        return { ...field, value: own ?? model?.[field.key], own: own !== undefined };
    });
    const known = status !== "loading" && inUse.some((term) => term.value !== undefined);

    const fields = useMemo<TermField[]>(
        () =>
            FIELDS.map((field) => {
                const modelValue = model?.[field.key];
                return {
                    key: field.key,
                    label: field.label,
                    hint: `${field.hint}. Model: ${formatTerm(modelValue, field.unit)}`,
                    placeholder: modelValue === undefined ? undefined : String(modelValue),
                    inputMode: field.unit === "rate" ? "decimal" : "numeric",
                };
            }),
        [model],
    );

    return (
        <div
            role="group"
            aria-label="Rates, packs and budgets"
            className="sticky top-0 z-10 -mx-700 -mb-200 flex flex-wrap items-center gap-x-400 gap-y-200 border-b border-border bg-background px-700 py-300"
        >
            <FilterMenu label="Rates & packs" summary={summary} active={overridden} panelClassName="w-[320px]">
                {(close) => (
                    <TermsForm
                        fields={fields}
                        intro="Every cost on this page is worked out at these prices. Leave a box empty to use the model's."
                        resetLabel="Use model values"
                        unavailableText="Rates can't be saved here right now, so costs use the model's."
                        note="The Power BI report keeps the model's."
                        close={close}
                    />
                )}
            </FilterMenu>
            <BudgetsMenu azureCurrency={azureCurrency} />
            {known && (
                <dl className={cn(SMALL, "flex flex-wrap items-baseline gap-x-400 gap-y-100 text-muted-foreground")}>
                    {inUse.map((term) => (
                        <div key={term.key} className="flex items-baseline gap-100">
                            <dt>{term.label}</dt>
                            <dd className={cn("tabular-nums", term.own ? "font-semibold text-foreground" : undefined)}>
                                {formatTerm(term.value, term.unit)}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
            {status === "unavailable" && (
                <span className={cn(SMALL, "text-muted-foreground")}>Saved rates unavailable, so the model's apply.</span>
            )}
        </div>
    );
}
