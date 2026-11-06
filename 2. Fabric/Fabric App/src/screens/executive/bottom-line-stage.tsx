//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, type ReactNode } from "react";
import { stageAnchor } from "@/components/destinations";
import { FilterNote } from "@/components/filter-note";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { formatKpi } from "@/lib/format-kpi";
import { isAbsent } from "@/lib/optional-sources";
import { readNumber, readText, type SummaryRow } from "@/lib/summary-row";
import { BODY } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { BROAD_USER_SKILLS } from "@/queries/executive";
import { CONSUMPTION_CONFIGURED } from "@/screens/value/cost-vs-value-data";
import { byMonth, cardDelta, formatMonth, sumPresent, tableRecords, workRates } from "./executive-data";
import type { ExecutiveData } from "./use-executive-data";

/** A label and a figure that isn't a single number, laid out as {@link KpiStat} lays out one that is. */
function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-baseline justify-between gap-200">
            <span>{label}</span>
            <span className="font-numeric font-semibold whitespace-nowrap tabular-nums text-[length:var(--text-300)] text-foreground">
                {value}
            </span>
        </div>
    );
}

function Details({ children }: { children: ReactNode }) {
    return <div className="flex flex-col gap-100">{children}</div>;
}

function Group({ title, className, children }: { title: string; className: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-300">
            <h3 className={cn(BODY, "font-semibold text-foreground")}>{title}</h3>
            <div className={className}>{children}</div>
        </div>
    );
}

const read = (column: string) => (row: SummaryRow | undefined) => readNumber(row, column);
const readCredits = (row: SummaryRow | undefined) =>
    sumPresent(readNumber(row, "Studio Credits"), readNumber(row, "Cowork Credits"));

const WORK_GRID = CONSUMPTION_CONFIGURED ? "grid gap-300 md:grid-cols-2 xl:grid-cols-4" : "grid gap-300 md:grid-cols-3";

/** Without product feedback the habit row loses its satisfaction card, and the filter note its reason. */
function feedbackNote(hasFeedback: boolean): { scope: string; reason: string } | undefined {
    if (hasFeedback) {
        return CONSUMPTION_CONFIGURED
            ? {
                  scope: "to satisfaction or credits",
                  reason: "feedback isn't linked to people, and Consumption Central records credits for the whole tenant.",
              }
            : { scope: "to satisfaction", reason: "feedback isn't linked to people, so it covers everyone." };
    }
    return CONSUMPTION_CONFIGURED
        ? { scope: "to credits", reason: "Consumption Central records credits for the whole tenant." }
        : undefined;
}

/**
 * The bottom line: what Copilot did, how broadly, and whether it is
 * becoming how people work. No figure here is money; Cost vs value has that.
 */
