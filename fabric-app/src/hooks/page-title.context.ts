//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext } from "react";

/**
 * The page's own title, so a section named the same as the page doesn't
 * repeat it on screen. `undefined` outside a page, such as in a report pack.
 */
export const PageTitleContext = createContext<string | undefined>(undefined);

export function usePageTitle(): string | undefined {
    return useContext(PageTitleContext);
}
