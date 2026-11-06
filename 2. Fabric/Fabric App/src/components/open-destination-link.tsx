//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { useOpenDestination } from "@/hooks/navigation.context";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import type { DestinationId, StageId } from "./destinations";

interface OpenDestinationLinkProps {
    destination: DestinationId;
    stage?: StageId;
    children: ReactNode;
    className?: string;
}

/**
 * A link from a summary to the destination that tells that part of the story
 * in full. Left out when that destination isn't installed, or when there is no
 * app shell to navigate in.
 */
export function OpenDestinationLink({ destination, stage, children, className }: OpenDestinationLinkProps) {
    const open = useOpenDestination(destination);
    if (!open) return null;
    return (
        <button
            type="button"
            onClick={() => open(stage)}
            className={cn(
                "inline-flex w-fit items-center gap-100 font-semibold text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                SMALL,
                className,
            )}
        >
            {children}
            <ArrowRight className="icon-size-100" aria-hidden="true" />
        </button>
    );
}

/** The link as a card's footer, behind a hairline rule; left out with the link. */
export function OpenDestinationFooter(props: OpenDestinationLinkProps) {
    const open = useOpenDestination(props.destination);
    if (!open) return null;
    return (
        <div className="border-t border-border px-500 py-300">
            <OpenDestinationLink {...props} />
        </div>
    );
}