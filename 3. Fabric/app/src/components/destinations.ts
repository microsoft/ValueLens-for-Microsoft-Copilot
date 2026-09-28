//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { LucideIcon } from "lucide-react";
import { BookOpen, Bot, KeyRound, MessageSquareQuote, PoundSterling, TrendingUp, Workflow } from "lucide-react";

/** The six top-level destinations the sixteen report pages were folded into. */
export const destinations = [
    {
        id: "value",
        label: "Value",
        blurb: "What the investment returned",
        icon: PoundSterling as LucideIcon,
        ready: false,
    },
    {
        id: "adoption",
        label: "Adoption",
        blurb: "Who started, who stayed, who stuck",
        icon: TrendingUp as LucideIcon,
        ready: true,
    },
    {
        id: "licences",
        label: "Licences",
        blurb: "Readiness and allocation",
        icon: KeyRound as LucideIcon,
        ready: false,
    },
    {
        id: "work",
        label: "Work",
        blurb: "What people actually do with it",
        icon: Workflow as LucideIcon,
        ready: false,
    },
    {
        id: "agents",
        label: "Agents & Cowork",
        blurb: "Registry, fit and readiness",
        icon: Bot as LucideIcon,
        ready: false,
    },
    {
        id: "feedback",
        label: "Feedback",
        blurb: "What people say about it",
        icon: MessageSquareQuote as LucideIcon,
        ready: false,
    },
] as const;

export type DestinationId = (typeof destinations)[number]["id"];

/** The reference material that lives in the slide-over drawer, not in the nav. */
export const referenceIcon = BookOpen as LucideIcon;
