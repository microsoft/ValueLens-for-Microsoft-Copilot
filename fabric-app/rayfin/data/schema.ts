//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { CommercialTerms } from "./CommercialTerms.js";
import { ReportPack } from "./ReportPack.js";
import { TaskTime } from "./TaskTime.js";

// The app imports only this type. Importing the classes would ship their
// decorators to the browser.
export type ValueLensSchema = {
    CommercialTerms: CommercialTerms;
    ReportPack: ReportPack;
    TaskTime: TaskTime;
};

export const schema = [CommercialTerms, ReportPack, TaskTime];
