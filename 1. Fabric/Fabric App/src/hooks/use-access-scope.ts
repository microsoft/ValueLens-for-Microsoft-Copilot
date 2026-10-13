//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { ACCESS_SCOPE_QUERY, readAccessScope, type AccessScopeState } from "@/lib/access-scope";
import { toRecords } from "@/lib/summary-row";
import { connection } from "@/queries/shared";
import { useSemanticModelQuery } from "./use-semantic-model-query";

/**
 * Whose data the signed-in person sees under org-scoped access, read once from the ValueLens
 * model. A model without the access tables answers `off`, so installs that never turned it on
 * look exactly as before.
 */
export function useAccessScope(): AccessScopeState {
    const { data, error } = useSemanticModelQuery({ connection, query: ACCESS_SCOPE_QUERY });
    return useMemo(
        () =>
            readAccessScope({
                rows: data?.status === "success" ? toRecords(data.table) : undefined,
                loaded: data?.status === "success",
                error: data?.status === "error" ? data.error.message : error?.message,
            }),
        [data, error],
    );
}
