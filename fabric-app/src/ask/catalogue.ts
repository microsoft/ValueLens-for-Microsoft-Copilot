//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DestinationId } from "@/components/destinations";
import type { FilterKey } from "@/lib/filters";
import raw from "./catalogue.json";

/** The questions the Ask page suggests for one destination. */
export interface AskPage {
    destination: DestinationId;
    questions: string[];
}

/**
 * A named query Ask may run. The Azure `/api/ask` offers these, and only
 * these, to its model as tools; the Fabric data agent's instructions name
 * them as the way each figure is worked out.
 */
export interface AskTool {
    name: string;
    /** The destination whose figures the query reproduces, or `appendix`. */
    page: DestinationId;
    /** The model alias the query reads: `vl` or `cc`. */
    model: "vl" | "cc";
    /** Path under `src/queries`. */
    query: string;
    /** The filter bar's filters the query accepts, applied as the page applies them. */
    filters: FilterKey[];
    /** Columns that together count the people behind a row; rows under `minPeople` are left out. */
    people?: string[];
    /**
     * Columns the query returns that the Azure `/api/ask` leaves out of the
     * rows its model reads, because they aren't right to quote. The query
     * still works them out.
     */
    omit?: string[];
    /**
     * The model's measures and columns behind the figures, as `[Measure]` and
     * `'Table'[Column]`, when the query works some of them out itself for
     * speed. The Fabric data agent's instructions name these instead of the
     * ones the query names, so it uses the model's own measures.
     */
    references?: string[];
    description: string;
}

export interface AskCatalogue {
    minPeople: number;
    pages: AskPage[];
    tools: AskTool[];
}

export const askCatalogue = raw as unknown as AskCatalogue;
