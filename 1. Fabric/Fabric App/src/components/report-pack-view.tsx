//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { Suspense, useMemo } from "react";
import { DataToContext } from "@/hooks/data-to.context";
import { FilterContext, useFilterContext } from "@/hooks/filter.context";
import { paletteClass, usePaletteTheme } from "@/hooks/use-palette-theme";
import { onlyStages, StageFilterContext } from "@/hooks/stage-filter.context";
import { ThemeContext, useThemeContext } from "@/hooks/theme.context";
import { useSourceFreshness } from "@/hooks/use-source-freshness";
import { PAGE_SOURCES } from "@/lib/freshness";
import { earliestDate, packSources, stageLabel, type PackRun } from "@/lib/report-pack";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { SCREENS } from "@/screens/registry";
import type { StageId } from "./destinations";
import { FreshnessLabel } from "./freshness-label";
import { QueryLoading } from "./query-states";

/**
 * One destination's stages within a pack: the destination's own screen,
 * showing only those stages, in its own palette and answering only to the
 * slicers that destination offers — exactly as the stages read on their page.
 */
function PackRunView({ run }: { run: PackRun }) {
    const { destination, stages } = run;
    const themeContext = useThemeContext();
    const theme = usePaletteTheme(destination.id);
    const outer = useFilterContext();
    const filters = useMemo(() => ({ ...outer, applicable: destination.filters }), [outer, destination.filters]);
    const stageFilter = useMemo(() => onlyStages(stages), [stages]);
    const sources = PAGE_SOURCES[destination.id];
    const dates = useSourceFreshness(sources);
    const dataTo = earliestDate(sources.map((source) => dates[source]));
    const Screen = SCREENS[destination.id];

    return (
        <div className={cn("flex flex-col gap-700", paletteClass(destination.id))} data-pack-run={destination.id}>
            <p className={cn(SMALL, "-mb-500 text-muted-foreground")}>From {destination.label}</p>
            <ThemeContext.Provider value={{ ...themeContext, theme }}>
                <FilterContext.Provider value={filters}>
                    <StageFilterContext.Provider value={stageFilter}>
                        <DataToContext.Provider value={dataTo}>
                            <Suspense fallback={<QueryLoading />}>
                                <Screen />
                            </Suspense>
                        </DataToContext.Provider>
                    </StageFilterContext.Provider>
                </FilterContext.Provider>
            </ThemeContext.Provider>
        </div>
    );
}

/** A report pack read as one page: its runs of stages in order, then where the data stops. */
export function ReportPackView({ runs, missing }: { runs: readonly PackRun[]; missing: readonly StageId[] }) {
    const sources = useMemo(() => packSources(runs), [runs]);
    return (
        <>
            {missing.length > 0 && (
                <p role="note" className={cn(SMALL, "rounded-lg border border-dashed border-border px-400 py-300 text-muted-foreground")}>
                    Not shown, because this install doesn't have them set up: {missing.map(stageLabel).join(", ")}.
                </p>
            )}
            {runs.length === 0 ? (
                <p className="text-[length:var(--text-300)] leading-300 text-muted-foreground">
                    None of this pack's stages are available here.
                </p>
            ) : (
                runs.map((run, index) => <PackRunView key={`${run.destination.id}-${index}`} run={run} />)
            )}
            <footer className="border-t border-border pt-300">
                <FreshnessLabel sources={sources} />
            </footer>
        </>
    );
}
