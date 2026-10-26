//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { lazy, type ComponentType } from "react";
import type { DestinationId } from "@/components/destinations";

// Screens load on demand so only the destinations on show query the model.
export const SCREENS: Readonly<Record<DestinationId, ComponentType>> = {
    executive: lazy(() => import("./executive").then((module) => ({ default: module.ExecutiveScreen }))),
    adoption: lazy(() => import("./adoption").then((module) => ({ default: module.AdoptionScreen }))),
    leaderboards: lazy(() => import("./leaderboards").then((module) => ({ default: module.LeaderboardsScreen }))),
    "work-patterns": lazy(() => import("./work-patterns").then((module) => ({ default: module.WorkPatternsScreen }))),
    readiness: lazy(() => import("./readiness").then((module) => ({ default: module.ReadinessScreen }))),
    consumption: lazy(() => import("./consumption").then((module) => ({ default: module.ConsumptionScreen }))),
    value: lazy(() => import("./value").then((module) => ({ default: module.ValueScreen }))),
    efficiency: lazy(() => import("./efficiency").then((module) => ({ default: module.EfficiencyScreen }))),
    feedback: lazy(() => import("./feedback").then((module) => ({ default: module.FeedbackScreen }))),
    ask: lazy(() => import("./ask").then((module) => ({ default: module.AskScreen }))),
    governance: lazy(() => import("./governance").then((module) => ({ default: module.GovernanceScreen }))),
    assumptions: lazy(() => import("./assumptions").then((module) => ({ default: module.AssumptionsScreen }))),
    appendix: lazy(() => import("./appendix").then((module) => ({ default: module.AppendixScreen }))),
};
