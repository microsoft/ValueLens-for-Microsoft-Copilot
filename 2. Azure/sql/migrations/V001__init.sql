-- V001: schema_version + the curated interactions fact.
-- Table and column names match the Fabric Lakehouse table so the ValueLens Model's
-- queries keep their FabricTable(...) calls; only the parameters point at Sql.Database.
-- Columns are the model contract produced by valuelens_core.curate(); keep them in
-- step with tests/fixtures/valuelens-golden/expected (enforced by test_azure_scaffold.py).
-- Optional passthrough/source columns (e.g. *_Raw) are added by the publish step (ALTER ADD, NULLable).

IF OBJECT_ID(N'dbo.schema_version', N'U') IS NULL
CREATE TABLE dbo.schema_version (
    version     INT           NOT NULL PRIMARY KEY,
    description NVARCHAR(200) NOT NULL,
    applied_at  DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

IF OBJECT_ID(N'dbo.copilot_interactions_curated', N'U') IS NULL
CREATE TABLE dbo.copilot_interactions_curated (
    [Id] NVARCHAR(4000) NULL,
    [CreationDate] DATETIME2(6) NULL,
    [Audit_UserId] NVARCHAR(4000) NULL,
    [Message_isPrompt] NVARCHAR(4000) NULL,
    [ModelTransparencyDetails_ModelProviderName] NVARCHAR(4000) NULL,
    [ModelTransparencyDetails_ModelName] NVARCHAR(4000) NULL,
    [ApplicationName] NVARCHAR(4000) NULL,
    [Audit_UserKey] NVARCHAR(4000) NULL,
    [SensitivityLabelId] NVARCHAR(4000) NULL,
    [AccessedResource_SensitivityLabelId] NVARCHAR(4000) NULL,
    [RecordId] NVARCHAR(4000) NULL,
    [Source_RecordKey] NVARCHAR(4000) NULL,
    [Source_MessageKey] NVARCHAR(4000) NULL,
    [Source_ResourceKey] NVARCHAR(4000) NULL,
    [AppIdentity_AppId] NVARCHAR(4000) NULL,
    [AppIdentity_DisplayName] NVARCHAR(4000) NULL,
    [AccessedResource_Type] NVARCHAR(4000) NULL,
    [AccessedResource_Action] NVARCHAR(4000) NULL,
    [AccessedResource_SiteUrl] NVARCHAR(4000) NULL,
    [AISystemPlugin_Id] NVARCHAR(4000) NULL,
    [AISystemPlugin_Name] NVARCHAR(4000) NULL,
    [InteractionDate] DATE NULL,
    [WeekStart] DATE NULL,
    [MonthStart] DATE NULL,
    [Resource_Count] BIGINT NULL,
    [Has license] NVARCHAR(4000) NULL,
    [Agent_TitleID] NVARCHAR(4000) NULL,
    [Agent_EntraId] NVARCHAR(4000) NULL,
    [AgentName] NVARCHAR(4000) NULL,
    [Agent_LinkID] NVARCHAR(4000) NULL,
    [AgentId] NVARCHAR(4000) NULL,
    [AppHost] NVARCHAR(4000) NULL,
    [AppIdentity_PublisherId] NVARCHAR(4000) NULL,
    [ClientRegion] NVARCHAR(4000) NULL,
    [Context_Type] NVARCHAR(4000) NULL,
    [Message_Id] NVARCHAR(4000) NULL,
    [ThreadId] NVARCHAR(4000) NULL,
    [Workload] NVARCHAR(4000) NULL,
    [Environment] NVARCHAR(4000) NULL,
    [License Status] NVARCHAR(4000) NULL,
    [Is_Sensitive] BIT NULL,
    [AI_Model] NVARCHAR(4000) NULL,
    [Behavior_Category] NVARCHAR(4000) NULL,
    [Behavior_Enriched] NVARCHAR(4000) NULL,
    [Behavior_Enriched_Full] NVARCHAR(4000) NULL,
    [Behavior_Source] NVARCHAR(4000) NULL,
    [Value_Outcome] NVARCHAR(4000) NULL,
    [Usage_Mode] NVARCHAR(4000) NULL,
    [Expertise_Role] NVARCHAR(4000) NULL,
    [Efficiency_Breakdown] NVARCHAR(4000) NULL,
    [Web_Grounded_Signal] NVARCHAR(4000) NULL,
    [Behavior_Plausible] NVARCHAR(4000) NULL,
    [Workflow_Action] NVARCHAR(4000) NULL,
    [Is_Agent_Activity] BIT NULL,
    [Agent Filter] NVARCHAR(4000) NULL,
    [Grounding Source] NVARCHAR(4000) NULL,
    [Agent_Surface] NVARCHAR(4000) NULL,
    [Execution_Trigger] NVARCHAR(4000) NULL,
    [UserMonthKey] NVARCHAR(4000) NULL,
    [Delegation_Event_Key] NVARCHAR(4000) NULL,
    [ActivityDate] DATETIME2(6) NULL,
    [Agent Last Used Date] DATETIME2(6) NULL,
    [User_Stage_Maturity] NVARCHAR(4000) NULL,
    [User_Stage] NVARCHAR(4000) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'cci_copilot_interactions_curated')
CREATE CLUSTERED COLUMNSTORE INDEX cci_copilot_interactions_curated
    ON dbo.copilot_interactions_curated;
GO

-- Publish rewrites only changed date partitions (DELETE + INSERT per day, one transaction each),
-- tracking per-day fingerprints in dbo.valuelens_publish_state, which it creates on first run.

IF NOT EXISTS (SELECT 1 FROM dbo.schema_version WHERE version = 1)
INSERT dbo.schema_version (version, description) VALUES (1, N'init: copilot_interactions_curated');
GO
