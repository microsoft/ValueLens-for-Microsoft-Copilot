//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { CoworkReadinessStage } from "./cowork-readiness-stage";
import { HabitLicenceStage } from "./habit-licence-stage";
import { LicenseReadinessStage } from "./license-readiness-stage";

/**
 * Who is ready for more: the report's License Readiness page (with License
 * Allocation folded in) and its Cowork Readiness page, in report order.
 */
export function ReadinessScreen() {
    return (
        <div className="flex flex-col gap-800">
            <LicenseReadinessStage />
            <HabitLicenceStage />
            <CoworkReadinessStage />
        </div>
    );
}
