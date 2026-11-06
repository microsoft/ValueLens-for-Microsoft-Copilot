//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext } from "react";
import { ALL_UNKNOWN, type SourceAvailability } from "@/lib/optional-sources";

/**
 * Which optional sources have data, checked once as the app loads. Without a
 * provider, as in isolated component tests, every source counts as unknown
 * and nothing is hidden.
 */
export const SourceAvailabilityContext = createContext<SourceAvailability>(ALL_UNKNOWN);

export function useSourceAvailability(): SourceAvailability {
    return useContext(SourceAvailabilityContext);
}
