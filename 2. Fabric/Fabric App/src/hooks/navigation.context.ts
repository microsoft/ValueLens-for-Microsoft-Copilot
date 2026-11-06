//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext } from "react";
import { availableDestinations, type DestinationId, type StageId } from "@/components/destinations";
import { runtimeConfig } from "@/lib/runtime-config";
import { useSourceAvailability } from "./source-availability.context";

interface NavigationContextValue {
    /** Opens a destination, then brings one of its stages into view once it has rendered. */
    navigate: (destination: DestinationId, stage?: StageId) => void;
}

export const NavigationContext = createContext<NavigationContextValue | undefined>(undefined);

/** Undefined outside the app shell, so a screen rendered on its own leaves its links out. */
export function useNavigation(): NavigationContextValue | undefined {
    return useContext(NavigationContext);
}

/**
 * Opens `destination`, at one of its stages if given. Undefined outside the
 * app shell, when this install doesn't have that destination, or when its
 * source turned out to have no data.
 */
export function useOpenDestination(destination: DestinationId): ((stage?: StageId) => void) | undefined {
    const navigation = useNavigation();
    const sources = useSourceAvailability();
    if (!navigation) return undefined;
    const shown = availableDestinations(runtimeConfig().semanticModels, sources).some(({ id }) => id === destination);
    if (!shown) return undefined;
    return (stage) => navigation.navigate(destination, stage);
}
