-- V005: org-scoped access (opt-in row-level security). Table and column names match the Fabric
-- Lakehouse tables written by AnalyticsHub_Access_Scope.ipynb, so the models read either the same way.
--
-- access_scope: who sees what. One row per (person, scope). UserPrincipalName is lower-case; '*' is the
-- default for anyone without rows of their own. ScopeType is 'all', 'hierarchy' (ScopeValue = the root
-- person's UPN) or 'org' (ScopeValue = an org attribute value). Status is 'active' or 'pending_group'.
-- GrantedVia is 'seed' or 'installer' (rows the installer manages from landing/access/access_scope.csv)
-- or 'share' (rows granted in the app). The publish step replaces only the installer-managed rows.
--
-- access_people: one row per person with their manager chain as lower-case UPNs joined by '|', top
-- first. Rebuilt by the publish step from copilot_org_data.
--
-- Created whether or not row-level security is on: models without it never read these tables.

IF OBJECT_ID(N'dbo.access_scope', N'U') IS NULL
CREATE TABLE dbo.access_scope (
    [UserPrincipalName] NVARCHAR(320) NOT NULL,
    [ScopeType] NVARCHAR(16) NOT NULL,
    [ScopeValue] NVARCHAR(400) NOT NULL DEFAULT N'',
    [CanDelegate] BIT NOT NULL DEFAULT 0,
    [GrantedBy] NVARCHAR(320) NULL,
    [GrantedVia] NVARCHAR(16) NOT NULL DEFAULT N'installer',
    [Status] NVARCHAR(16) NOT NULL DEFAULT N'active',
    [Note] NVARCHAR(400) NULL,
    [CreatedAt] DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT [UQ_access_scope] UNIQUE ([UserPrincipalName], [ScopeType], [ScopeValue])
);
GO

IF OBJECT_ID(N'dbo.access_people', N'U') IS NULL
CREATE TABLE dbo.access_people (
    [PersonId] NVARCHAR(4000) NULL,
    [OrgPath] NVARCHAR(4000) NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_version WHERE version = 5)
INSERT dbo.schema_version (version, description) VALUES (5, N'access: org-scoped access tables');
GO
