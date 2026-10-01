//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { CommercialTerms } from "./CommercialTerms.js";

// The app imports only this type. Importing the classes would ship their
// decorators to the browser.
export type ValueLensSchema = {
    CommercialTerms: CommercialTerms;
};

export const schema = [CommercialTerms];
