//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { cn } from "@/lib/utils";

/** A button on the dark band: quiet outline, the label hidden on a phone. */
export const BAND_BUTTON = cn(
    "inline-flex h-[34px] shrink-0 items-center gap-200 rounded-full border border-white/20 bg-white/5 px-300",
    "text-[13px] font-medium text-band-foreground transition-colors hover:bg-white/12",
    "aria-expanded:bg-white/15 aria-[current=page]:border-band-accent aria-[current=page]:bg-white/15 aria-pressed:bg-white/15",
);
