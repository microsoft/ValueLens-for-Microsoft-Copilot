//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/** A text box for a figure the app saves. */
export const INPUT =
    "h-[32px] w-full rounded-md border border-input bg-card px-200 text-[length:var(--text-300)] text-foreground tabular-nums placeholder:text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive";

/** The button that saves. */
export const PRIMARY =
    "h-[32px] rounded-md bg-primary px-300 text-[length:var(--text-300)] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";

/** Any other button beside it. */
export const SECONDARY =
    "h-[32px] rounded-md border border-border px-300 text-[length:var(--text-300)] font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";
