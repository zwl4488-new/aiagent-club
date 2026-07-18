-- aiagent.club — 数据层 schema (阶段 0)
-- 设计纪律:metrics 表 append-only,只 INSERT/REPLACE 当天值,永不 UPDATE 历史。
-- 这份时序数据是护城河;一旦写了覆盖历史的逻辑,资产就没了。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 维度表:实体 ─────────────────────────────────────────────
-- entity_id 是全局主键,格式 '<kind>:<identifier>',见 src/entity.ts。
-- ecosystem 固化了"国内外双管道"的分界:global 由境外 Actions 抓,cn 由国内 FC 抓。
-- lang 固化了"数据用源语言、不翻译"的决定:渲染时据此包 <div lang>。
CREATE TABLE IF NOT EXISTS entities (
  entity_id   TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                 -- github|npm|pypi|hf|openrouter|mcp|pricing|coze|...
  ecosystem   TEXT NOT NULL CHECK (ecosystem IN ('global','cn')),
  name        TEXT,
  url         TEXT,
  category    TEXT,
  description TEXT,                           -- 项目一句话简介(github GraphQL / npm / pypi 取,详情页展示)
  intro       TEXT,                           -- 项目介绍摘录(README / long_description 清洗出的前几段 prose,详情页展示)
  project_key TEXT,                           -- 多源归并键(小写 github owner/name;取不到=自身 entity_id),同 key = 同一项目
  lang        TEXT CHECK (lang IN ('en','zh') OR lang IS NULL),
  first_seen  TEXT,                          -- ISO date 'YYYY-MM-DD'
  last_seen   TEXT,
  active      INTEGER NOT NULL DEFAULT 1
);

-- ── 事实表:时序指标(append-only) ──────────────────────────
-- 一个实体的一个指标,每天一行。UNIQUE + REPLACE = 幂等:
-- 同一天重跑/重试只覆盖当天,不产生重复行,也不动别的天。
-- 这条约束是整条管道敢于无人值守的基础。
CREATE TABLE IF NOT EXISTS metrics (
  entity_id   TEXT NOT NULL,
  metric      TEXT NOT NULL,                 -- stars|downloads|contributors|commits|...
  value       REAL NOT NULL,
  captured_at TEXT NOT NULL,                 -- ISO date 'YYYY-MM-DD'
  source      TEXT NOT NULL,                 -- 写入者(github/npm/fc-coze...),仅信息用途
  UNIQUE (entity_id, metric, captured_at) ON CONFLICT REPLACE
);

CREATE INDEX IF NOT EXISTS idx_metrics_lookup ON metrics (entity_id, metric, captured_at);

-- ── 运维表:抓取健康 ────────────────────────────────────────
-- 每次抓取写一行。同时是监控(不接外部监控服务)和公开"数据健康"页的数据源。
-- environment 固化"source 与执行环境解耦":同一个 source 可跑在 actions 或 fc-cn。
CREATE TABLE IF NOT EXISTS fetch_runs (
  source       TEXT NOT NULL,
  environment  TEXT NOT NULL,                -- 'actions' | 'fc-cn'
  status       TEXT NOT NULL CHECK (status IN ('ok','partial','error')),
  rows_written INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  started_at   TEXT NOT NULL,                -- ISO datetime
  finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_fetch_runs_time ON fetch_runs (started_at);

-- ── schema 版本 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '1');
