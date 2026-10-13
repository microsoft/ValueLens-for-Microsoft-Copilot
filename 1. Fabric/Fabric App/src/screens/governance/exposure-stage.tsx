//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { stageAnchor } from "@/components/destinations";
import { ChartPanel, NoteCard } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useTableQuery } from "@/hooks/use-table-query";
import {
    applyExposureTheme,
    completeExposureGrid,
    EXPOSURE_ACCESS_WITH_WEB,
    governanceExposure,
    governancePublicWeb,
    PUBLIC_WEB,
    soleExposureAccess,
    withPublicWeb,
} from "@/queries/governance";

const EXPOSURE = governanceExposure();
const PUBLIC_WEB_QUERY = governancePublicWeb();
const NO_PUBLIC_WEB = { ...PUBLIC_WEB_QUERY, query: "" };

/** Said when every agent sits in one data access column, so the empty columns read as a finding, not a fault. */
function soleAccessNote(access: string): string {
    if (access === "Not reported") return "The registry gave no capability details for these agents, so what they can read is unknown";
    if (access === "None declared") return "None of these agents declares any data it can read";
    return `Every one of these agents can read ${access.toLowerCase()}`;
}

const NOTES = [
    {
        term: "The corner to watch",
        text: "Top left: agents anyone in the organisation can use that also read organisation content. Each is worth a check that it only surfaces what its audience should see.",
    },
    {
        term: "Shared with",
        text: "Who the registry says can use the agent. Not stated means the registry or its export didn't say.",
    },
    {
        term: "What it can read",
        text: "Organisation content means SharePoint sites, OneDrive files or Graph connectors. Not reported means the registry gave no capability details for the agent.",
    },
];

const PUBLIC_WEB_NOTE = {
    term: PUBLIC_WEB,
    text: "Agents with web search turned on as a knowledge source, from Azure Resource Graph. They also appear under whatever else they can read.",
};

/**
 * How widely each tenant-built agent is shared against what it can read,
 * so the agents that could surface organisation content to everyone stand
 * out. Blocked agents are left out, since nobody can reach them.
 */
export function ExposureStage() {
    const { theme } = useThemeContext();
    const exposure = useTableQuery(EXPOSURE);
    const resourceGraph = useSourceAvailability().resourceGraph === "present";
    const publicWeb = useTableQuery(resourceGraph ? PUBLIC_WEB_QUERY : NO_PUBLIC_WEB).table;
    const gridTable = useMemo(() => {
        if (!exposure.table) return undefined;
        if (!resourceGraph || !publicWeb) return completeExposureGrid(exposure.table);
        return completeExposureGrid(withPublicWeb(exposure.table, publicWeb), EXPOSURE_ACCESS_WITH_WEB);
    }, [exposure.table, publicWeb, resourceGraph]);
    const sole = soleExposureAccess(exposure.table);

    const spec = useMemo(
        () =>
            applyExposureTheme(EXPOSURE.vegaLiteSpec, {
                quiet: theme.backgroundHover || theme.backgroundSecondary,
                strong: theme.brandBackground,
                quietText: theme.foreground,
                strongText: theme.background,
            }),
        [theme],
    );

    return (
        <Section
            id={stageAnchor("exposure")}
            title="Exposure"
            description="Who can reach the agents built here, against what they can read."
        >
            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <ChartPanel
                    result={{ ...exposure, table: gridTable }}
                    spec={spec}
                    height={340}
                    title="Sharing against data access"
                    subtitle={
                        sole
                            ? soleAccessNote(sole)
                            : "Tenant-built agents in each pairing; hover for how many have no recorded use"
                    }
                    emptyTitle="No tenant-built agents"
                    emptyDescription="The registry holds no agents built in this tenant for these filters."
                />
                <div className="self-start">
                    <NoteCard title="Reading the map" notes={resourceGraph ? [...NOTES, PUBLIC_WEB_NOTE] : NOTES} />
                </div>
            </div>
        </Section>
    );
}
