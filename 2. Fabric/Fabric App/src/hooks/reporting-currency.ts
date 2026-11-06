//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { useCommercialTerms } from "@/hooks/commercial-terms.context";
import { resolveReportingCurrency, type ReportingCurrency } from "@/lib/currency";
import { runtimeConfig } from "@/lib/runtime-config";

/**
 * The currency the Value page reports value and cost in: saved in the app,
 * else the installer's choice, else US dollars. `modelSymbol` is the model's
 * `[Currency Symbol]`, read only for an older install that saved an exchange
 * rate before the currency was a setting.
 */
export function useReportingCurrency(modelSymbol?: string): ReportingCurrency {
    const { saved } = useCommercialTerms();
    const install = runtimeConfig().reporting;
    return useMemo(() => resolveReportingCurrency({ saved, install, modelSymbol }), [saved, install, modelSymbol]);
}
