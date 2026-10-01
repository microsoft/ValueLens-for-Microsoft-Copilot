//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { cn } from "./utils";

/** One option row in a dropdown menu panel, selected or not. */
export const menuOptionClass = (selected: boolean) =>
    cn(
        "flex w-full items-center justify-between gap-300 rounded-md px-300 py-200 text-left text-[length:var(--text-300)] leading-300 transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
        selected ? "bg-accent font-semibold text-accent-foreground" : "text-foreground hover:bg-secondary",
    );
