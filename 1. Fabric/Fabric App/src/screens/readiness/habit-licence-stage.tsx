//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { stageAnchor } from "@/components/destinations";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { formatKpi } from "@/lib/format-kpi";
import { MIN_PEOPLE, shareText } from "@/lib/headline";
import { withOrgAttribute } from "@/lib/org-attribute";
import { toDataTable } from "@/lib/to-data-table";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { habitLicenceMatrix, unlicensedHeavyUsers } from "@/queries/licensing";
import {
    HEAVY_HABITS,
    habitLicenceHeadline,
    monthLabel,
    readHabitLicence,
    type Habit,
    type HabitLicenceMatrix,
} from "./habit-licence";

const RULES: Record<Habit, string> = {
    Power: "16 or more active days",
    Habitual: "11 to 15 active days",
    Developing: "6 to 10 active days",
    Beginner: "1 to 5 active days",
};

const CELL = "px-300 py-200 text-right tabular-nums";
const HEAD = "px-300 py-200 font-normal";

function MatrixTable({ matrix }: { matrix: HabitLicenceMatrix }) {
    return (
        <table className="w-full max-w-[720px] border-collapse text-left">
            <caption className="sr-only">
                People active in {monthLabel(matrix.month)}, by habit and licence
            </caption>
            <thead className={cn(SMALL, "text-muted-foreground")}>
                <tr className="border-b border-border">
                    <th scope="col" className={HEAD}>
                        Habit
                    </th>
                    <th scope="col" className={cn(HEAD, "text-right")}>
                        Licensed
                    </th>
                    <th scope="col" className={cn(HEAD, "text-right")}>
                        Unlicensed
                    </th>
                    <th scope="col" className={cn(HEAD, "text-right")}>
                        Share unlicensed
                    </th>
                </tr>
            </thead>
            <tbody className="text-[length:var(--text-300)]">
                {matrix.rows.map((row) => {
                    const total = row.licensed + row.unlicensed;
                    const heavy = HEAVY_HABITS.includes(row.habit);
                    const flagged = heavy && row.unlicensed > 0;
                    return (
                        <tr key={row.habit} className="border-b border-border last:border-b-0">
                            <th scope="row" className="px-300 py-200 font-normal">
                                <span className="block text-foreground">{row.habit}</span>
                                <span className={cn(SMALL, "block text-muted-foreground")}>{RULES[row.habit]}</span>
                            </th>
                            <td className={CELL}>{formatKpi(row.licensed, "whole")}</td>
                            <td className={cn(CELL, flagged && "bg-secondary font-semibold text-foreground")}>
                                {formatKpi(row.unlicensed, "whole")}
                            </td>
                            <td className={cn(CELL, "text-muted-foreground")}>
                                {total >= MIN_PEOPLE ? shareText(row.unlicensed, total) : "–"}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

const LIST_COLUMNS = (orgLabel: string): GridColumnDef[] => [
    { id: "User", header: "User", minWidth: 240 },
    { id: "Organization", header: orgLabel, minWidth: 160 },
    { id: "Cohort", header: "Habit", width: 112 },
    { id: "Active Days", header: "Active days", width: 116, numericStyling: true },
];

/**
 * Heavy Copilot users without a licence: everyone active last month by habit
 * and licence, then the ten unlicensed people active on the most days.
 */
export function HabitLicenceStage() {
    const { theme } = useThemeContext();
    const org = useOrgAttribute();

    const matrixQuery = habitLicenceMatrix();
    const matrixResult = useFilteredQuery({ connection: matrixQuery.connection, query: matrixQuery.query });
    const list = useMemo(() => withOrgAttribute(unlicensedHeavyUsers(), org), [org]);
    const listResult = useFilteredQuery({ connection: list.connection, query: list.query });

    const matrix = useMemo(
        () =>
            matrixResult.data?.status === "success"
                ? readHabitLicence(toDataTable(matrixResult.data.table, matrixQuery.columnMetadata))
                : undefined,
        [matrixResult.data, matrixQuery.columnMetadata],
    );
    const listTable = useMemo(
        () =>
            listResult.data?.status === "success" ? toDataTable(listResult.data.table, list.columnMetadata) : undefined,
        [listResult.data, list.columnMetadata],
    );
    const columns = useMemo(() => LIST_COLUMNS(org.label), [org.label]);

    const empty = matrix !== undefined && matrix.licensed + matrix.unlicensed === 0;
    // With no licensed activity the roster didn't match, and every name below would read as unlicensed.
    const unmatched = matrix !== undefined && !empty && matrix.licensed === 0;
    const headline = matrix ? habitLicenceHeadline(matrix) : undefined;

    return (
        <Section
            id={stageAnchor("habit-licence")}
            title="Heavy users without a licence"
            description="People active last month, by how often they used Copilot and whether they had a licence."
        >
            {matrixResult.data?.status === "error" ? (
                <QueryError message={matrixResult.data.error.message} onRetry={matrixResult.refetch} />
            ) : matrixResult.isLoading || !matrix ? (
                <QueryLoading className="h-[240px]" />
            ) : empty ? (
                <QueryEmpty
                    title="No activity last month"
                    description="Nobody used Copilot in the last full month the selected dates reach."
                />
            ) : (
                <div className="flex flex-col gap-300">
                    {headline && (
                        <p className="max-w-[90ch] text-[length:var(--text-300)] leading-300 text-foreground">{headline}</p>
                    )}
                    <MatrixTable matrix={matrix} />
                    <p className={cn(SMALL, "max-w-[90ch] text-muted-foreground")}>
                        Habits count the distinct days each person used Copilot in {monthLabel(matrix.month)}, as on
                        the Adoption page. Anyone with any licensed activity counts as licensed. This compares groups;
                        it doesn&apos;t show what a licence would change.
                    </p>
                </div>
            )}

            {matrix && !empty && !unmatched && (
                <div className="flex h-[480px] flex-col">
                    {listResult.data?.status === "error" ? (
                        <QueryError className="h-full" message={listResult.data.error.message} onRetry={listResult.refetch} />
                    ) : listResult.isLoading || !listTable ? (
                        <QueryLoading className="h-full" />
                    ) : listTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No heavy unlicensed users"
                            description={`Nobody without a licence was active on 11 or more days in ${monthLabel(matrix.month)}.`}
                        />
                    ) : (
                        <DataGrid
                            columns={columns}
                            data={listTable}
                            defaultSort={[{ columnId: "Active Days", direction: "desc" }]}
                            theme={theme}
                            header={{
                                title: "Most active without a licence",
                                subtitle: `The ${formatKpi(listTable.rows.length, "whole")} unlicensed ${
                                    listTable.rows.length === 1 ? "person" : "people"
                                } active on the most days in ${monthLabel(matrix.month)}. The full ranked list is above, under Who to license next.`,
                            }}
                        />
                    )}
                </div>
            )}
        </Section>
    );
}
