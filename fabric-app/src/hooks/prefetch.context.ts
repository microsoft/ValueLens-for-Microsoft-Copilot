//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------
import { createContext, useContext } from "react";

/**
 * True inside a page mounted off screen only to fetch its queries ahead of a
 * visit: they run in the background lane, and nothing is drawn.
 */
export const PrefetchContext = createContext(false);

export function useIsPrefetch(): boolean {
    return useContext(PrefetchContext);
}
