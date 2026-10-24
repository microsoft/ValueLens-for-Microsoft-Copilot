//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { ExternalLink } from "lucide-react";
import { PPAC_URL, UPLOAD_FOLDER } from "./studio-empty";

const LINK =
    "inline-flex items-center gap-100 text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Why the model or feature chart is empty, and how to fill it. Both read
 * per-agent detail only, so an empty chart always means none has loaded.
 */
export function PpacExportHowTo({ what }: { what: "model" | "feature" }) {
    return (
        <>
            <p>
                The {what} behind each credit comes from per-agent detail: the Copilot Studio credits flow's per-agent file
                or a Power Platform admin center export. Neither has loaded for this period. Per-user credits don't name a{" "}
                {what}, so they can't fill this chart.
            </p>
            <ol className="list-decimal pl-500">
                <li>
                    Open the{" "}
                    <a href={PPAC_URL} target="_blank" rel="noreferrer" className={LINK}>
                        Power Platform admin center
                        <ExternalLink className="icon-size-100 shrink-0" aria-hidden="true" />
                    </a>{" "}
                    and go to Licensing &gt; Products &gt; Copilot Studio.
                </li>
                <li>On the Agents tab, download the EntitlementConsumption…PerAgent…_MCSMessages CSV.</li>
                <li>
                    Drop it in the lakehouse folder <code className="font-mono">{UPLOAD_FOLDER}</code>, or the drop folder on
                    an Azure install. The next load picks it up, and the export wins for the month it covers.
                </li>
            </ol>
        </>
    );
}
