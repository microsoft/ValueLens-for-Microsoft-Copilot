//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext } from "react";

/**
 * The last date the data on show runs to, as an ISO date, so downloads can
 * carry it in their file names. `undefined` until the freshness queries answer.
 */
export const DataToContext = createContext<string | undefined>(undefined);

export function useDataTo(): string | undefined {
    return useContext(DataToContext);
}
