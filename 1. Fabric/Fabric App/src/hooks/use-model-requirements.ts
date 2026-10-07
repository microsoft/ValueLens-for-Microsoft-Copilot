//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import {
    combineRequirementStates,
    MODEL_REQUIREMENTS,
    readRequirementProbeState,
    requirementProbeDax,
    type ModelObjectRequirement,
    type ModelRequirementScope,
    type RequirementProbeState,
} from "@/lib/model-requirements";
import { useSemanticModelQuery } from "./use-semantic-model-query";

function useRequirementProbe(requirement: ModelObjectRequirement): RequirementProbeState {
    const query = useMemo(() => requirementProbeDax(requirement), [requirement]);
    const { data, error } = useSemanticModelQuery({ connection: requirement.model, query });
    return useMemo(
        () =>
            readRequirementProbeState(requirement, {
                loaded: data?.status === "success",
                error: data?.status === "error" ? data.error.message : error?.message,
            }),
        [data, error, requirement],
    );
}

/** Checks that a page's newer model dependencies are present before it runs its page queries. */
export function useModelRequirementState(scope: ModelRequirementScope): RequirementProbeState {
    const requirements = MODEL_REQUIREMENTS[scope];
    const governance = useRequirementProbe(requirements[0]!);
    return useMemo(() => combineRequirementStates([governance]), [governance]);
}
