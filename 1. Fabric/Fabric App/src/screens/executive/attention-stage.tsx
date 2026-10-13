//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { stageAnchor } from "@/components/destinations";
import { FilterNote } from "@/components/filter-note";
import { OpenDestinationLink } from "@/components/open-destination-link";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { NoteCard } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useFilterContext, useOrgAttribute } from "@/hooks/filter.context";
import { useConsumptionSummary } from "@/hooks/use-consumption-query";
import { useSummaryQuery, useTableQuery, type SummaryResult, type TableResult } from "@/hooks/use-table-query";
import type { FilterKey } from "@/lib/filters";
import { formatKpi } from "@/lib/format-kpi";
import { withIndefiniteArticle } from "@/lib/org-attribute";
import { readNumber, readText } from "@/lib/summary-row";
import { BODY, SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { agentEstateSummary, describeRegistryLinkage, type RegistryLinkage } from "@/queries/agents";
import { coworkCreditsSummary } from "@/queries/consumption";
import { executiveCreditDates } from "@/queries/executive";
import { FEEDBACK_ON_CALENDAR, feedbackCategory } from "@/queries/feedback";
import { licenseDormancy, licenseEstateSummary } from "@/queries/licensing";
import { CONSUMPTION_CONFIGURED } from "@/screens/value/cost-vs-value-data";
import { attentionItems, type AttentionItem } from "./executive-attention";
import { formatDay, ratio, tableRecords } from "./executive-data";
import type { ExecutiveData } from "./use-executive-data";

/** The license roster as it stands today, for the whole tenant. */
const ESTATE_IGNORES: FilterKey[] = ["dateRange", "organizations"];
/** Feedback isn't linked to people. */
const FEEDBACK_IGNORES: FilterKey[] = ["organizations"];
const FEEDBACK_EXTRA = [FEEDBACK_ON_CALENDAR];
/** The registry is a catalogue, not activity. */
const CATALOGUE_IGNORES: FilterKey[] = ["dateRange", "organizations", "licence", "audience"];
const SKIP = { connection: "", query: "" };

const TONE = {
    negative: { Icon: CircleAlert, className: "text-negative", label: "Problem" },
    caution: { Icon: TriangleAlert, className: "text-caution", label: "Opportunity" },
} as const;

function AttentionRow({ item }: { item: AttentionItem }) {
    const tone = TONE[item.tone];
    return (
        <li className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-300 gap-y-200 px-500 py-400 sm:grid-cols-[16px_minmax(0,1fr)_auto]">
            <tone.Icon className={cn("icon-size-200 mt-[2px]", tone.className)} aria-hidden="true" />
            <div className="flex flex-col gap-100">
                <h3 className={cn(BODY, "font-semibold text-foreground")}>
                    <span className="sr-only">{tone.label}: </span>
                    {item.title}
                </h3>
                <p className={cn(SMALL, "max-w-[72ch] text-muted-foreground")}>{item.evidence}</p>
            </div>
            <div className="col-start-2 flex flex-col items-start gap-100 sm:col-start-3 sm:items-end">
                <span className={cn(SMALL, "font-semibold text-foreground")}>{item.stake}</span>
                <OpenDestinationLink destination={item.link.destination} stage={item.link.stage}>
                    {item.link.label}
                </OpenDestinationLink>
            </div>
        </li>
    );
}

/** The sentence about the agent registry, if there's a registry to describe. */
function registryNote(linkage: RegistryLinkage, registryAgents: number | undefined, updated: string | undefined): string | undefined {
    const when = updated ? ` Updated ${updated}.` : "";
    switch (linkage.kind) {
        case "complete":
            return `Every agent session matches a registered agent; ${formatKpi(linkage.seenInUse, "whole")} of ${formatKpi(linkage.registryAgents, "whole")} are in use.${when}`;
        case "partial":
            return `${formatKpi(linkage.unmatchedSessions, "whole")} agent sessions came from agents it doesn't list.${when}`;
        case "none":
            return `None of the ${formatKpi(linkage.unmatchedSessions, "whole")} agent sessions match an agent it lists, so agents go by the names the audit log gives them.${when}`;
        default:
            return registryAgents === undefined
                ? undefined
                : `${formatKpi(registryAgents, "whole")} agents listed, with no agent sessions yet to match against them.${when}`;
    }
}

function inventoryNote(usable: number | undefined): string | undefined {
    if (usable === undefined) return undefined;
    return usable === 0
        ? "Doesn't reconcile with activity yet, so idle seats can't be counted. Readiness explains why."
        : "Reconciles with activity";
}

/** The first failure among the results that were asked for, with a retry for each that failed. */
function firstError(results: readonly (TableResult | SummaryResult)[]) {
    const failed = results.filter((result) => result.error !== undefined);
    if (failed.length === 0) return undefined;
    return { message: failed[0].error as string, retry: () => failed.forEach((result) => result.refetch()) };
}

function isSettled(result: TableResult | SummaryResult): boolean {
    return "loaded" in result ? result.loaded : !result.isLoading;
}

/**
 * What needs attention: the decisions the figures point to, from fixed rules,
 * beside what the figures rest on and how current it is.
 */
export function AttentionStage({ data }: { data: ExecutiveData }) {
    const { summary, departments } = data;
    const org = useOrgAttribute();
    const { options } = useFilterContext();

    const dormancySource = useMemo(() => licenseDormancy(), []);
    const themesSource = useMemo(() => feedbackCategory(), []);
    const coworkSource = useMemo(() => (CONSUMPTION_CONFIGURED ? coworkCreditsSummary() : { ...coworkCreditsSummary(), ...SKIP }), []);
    const creditDatesSource = useMemo(
        () => (CONSUMPTION_CONFIGURED ? executiveCreditDates() : { ...executiveCreditDates(), ...SKIP }),
        [],
    );

    const dormancy = useTableQuery(dormancySource, [], ESTATE_IGNORES);
    const estate = useSummaryQuery(licenseEstateSummary(), [], ESTATE_IGNORES);
    const themes = useTableQuery(themesSource, FEEDBACK_EXTRA, FEEDBACK_IGNORES);
    const cowork = useConsumptionSummary(coworkSource);
    const creditDates = useConsumptionSummary(creditDatesSource);
    const registry = useSummaryQuery(agentEstateSummary(), [], CATALOGUE_IGNORES);

    const ruleInputs = [summary, departments, dormancy, estate, themes, ...(CONSUMPTION_CONFIGURED ? [cowork] : [])];
    const error = firstError(ruleInputs);
    const settled = ruleInputs.every(isSettled);

    const items = useMemo(
        () =>
            settled
                ? attentionItems({
                      summary: summary.row,
                      dormancy: tableRecords(dormancy.table),
                      estate: estate.row,
                      departments: tableRecords(departments.table),
                      cowork: cowork.row,
                      themes: tableRecords(themes.table),
                      orgPlural: org.plural,
                  })
                : [],
        [settled, summary.row, dormancy.table, estate.row, departments.table, cowork.row, themes.table, org.plural],
    );

    const people = readNumber(summary.row, "[People]");
    const coverage = ratio(readNumber(summary.row, "[People With Organization]"), people);
    const linkage = describeRegistryLinkage(registry.row);
    const creditsThrough = formatDay(readText(creditDates.row, "[Last Date]"));
    const activityThrough = formatDay(options?.lastDate);

    return (
        <Section
            id={stageAnchor("what-needs-attention")}
            title="What needs attention"
            description="Decisions the data points to, the most people or hours affected first. Each comes from a fixed rule, so the same data always gives the same list."
        >
            <FilterNote
                ignored={ESTATE_IGNORES}
                scope={CONSUMPTION_CONFIGURED ? "to idle seats or Cowork allowances" : "to idle seats"}
                reason={
                    CONSUMPTION_CONFIGURED
                        ? "they describe the license roster and Cowork's current billing period as they stand, for the whole tenant."
                        : "they describe the license roster as it stands, for the whole tenant."
                }
            />
            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="min-w-0">
                    {error ? (
                        <QueryError message={error.message} onRetry={error.retry} />
                    ) : !settled ? (
                        <QueryLoading className="h-[320px]" />
                    ) : items.length === 0 ? (
                        <QueryEmpty
                            title="Nothing needs attention"
                            description={`No rule found anything to raise: idle seats, Cowork allowances, the gap between ${org.plural} and the least liked feedback theme are all within bounds.`}
                        />
                    ) : (
                        <ol aria-label="What needs attention" className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
                            {items.map((item) => (
                                <AttentionRow key={item.rule} item={item} />
                            ))}
                        </ol>
                    )}
                </div>
                <div className="xl:self-start">
                    <NoteCard
                        title="Can we trust these numbers?"
                        notes={[
                            { term: "Activity data", text: activityThrough && `Through ${activityThrough}` },
                            {
                                term: "Credit data",
                                text: CONSUMPTION_CONFIGURED && creditsThrough ? `Through ${creditsThrough}` : undefined,
                            },
                            { term: "License inventory", text: inventoryNote(readNumber(estate.row, "[License Inventory Usable]")) },
                            {
                                term: `People with ${withIndefiniteArticle(org.noun)}`,
                                text:
                                    coverage === undefined
                                        ? undefined
                                        : `${formatKpi(coverage, "percent")} of the ${formatKpi(people, "whole")} people with a task`,
                            },
                            {
                                term: "Agent registry",
                                text: registryNote(
                                    linkage,
                                    readNumber(registry.row, "[Registry Agents]"),
                                    formatDay(readText(registry.row, "[Registry Updated]")),
                                ),
                            },
                        ]}
                    />
                </div>
            </div>
        </Section>
    );
}