export function BottomLineStage({ data }: { data: ExecutiveData }) {
    const { summary, months, credits, creditsInRange, range } = data;
    const row = summary.row;
    const pair = range.range?.pair;
    const hasFeedback = !isAbsent(useSourceAvailability(), "productFeedback");
    const note = feedbackNote(hasFeedback);

    const monthRows = useMemo(() => byMonth(tableRecords(months.table)), [months.table]);
    const creditMonths = useMemo(() => byMonth(tableRecords(credits.table)), [credits.table]);
    const creditTotals = useMemo(() => {
        const records = tableRecords(creditsInRange.table);
        const studio = sumPresent(...records.map((record) => readNumber(record, "Studio Credits")));
        const cowork = sumPresent(...records.map((record) => readNumber(record, "Cowork Credits")));
        return { studio, cowork, total: sumPresent(studio, cowork) };
    }, [creditsInRange.table]);

    const rates = workRates(row);
    const habitMonth = formatMonth(readText(row, "[Habit Month]"));
    const conservative = readNumber(row, "[Hours Conservative]");
    const optimistic = readNumber(row, "[Hours Optimistic]");
    const skillsInUse = readNumber(row, "[Skills In Use]");
    const skillsAvailable = readNumber(row, "[Skills Available]");

    const comparison = pair
        ? `Arrows compare ${formatMonth(pair.current)}, the last full month, with ${formatMonth(pair.previous)}; totals are compared per day so month length doesn't skew them.`
        : "Arrows comparing one month with the one before appear when the date range covers two full months.";

    return (
        <Section
            id={stageAnchor("the-bottom-line")}
            title="The bottom line"
            description={`What Copilot did, how widely people use it, and whether it is becoming how they work. ${comparison}`}
        >
            {summary.error !== undefined ? (
                <QueryError message={summary.error} onRetry={summary.refetch} />
            ) : !summary.loaded ? (
                <div className={WORK_GRID}>
                    {Array.from({ length: CONSUMPTION_CONFIGURED ? 4 : 3 }, (_, index) => (
                        <QueryLoading key={index} />
                    ))}
                </div>
            ) : !row ? (
                <QueryEmpty
                    title="No Copilot activity"
                    description="The semantic model returned nothing for the current selection."
                />
            ) : (
                <>
                    <Group title="Is it doing real work?" className={WORK_GRID}>
                        <KpiCard
                            label="Expert-equivalent hours · Typical effort"
                            value={readNumber(row, "[Hours]")}
                            emphasis
                            delta={cardDelta("volume", pair, monthRows, read("Hours"))}
                            detail={
                                <Details>
                                    {conservative !== undefined && optimistic !== undefined && (
                                        <Stat
                                            label="Conservative to Optimistic"
                                            value={`${formatKpi(conservative, "whole")} – ${formatKpi(optimistic, "whole")}`}
                                        />
                                    )}
                                    {rates.minutesPerPersonWeek !== undefined && (
                                        <Stat
                                            label="Per person a week"
                                            value={`${formatKpi(rates.minutesPerPersonWeek, "whole")} min`}
                                        />
                                    )}
                                </Details>
                            }
                        />
                        <KpiCard
                            label="Tasks delivered"
                            value={readNumber(row, "[Tasks]")}
                            delta={cardDelta("volume", pair, monthRows, read("Tasks"))}
                            detail={
                                <Details>
                                    <KpiStat label="Per person a week" value={rates.tasksPerPersonWeek} format="hours" />
                                    <KpiStat label="Expert minutes per task" value={rates.minutesPerTask} format="hours" />
                                </Details>
                            }
                        />
                        <KpiCard
                            label="Unique skills · kinds of work per person"
                            value={readNumber(row, "[Skills Per Person]")}
                            format="rate"
                            delta={cardDelta("average", pair, monthRows, read("Skills Per Person"))}
                            detail={
                                <Details>
                                    {skillsInUse !== undefined && skillsAvailable !== undefined && (
                                        <Stat
                                            label="Kinds of work in use"
                                            value={`${formatKpi(skillsInUse, "whole")} of ${formatKpi(skillsAvailable, "whole")}`}
                                        />
                                    )}
                                    <KpiStat
                                        label={`People using ${BROAD_USER_SKILLS} or more`}
                                        value={readNumber(row, "[Broad Users Pct]")}
                                        format="percent"
                                    />
                                </Details>
                            }
                        />
                        {CONSUMPTION_CONFIGURED &&
                            (creditsInRange.error !== undefined ? (
                                <QueryError message={creditsInRange.error} onRetry={creditsInRange.refetch} />
                            ) : creditsInRange.isLoading ? (
                                <QueryLoading />
                            ) : (
                                <KpiCard
                                    label="Credits consumed · whole tenant"
                                    value={creditTotals.total === undefined ? undefined : creditTotals.total / 1e6}
                                    format="millions"
                                    delta={cardDelta("volume", pair, creditMonths, readCredits, "neutral")}
                                    detail={
                                        <Details>
                                            <KpiStat
                                                label="Copilot Studio agents"
                                                value={creditTotals.studio === undefined ? undefined : creditTotals.studio / 1e6}
                                                format="millions"
                                            />
                                            <KpiStat
                                                label="Cowork"
                                                value={creditTotals.cowork === undefined ? undefined : creditTotals.cowork / 1e6}
                                                format="millions"
                                            />
                                        </Details>
                                    }
                                />
                            ))}
                    </Group>

                    <Group
                        title="Is it becoming how people work?"
                        className={cn("grid gap-300", hasFeedback ? "md:grid-cols-3" : "md:grid-cols-2")}
                    >
                        <KpiCard
                            label="Licensed seats in use"
                            value={readNumber(row, "[Seats In Use Pct]")}
                            format="percent"
                            delta={cardDelta("rate", pair, monthRows, read("Seats In Use Pct"))}
                            detail={
                                <Details>
                                    <KpiStat label="Licensed seats" value={readNumber(row, "[Licensed Seats]")} />
                                    <KpiStat label="Seats in use" value={readNumber(row, "[Seats In Use]")} />
                                </Details>
                            }
                        />
                        <KpiCard
                            label={habitMonth ? `Habit rate · ${habitMonth}` : "Habit rate"}
                            value={rates.habitRate}
                            format="percent"
                            delta={cardDelta("rate", pair, monthRows, read("Habit Pct"))}
                            detail={
                                <Details>
                                    <KpiStat label="Habitual" value={readNumber(row, "[Habitual Pct]")} format="percent" />
                                    <KpiStat label="Power" value={readNumber(row, "[Power Pct]")} format="percent" />
                                </Details>
                            }
                        />
                        {hasFeedback && (
                            <KpiCard
                                label="Satisfaction · thumbs up"
                                value={readNumber(row, "[Satisfaction]")}
                                format="percent"
                                delta={cardDelta("rate", pair, monthRows, read("Satisfaction"))}
                                detail={
                                    <Details>
                                        <KpiStat label="Ratings" value={readNumber(row, "[Feedback]")} />
                                    </Details>
                                }
                            />
                        )}
                    </Group>
                </>
            )}

            {note && <FilterNote ignored={["organizations"]} scope={note.scope} reason={note.reason} />}
        </Section>
    );
}
