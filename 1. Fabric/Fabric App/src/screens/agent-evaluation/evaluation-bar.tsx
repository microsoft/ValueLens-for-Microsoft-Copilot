//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { ChoiceMenu } from "@/components/choice-menu";
import { availablePresets, DATE_PRESET_LABELS, formatDateRange } from "@/lib/filters";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { selectionRange, type EvaluationOptions, type EvaluationPreset, type EvaluationSelection } from "@/queries/agent-evaluation";

interface EvaluationBarProps {
    options: EvaluationOptions | undefined;
    selection: EvaluationSelection;
    onChange: (selection: EvaluationSelection) => void;
}

/**
 * The page's own slicers — dates, department and agent — where the filter
 * bar sits on the other destinations. Every chart and table below follows
 * them. A slicer with one value to offer is left out.
 */
export function EvaluationBar({ options, selection, onChange }: EvaluationBarProps) {
    const first = options?.firstDate;
    const last = options?.lastDate;
    const presets = useMemo(
        () =>
            first && last
                ? availablePresets(first, last).map((preset) => ({ value: preset, label: DATE_PRESET_LABELS[preset] }))
                : [],
        [first, last],
    );
    const departments = options?.departments ?? [];
    const agents = options?.agents ?? [];
    const range = selectionRange(selection.preset, options);
    const shown = range ?? (first && last ? { from: first, to: last } : undefined);

    return (
        <div
            role="group"
            aria-label="Agent Evaluation slicers"
            className="sticky top-0 z-10 -mx-700 -mb-200 flex flex-wrap items-center gap-x-400 gap-y-200 border-b border-border bg-background px-700 py-300"
        >
            <ChoiceMenu
                label="Dates"
                allLabel={DATE_PRESET_LABELS.all}
                choices={presets}
                value={selection.preset === "all" ? undefined : selection.preset}
                onChange={(preset) => onChange({ ...selection, preset: (preset as EvaluationPreset | undefined) ?? "all" })}
            />
            {departments.length > 1 && (
                <ChoiceMenu
                    label="Department"
                    allLabel="All departments"
                    choices={departments}
                    value={selection.department}
                    onChange={(department) => onChange({ ...selection, department })}
                />
            )}
            {agents.length > 1 && (
                <ChoiceMenu
                    label="Agent"
                    allLabel="All agents"
                    choices={agents}
                    value={selection.agent}
                    onChange={(agent) => onChange({ ...selection, agent })}
                />
            )}
            {shown && (
                <span className={cn(SMALL, "tabular-nums text-muted-foreground")}>
                    {formatDateRange(shown.from, shown.to)}
                </span>
            )}
        </div>
    );
}
