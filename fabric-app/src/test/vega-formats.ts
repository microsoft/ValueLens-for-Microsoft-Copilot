//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { expressionFunction } from "vega";
import { formatValue } from "@microsoft/fabric-visuals-core";

// The visual registers these before it renders; specs that run Vega directly
// register the same two so their labels match the app's.
expressionFunction("vbaFormat", (value: unknown, format: string) => String(formatValue(value, format)));
expressionFunction("compactFormat", (value: unknown, format: string) => String(formatValue(value, format, { compact: true })));
