-- V002: Consumption Central (module `consumption`): Copilot Studio credits, Viva/Copilot Chat
-- credits, Azure AI spend and tokens, Copilot pay-as-you-go. Table and column names match the
-- Fabric Lakehouse tables so the Consumption Central model reads dbo.<table> unchanged.
-- Created up front so a model refresh before the first collection finds empty tables; the publish
-- step fills them (and only ever adds NULLable columns). Types follow publish.TYPE_MAP and the
-- collectors' SCHEMAS (enforced by tests/test_azure_consumption.py).

IF OBJECT_ID(N'dbo.studio_tenant_daily', N'U') IS NULL
CREATE TABLE dbo.studio_tenant_daily (
    [billing_plan_id] NVARCHAR(4000) NULL,
    [billing_plan_name] NVARCHAR(4000) NULL,
    [environment_id] NVARCHAR(4000) NULL,
    [environment_name] NVARCHAR(4000) NULL,
    [capacity_type] NVARCHAR(4000) NULL,
    [entitled_quantity] FLOAT NULL,
    [prepaid_consumed] FLOAT NULL,
    [payg_consumed] FLOAT NULL,
    [usage_date] DATE NULL,
    [source_file] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.studio_agent', N'U') IS NULL
CREATE TABLE dbo.studio_agent (
    [snapshot_month] DATE NULL,
    [agent_name] NVARCHAR(4000) NULL,
    [agent_id] NVARCHAR(4000) NULL,
    [product] NVARCHAR(4000) NULL,
    [billable_feature] NVARCHAR(4000) NULL,
    [billed_credit] FLOAT NULL,
    [non_billed_credit] FLOAT NULL,
    [channel] NVARCHAR(4000) NULL,
    [knowledge_sources] NVARCHAR(4000) NULL,
    [tool_used] NVARCHAR(4000) NULL,
    [llm_model] NVARCHAR(4000) NULL,
    [scenario_name] NVARCHAR(4000) NULL,
    [environment_id] NVARCHAR(4000) NULL,
    [environment_name] NVARCHAR(4000) NULL,
    [source_file] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.studio_user', N'U') IS NULL
CREATE TABLE dbo.studio_user (
    [snapshot_month] DATE NULL,
    [user_id] NVARCHAR(4000) NULL,
    [user_email] NVARCHAR(4000) NULL,
    [agent_id] NVARCHAR(4000) NULL,
    [agent_name] NVARCHAR(4000) NULL,
    [billable_credit_used] FLOAT NULL,
    [credits_used] FLOAT NULL,
    [m365_copilot_licensed] BIT NULL,
    [source_file] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.studio_agent_daily', N'U') IS NULL
CREATE TABLE dbo.studio_agent_daily (
    [usage_date] DATE NULL,
    [agent_id] NVARCHAR(4000) NULL,
    [billable_feature] NVARCHAR(4000) NULL,
    [channel] NVARCHAR(4000) NULL,
    [environment_id] NVARCHAR(4000) NULL,
    [agent_name] NVARCHAR(4000) NULL,
    [environment_name] NVARCHAR(4000) NULL,
    [billed_credit] FLOAT NULL,
    [non_billed_credit] FLOAT NULL,
    [users] FLOAT NULL,
    [llm_model] NVARCHAR(4000) NULL,
    [tool_used] NVARCHAR(4000) NULL,
    [knowledge_sources] NVARCHAR(4000) NULL,
    [source_file] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.studio_user_daily', N'U') IS NULL
CREATE TABLE dbo.studio_user_daily (
    [usage_date] DATE NULL,
    [user_id] NVARCHAR(4000) NULL,
    [environment_id] NVARCHAR(4000) NULL,
    [agent_id] NVARCHAR(4000) NULL,
    [user_upn] NVARCHAR(4000) NULL,
    [billed_credit] FLOAT NULL,
    [non_billed_credit] FLOAT NULL,
    [source_file] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.viva_credits_weekly', N'U') IS NULL
CREATE TABLE dbo.viva_credits_weekly (
    [person_id] NVARCHAR(4000) NULL,
    [user_principal_name] NVARCHAR(4000) NULL,
    [entra_id] NVARCHAR(4000) NULL,
    [people_historical_id] NVARCHAR(4000) NULL,
    [service_id] NVARCHAR(4000) NULL,
    [service_name] NVARCHAR(4000) NULL,
    [spending_policy_id] NVARCHAR(4000) NULL,
    [metric_date] DATE NULL,
    [session_count] INT NULL,
    [spending_policy_limit] BIGINT NULL,
    [credits_used] FLOAT NULL,
    [user_limit] BIGINT NULL,
    [display_name] NVARCHAR(4000) NULL,
    [department] NVARCHAR(4000) NULL,
    [organisation] NVARCHAR(4000) NULL,
    [job_title] NVARCHAR(4000) NULL,
    [job_family] NVARCHAR(4000) NULL,
    [city] NVARCHAR(4000) NULL,
    [country] NVARCHAR(4000) NULL,
    [cost_center] NVARCHAR(4000) NULL,
    [manager] NVARCHAR(4000) NULL,
    [business_unit] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.viva_spending_policy', N'U') IS NULL
CREATE TABLE dbo.viva_spending_policy (
    [spending_policy_id] NVARCHAR(4000) NULL,
    [name] NVARCHAR(4000) NULL,
    [plan_limit] BIGINT NULL,
    [user_limit] BIGINT NULL,
    [included_services] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.azure_ai_spend', N'U') IS NULL
CREATE TABLE dbo.azure_ai_spend (
    [UsageDate] DATE NULL,
    [ServiceName] NVARCHAR(4000) NULL,
    [MeterCategory] NVARCHAR(4000) NULL,
    [Meter] NVARCHAR(4000) NULL,
    [ResourceId] NVARCHAR(4000) NULL,
    [ResourceName] NVARCHAR(4000) NULL,
    [ResourceGroup] NVARCHAR(4000) NULL,
    [Cost] FLOAT NULL,
    [UsageQuantity] FLOAT NULL,
    [Currency] NVARCHAR(4000) NULL,
    [DepartmentTag] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.azure_ai_tokens', N'U') IS NULL
CREATE TABLE dbo.azure_ai_tokens (
    [Date] DATE NULL,
    [ResourceName] NVARCHAR(4000) NULL,
    [ResourceGroup] NVARCHAR(4000) NULL,
    [Deployment] NVARCHAR(4000) NULL,
    [Metric] NVARCHAR(4000) NULL,
    [Value] FLOAT NULL
);
GO

IF OBJECT_ID(N'dbo.copilot_payg_spend', N'U') IS NULL
CREATE TABLE dbo.copilot_payg_spend (
    [UsageDate] DATE NULL,
    [SubscriptionId] NVARCHAR(4000) NULL,
    [Meter] NVARCHAR(4000) NULL,
    [ServiceTag] NVARCHAR(4000) NULL,
    [Product] NVARCHAR(4000) NULL,
    [Cost] FLOAT NULL,
    [UsageQuantity] FLOAT NULL,
    [Currency] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.azure_deployment_health', N'U') IS NULL
CREATE TABLE dbo.azure_deployment_health (
    [SnapshotDate] DATE NULL,
    [MetricDate] DATE NULL,
    [SubscriptionName] NVARCHAR(4000) NULL,
    [SubscriptionId] NVARCHAR(4000) NULL,
    [ResourceId] NVARCHAR(4000) NULL,
    [DeploymentId] NVARCHAR(4000) NULL,
    [DeploymentName] NVARCHAR(4000) NULL,
    [Application] NVARCHAR(4000) NULL,
    [ModelName] NVARCHAR(4000) NULL,
    [ModelVersion] NVARCHAR(4000) NULL,
    [SkuName] NVARCHAR(4000) NULL,
    [Region] NVARCHAR(4000) NULL,
    [PtuCapacity] FLOAT NULL,
    [MeanUtilizationPct] FLOAT NULL,
    [PeakUtilizationPct] FLOAT NULL,
    [Requests] FLOAT NULL,
    [ServerErrors5xx] FLOAT NULL,
    [Throttles429] FLOAT NULL,
    [MeanLatencyMs] FLOAT NULL
);
GO

IF OBJECT_ID(N'dbo.azure_solution_spend', N'U') IS NULL
CREATE TABLE dbo.azure_solution_spend (
    [UsageDate] DATE NULL,
    [SubscriptionName] NVARCHAR(4000) NULL,
    [SubscriptionId] NVARCHAR(4000) NULL,
    [ResourceId] NVARCHAR(4000) NULL,
    [ResourceName] NVARCHAR(4000) NULL,
    [ResourceGroup] NVARCHAR(4000) NULL,
    [Application] NVARCHAR(4000) NULL,
    [DepartmentTag] NVARCHAR(4000) NULL,
    [ServiceName] NVARCHAR(4000) NULL,
    [ServiceCategory] NVARCHAR(4000) NULL,
    [ActualCost] FLOAT NULL,
    [AmortizedCost] FLOAT NULL,
    [Currency] NVARCHAR(4000) NULL,
    [TotalTokensM] FLOAT NULL,
    [PaygTokensM] FLOAT NULL,
    [InputPaygCost] FLOAT NULL,
    [OutputPaygCost] FLOAT NULL,
    [CachedPaygCost] FLOAT NULL,
    [Requests] FLOAT NULL,
    [SpeechHours] FLOAT NULL,
    [DocumentPages] FLOAT NULL,
    [Images] FLOAT NULL,
    [AllocationStatus] NVARCHAR(4000) NULL,
    [PricingModel] NVARCHAR(4000) NULL,
    [BillingScope] NVARCHAR(4000) NULL
);
GO

IF OBJECT_ID(N'dbo.azure_billing_reconciliation', N'U') IS NULL
CREATE TABLE dbo.azure_billing_reconciliation (
    [Period] NVARCHAR(4000) NULL,
    [PeriodStart] DATE NULL,
    [PeriodEnd] DATE NULL,
    [Product] NVARCHAR(4000) NULL,
    [PoolName] NVARCHAR(4000) NULL,
    [Representation] NVARCHAR(4000) NULL,
    [Amount] FLOAT NULL,
    [Currency] NVARCHAR(4000) NULL,
    [Status] NVARCHAR(4000) NULL,
    [EvidenceType] NVARCHAR(4000) NULL,
    [Notes] NVARCHAR(4000) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_version WHERE version = 2)
INSERT dbo.schema_version (version, description) VALUES (2, N'consumption: Consumption Central tables');
GO
