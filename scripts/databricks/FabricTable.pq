let
    // One SQL warehouse connection; catalog, schema and table names are navigation only.
    // Azure Databricks connector. For a non-Azure workspace, use DatabricksMultiCloud.Catalogs.
    Catalogs = Databricks.Catalogs(#"Databricks Server Hostname", #"Databricks HTTP Path",
        [Catalog = null, Database = null, EnableAutomaticProxyDiscovery = null]),
    // Unity Catalog names are lowercase; match by name because connector versions label
    // the catalog and schema levels with different Kind values.
    Pick = (navigation as table, name as text, label as text, scope as text) as table =>
        let
            Matches = Table.SelectRows(navigation, each Text.Lower([Name]) = Text.Lower(name)),
            Count = Table.RowCount(Matches)
        in
            if Count = 1 then Matches{0}[Data]
            else if Count = 0 then error Error.Record("Databricks.NotFound",
                label & " '" & name & "' was not found in " & scope
                    & ". Check the Databricks parameters and that the signed-in identity can read it.", name)
            else error Error.Record("Databricks.Ambiguous",
                label & " '" & name & "' matches more than one object in " & scope & ".", name),
    Schema = Pick(
        Pick(Catalogs, #"Databricks Catalog", "Catalog", "this SQL warehouse"),
        #"Databricks Schema", "Schema", "catalog '" & #"Databricks Catalog" & "'"),
    ReadTable = (tableName as text) as table =>
        Pick(Schema, tableName, "Table",
            "'" & #"Databricks Catalog" & "." & #"Databricks Schema"
                & "'. If a notebook has not written it yet, run that notebook first")
in
    ReadTable
