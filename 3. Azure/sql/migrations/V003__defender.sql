-- V003: Defender, shadow AI and agent risk (module `defender`, optional). Table and column names match
-- the Fabric Lakehouse tables written by Copilot_Defender_Ingester.ipynb, so the model reads dbo.<table>
-- unchanged. Created up front so the Governance page's Shadow AI section finds empty tables before the
-- first collection (or when every probe is unlicensed). Types follow publish.TYPE_MAP and
-- valuelens_core.defender.COLUMNS (enforced by tests/test_azure_defender.py).

IF OBJECT_ID(N'dbo.defender_ai_watchlist', N'U') IS NULL
CREATE TABLE dbo.defender_ai_watchlist (
    [Tool] NVARCHAR(4000) NULL,
    [Category] NVARCHAR(4000) NULL,
    [Vendor] NVARCHAR(4000) NULL,
    [Posture] NVARCHAR(4000) NULL,
    [ProcessNames] NVARCHAR(4000) NULL,
    [Domains] NVARCHAR(4000) NULL,
    [InstallPrefixes] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.defender_shadow_ai_daily', N'U') IS NULL
CREATE TABLE dbo.defender_shadow_ai_daily (
    [Day] DATE NULL,
    [Window] NVARCHAR(4000) NULL,
    [Layer] NVARCHAR(4000) NULL,
    [Tool] NVARCHAR(4000) NULL,
    [Devices] BIGINT NULL,
    [Users] BIGINT NULL,
    [Events] BIGINT NULL,
    [LoadedAt] DATETIME2(6) NULL
);
GO

IF OBJECT_ID(N'dbo.defender_shadow_ai_totals_daily', N'U') IS NULL
CREATE TABLE dbo.defender_shadow_ai_totals_daily (
    [Day] DATE NULL,
    [Window] NVARCHAR(4000) NULL,
    [Layer] NVARCHAR(4000) NULL,
    [Devices] BIGINT NULL,
    [Users] BIGINT NULL,
    [Events] BIGINT NULL,
    [LoadedAt] DATETIME2(6) NULL
);
GO

IF OBJECT_ID(N'dbo.defender_ai_installed', N'U') IS NULL
CREATE TABLE dbo.defender_ai_installed (
    [SnapshotDate] DATE NULL,
    [Tool] NVARCHAR(4000) NULL,
    [Devices] BIGINT NULL,
    [SoftwareNames] NVARCHAR(4000) NULL,
    [LoadedAt] DATETIME2(6) NULL
);
GO

IF OBJECT_ID(N'dbo.defender_cloud_discovery_ai', N'U') IS NULL
CREATE TABLE dbo.defender_cloud_discovery_ai (
    [SnapshotDate] DATE NULL,
    [StreamId] NVARCHAR(4000) NULL,
    [StreamName] NVARCHAR(4000) NULL,
    [AppId] NVARCHAR(4000) NULL,
    [AppName] NVARCHAR(4000) NULL,
    [Category] NVARCHAR(4000) NULL,
    [RiskScore] BIGINT NULL,
    [Users] BIGINT NULL,
    [Devices] BIGINT NULL,
    [IpAddresses] BIGINT NULL,
    [Transactions] BIGINT NULL,
    [UploadBytes] BIGINT NULL,
    [DownloadBytes] BIGINT NULL,
    [LastSeen] DATETIME2(6) NULL,
    [Tags] NVARCHAR(4000) NULL,
    [Posture] NVARCHAR(4000) NULL,
    [WatchlistTool] NVARCHAR(4000) NULL,
    [LoadedAt] DATETIME2(6) NULL
);
GO

IF OBJECT_ID(N'dbo.defender_ai_agents', N'U') IS NULL
CREATE TABLE dbo.defender_ai_agents (
    [SnapshotDate] DATE NULL,
    [AgentId] NVARCHAR(4000) NULL,
    [AgentName] NVARCHAR(4000) NULL,
    [Platform] NVARCHAR(4000) NULL,
    [SourceTable] NVARCHAR(4000) NULL,
    [EntraAgentId] NVARCHAR(4000) NULL,
    [BotId] NVARCHAR(4000) NULL,
    [AppId] NVARCHAR(4000) NULL,
    [AuthenticationType] NVARCHAR(4000) NULL,
    [SignInRequired] NVARCHAR(4000) NULL,
    [UsesWebKnowledge] NVARCHAR(4000) NULL,
    [PublishedStatus] NVARCHAR(4000) NULL,
    [LifecycleStatus] NVARCHAR(4000) NULL,
    [Availability] NVARCHAR(4000) NULL,
    [LoadedAt] DATETIME2(6) NULL
);
GO

IF OBJECT_ID(N'dbo.defender_status', N'U') IS NULL
CREATE TABLE dbo.defender_status (
    [RunAt] DATETIME2(6) NULL,
    [Probe] NVARCHAR(4000) NULL,
    [Status] NVARCHAR(4000) NULL,
    [Source] NVARCHAR(4000) NULL,
    [Rows] BIGINT NULL,
    [Message] NVARCHAR(4000) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_version WHERE version = 3)
INSERT dbo.schema_version (version, description) VALUES (3, N'defender: shadow AI and agent risk tables');
GO
