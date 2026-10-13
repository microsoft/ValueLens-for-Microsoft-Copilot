//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { stageAnchor } from "@/components/destinations";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useM365Activity } from "@/hooks/use-m365-activity";
import { M365_ACTIVITY_DESCRIPTION, M365_ACTIVITY_TITLE } from "./copy";
import { M365ActivityStage } from "./m365-activity-stage";
import { M365CopilotStage } from "./m365-copilot-stage";
import { M365SuiteStage } from "./m365-suite-stage";

/**
 * How people work across Microsoft 365, and where Copilot sits in that week.
 * The data is an optional installer module, so the page first checks it's
 * there and says how to switch it on, rather than showing a page of blanks.
 */
export function WorkPatternsScreen() {
    const activitySource = useSourceAvailability().m365Activity;
    if (activitySource === "notConfigured") return <M365NotConfigured />;
    return <WorkPatternsContent />;
}

function WorkPatternsContent() {
    const m365 = useM365Activity();

    if (m365.state === "ready") {
        return (
            <div className="flex flex-col gap-800">
                <M365ActivityStage concealed={m365.concealed} />
                <M365SuiteStage />
                <M365CopilotStage concealed={m365.concealed} />
            </div>
        );
    }

    return (
        <Section id={stageAnchor("m365-activity")} title={M365_ACTIVITY_TITLE} description={M365_ACTIVITY_DESCRIPTION}>
            {m365.state === "loading" ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : m365.state === "error" ? (
                <QueryError message={m365.error ?? "The semantic model didn't answer."} onRetry={m365.refetch} />
            ) : m365.state === "missing" ? (
                <QueryEmpty
                    title="Microsoft 365 activity isn't set up"
                    description="This ValueLens install predates Microsoft 365 activity. Pull the latest ValueLens and run npx valuelens-install update to add it. The page fills in after the next pipeline run."
                />
            ) : (
                <QueryEmpty
                    title="No Microsoft 365 activity yet"
                    description="Either the module is switched off, or it hasn't loaded yet. To switch it on, run npx valuelens-install and tick Microsoft 365 activity; it needs the Reports.Read.All permission. The usage reports run two to three days behind, so the first days take a little while to show."
                />
            )}
        </Section>
    );
}

function M365NotConfigured() {
    return (
        <Section id={stageAnchor("m365-activity")} title={M365_ACTIVITY_TITLE} description={M365_ACTIVITY_DESCRIPTION}>
            <QueryEmpty
                title="Microsoft 365 activity isn't turned on"
                description="Run the installer again and tick Microsoft 365 activity. It needs Reports.Read.All, and the page fills in after the next load and model refresh."
            />
        </Section>
    );
}
