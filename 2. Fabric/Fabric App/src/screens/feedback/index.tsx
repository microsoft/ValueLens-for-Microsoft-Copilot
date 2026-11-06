//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { FeedbackStage } from "./feedback-stage";

/**
 * The report's Feedback page rebuilt as a date-only destination: sentiment,
 * topics, surfaces and the latest written comments in one pass.
 */
export function FeedbackScreen() {
    return (
        <div className="flex flex-col gap-800">
            <FeedbackStage />
        </div>
    );
}
