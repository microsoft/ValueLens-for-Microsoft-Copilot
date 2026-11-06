//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext } from "react";
import type { StageId } from "@/components/destinations";

export interface StageFilter {
    /** Whether the screen should render this stage. */
    show: (stage: StageId) => boolean;
    /**
     * True inside a report pack, where a screen leaves out its page-level
     * editors (rates, selectors that change saved settings) and keeps only
     * what reads as a report.
     */
    inPack: boolean;
}

const ALL: StageFilter = { show: () => true, inPack: false };

/**
 * Which of a screen's stages to render. A destination page shows them all; a
 * report pack mounts the same screen and shows only the stages it holds.
 */
export const StageFilterContext = createContext<StageFilter>(ALL);

export function useStageFilter(): StageFilter {
    return useContext(StageFilterContext);
}

/** A filter showing only `stages`, for a pack's run of one destination. */
export function onlyStages(stages: readonly StageId[]): StageFilter {
    const wanted = new Set(stages);
    return { show: (stage) => wanted.has(stage), inPack: true };
}
