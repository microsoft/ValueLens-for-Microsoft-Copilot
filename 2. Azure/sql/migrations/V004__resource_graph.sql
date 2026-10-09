-- V004: Azure Resource Graph (module `resourceGraph`): Copilot Studio agent configuration, Power
-- Platform environments and agent flows from PowerPlatformResources, Foundry accounts and projects
-- from resources, and one status row per probe. Table and column names match the Fabric Lakehouse
-- tables. Created up front so a model refresh before the first collection finds empty tables; the
-- publish step fills them. Types follow publish.TYPE_MAP and resource_graph.ARG_SCHEMAS (enforced by
-- tests/test_resource_graph.py).

IF OBJECT_ID(N'dbo.arg_agent_config', N'U') IS NULL
CREATE TABLE dbo.arg_agent_config (
    [SnapshotDate] DATE NULL,
    [AgentResourceId] NVARCHAR(4000) NULL,
    [BotId] NVARCHAR(4000) NULL,
    [AgentName] NVARCHAR(4000) NULL,
    [EntraAgentId] NVARCHAR(4000) NULL,
    [EntraAppId] NVARCHAR(4000) NULL,
    [TitleId] NVARCHAR(4000) NULL,
    [MatchedOn] NVARCHAR(4000) NULL,
    [EnvironmentId] NVARCHAR(4000) NULL,
    [Authentication] NVARCHAR(4000) NULL,
    [NoSignIn] BIT NULL,
    [IsQuarantined] BIT NULL,
    [IsManaged] BIT NULL,
    [WebSearchEnabled] BIT NULL,
    [ConnectorCount] BIGINT NULL,
    [McpConnectorCount] BIGINT NULL,
    [KnowledgeConnectorCount] BIGINT NULL,
    [ConnectedAgentCount] BIGINT NULL,
    [Connectors] NVARCHAR(4000) NULL,
    [SharedUsers] BIGINT NULL,
    [SharedGroups] BIGINT NULL,
    [SharedEntireTenant] BIT NULL,
    [Orchestration] NVARCHAR(4000) NULL,
    [Model] NVARCHAR(4000) NULL,
    [Channels] NVARCHAR(4000) NULL,
    [OwnerId] NVARCHAR(4000) NULL,
    [CreatedIn] NVARCHAR(4000) NULL,
    [LastPublishedAt] NVARCHAR(4000) NULL,
    [Source] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.arg_environments', N'U') IS NULL
CREATE TABLE dbo.arg_environments (
    [SnapshotDate] DATE NULL,
    [EnvironmentId] NVARCHAR(4000) NULL,
    [EnvironmentName] NVARCHAR(4000) NULL,
    [EnvironmentType] NVARCHAR(4000) NULL,
    [IsDefault] BIT NULL,
    [IsManaged] BIT NULL,
    [Region] NVARCHAR(4000) NULL,
    [Source] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.arg_agent_flows', N'U') IS NULL
CREATE TABLE dbo.arg_agent_flows (
    [SnapshotDate] DATE NULL,
    [FlowId] NVARCHAR(4000) NULL,
    [FlowName] NVARCHAR(4000) NULL,
    [EnvironmentId] NVARCHAR(4000) NULL,
    [OwnerId] NVARCHAR(4000) NULL,
    [ConnectorCount] BIGINT NULL,
    [Trigger] NVARCHAR(4000) NULL,
    [CreatedAt] NVARCHAR(4000) NULL,
    [LastModifiedAt] NVARCHAR(4000) NULL,
    [Source] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.arg_foundry_resources', N'U') IS NULL
CREATE TABLE dbo.arg_foundry_resources (
    [SnapshotDate] DATE NULL,
    [ResourceId] NVARCHAR(4000) NULL,
    [ResourceName] NVARCHAR(4000) NULL,
    [ResourceType] NVARCHAR(4000) NULL,
    [Kind] NVARCHAR(4000) NULL,
    [Location] NVARCHAR(4000) NULL,
    [SubscriptionId] NVARCHAR(4000) NULL,
    [ResourceGroup] NVARCHAR(4000) NULL,
    [Sku] NVARCHAR(4000) NULL,
    [PublicNetworkAccess] NVARCHAR(4000) NULL,
    [PublicNetwork] BIT NULL,
    [DisableLocalAuth] BIT NULL,
    [IsProject] BIT NULL,
    [AccountId] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.arg_status', N'U') IS NULL
CREATE TABLE dbo.arg_status (
    [SnapshotDate] DATE NULL,
    [Probe] NVARCHAR(4000) NULL,
    [Status] NVARCHAR(4000) NULL,
    [Rows] BIGINT NULL,
    [Source] NVARCHAR(4000) NULL,
    [Detail] NVARCHAR(4000) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_version WHERE version = 4)
INSERT dbo.schema_version (version, description) VALUES (4, N'resourceGraph: Azure Resource Graph tables');
GO
