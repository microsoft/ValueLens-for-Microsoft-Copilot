//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { cn } from "./utils";

/** The quiet bordered button used for page actions. */
export const ACTION_BUTTON = cn(
    "flex h-[32px] items-center gap-200 rounded-md border border-border bg-card px-300 text-[length:var(--text-200)] leading-200 text-foreground transition-colors",
    "hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card",
);
