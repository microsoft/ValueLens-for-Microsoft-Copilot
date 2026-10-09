//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useMemo } from "react";
import { ConcentrationPanel } from "@/components/concentration-panel";
import { stageAnchor } from "@/components/destinations";
import { ChartPanel } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useTableQuery } from "@/hooks/use-table-query";
import { useValueAssumptions } from "@/hooks/value-assumptions.context";
import { treatAs } from "@/lib/dax-filters";
import { MIN_PEOPLE } from "@/lib/headline";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { valuePerPerson } from "@/queries/value";
import { monthLabel } from "@/screens/readiness/habit-licence";
import { cohortValueHeadline, hiddenHabits, ladderSpec, ladderTable, readValueByHabit } from "./cohort-value";

const source = valuePerPerson();
const spec = ladderSpec();

/**
 * Expert-equivalent hours per person in the last full month, by how often
 * people used Copilot that month, and how much of those hours the busiest
 * people account for. Both read the same month, under the page's effort
 * scenario.
 */
export function ValueByHabitStage() {
    const { scenario } = useValueAssumptions();
    const extra = useMemo(() => [treatAs("'Effort Scenario'[Scenario]", [scenario])], [scenario]);
    const result = useTableQuery(source, extra);

    const value = useMemo(() => (result.table ? readValueByHabit(result.table) : undefined), [result.table]);
    const ladder = useMemo(() => (value ? ladderTable(value) : undefined), [value]);
    const headline = useCallback(() => (value ? cohortValueHeadline(value) : undefined), [value]);
    const month = monthLabel(value?.month);
    const hidden = value ? hiddenHabits(value) : [];
    const active = (value?.hoursByPerson.length ?? 0) > 0;

    return (
        <Section
            id={stageAnchor("value-by-habit")}
            title="Value by habit"
            description="Expert-equivalent hours per person last month, for Beginner, Developing, Habitual and Power users."
        >
            <div className="grid grid-cols-1 items-start gap-500 xl:grid-cols-2">
                <ChartPanel
                    result={result}
                    table={ladder}
                    spec={spec}
                    height={260}
                    title="Expert hours per person, by habit"
                    subtitle={`${month}, ${scenario.toLowerCase()} effort. Habits count active days that month, as on the Adoption page.`}
                    headline={headline}
                    emptyTitle={active ? "Too few people in each habit" : "No activity last month"}
                    emptyDescription={
                        active
                            ? `Every habit held fewer than ${MIN_PEOPLE} people in ${month}, too few to show.`
                            : "Nobody used Copilot in the last full month the selected dates reach."
                    }
                />
                <ConcentrationPanel
                    result={result}
                    values={value?.hoursByPerson}
                    noun="expert hours"
                    height={260}
                    title="How concentrated expert hours are"
                    subtitle={`Each person's share of expert hours in ${month}, busiest first`}
                    emptyTitle="No activity last month"
                    emptyDescription="Nobody used Copilot in the last full month the selected dates reach."
                />
            </div>
            <p className={cn(SMALL, "max-w-[90ch] text-muted-foreground")}>
                Comparison, not cause. Heavier users may simply have more work that suits Copilot.
                {hidden.length > 0 &&
                    ` ${hidden.join(", ")} ${hidden.length === 1 ? "isn't" : "aren't"} shown: fewer than ${MIN_PEOPLE} people.`}
            </p>
        </Section>
    );
}
