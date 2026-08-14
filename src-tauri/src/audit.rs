//! 审计日志 (JSONL, 对应 Electron audit-log.js)
//!
//! - 字段白名单: [ts, level, user, session, type, target, result, detail]; ts 自动生成,
//!   忽略调用方传入 (防伪造/保证排序)。
//! - 按天滚动: audit-YYYY-MM-DD.jsonl (chrono Local)。
//! - 写入队列: mpsc UnboundedChannel + 后台 writer task (异步追加, 保序, 不阻塞业务路径)。
//! - 脱敏: PEM/OPENSSH 私钥块、password|passphrase|secret|token|api_key|auth 键值、JWT、
//!   65+ 连续 base64、user:pass@ 用户信息 (与 audit-log.js redact 规则一致)。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use serde::{Deserialize, Serialize};

use tokio::sync::mpsc;

/// 日志字段白名单 (固定 schema)。
const ALLOWED_FIELDS: [&str; 8] = [
    "ts", "level", "user", "session", "type", "target", "result", "detail",
];

/// 未初始化时的兜底: 直接静默丢弃。
static AUDIT: OnceLock<Mutex<AuditCore>> = OnceLock::new();

struct AuditCore {
    dir: PathBuf,
    tx: Option<mpsc::UnboundedSender<String>>,
}

/// 初始化审计日志: 确定日志目录、创建目录、启动后台 writer task (幂等)。
pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);

    // 若已初始化则仅更新目录 (测试/重置用)。
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    {
        let mut core = AUDIT
            .get_or_init(|| Mutex::new(AuditCore { dir: dir.clone(), tx: None }))
            .lock()
            .unwrap();
        core.dir = dir.clone();
        core.tx = Some(tx);
    }

    // 后台 writer task: 串行追加 + 跨天自动重开文件。
    // 修复: 直接用 tokio::spawn 会 panic ("there is no reactor running") —— setup 回调
    // 不在 Tokio runtime 上下文; tauri::async_runtime::spawn 持有自己的 handle, 任意上下文可用。
    tauri::async_runtime::spawn(async move {
        let mut writer: Option<std::fs::File> = None;
        let mut current_date: String = String::new();
        let mut rx = rx;
        while let Some(line) = rx.recv().await {
            let today = today_str();
            if writer.is_none() || current_date != today {
                writer = open_append(&dir, &today);
                current_date = today;
            }
            if let Some(f) = writer.as_mut() {
                let _ = writeln!(f, "{}", line);
            }
        }
    });
}

fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn open_append(dir: &Path, date: &str) -> Option<std::fs::File> {
    let name = format!("audit-{}.jsonl", date);
    let path = dir.join(name);
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

// ---------- 脱敏 ----------

fn regex(pat: &str) -> Regex {
    Regex::new(pat).expect("invalid audit redaction regex")
}

/// 通用脱敏 (与 audit-log.js redact 规则一致, 顺序敏感)。
pub fn redact(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    let mut out = text.to_string();

    // 1) PEM 私钥块 (含 OPENSSH/RSA/EC/DSA/ENCRYPTED 变体) 整块替换
    out = regex(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")
        .replace_all(&out, "[REDACTED:private-key]")
        .into_owned();
    // 2) OpenSSH 私钥块 (兜底: BEGIN OPENSSH PRIVATE KEY)
    out = regex(r"-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----")
        .replace_all(&out, "[REDACTED:private-key]")
        .into_owned();
    // 3) 常见敏感键值对: password=xxx / token:xxx / api_key=xxx / auth:xxx 等
    out = regex(r#"(?i)\b(password|passwd|passphrase|secret|token|api[_-]?key|auth)\b\s*[:=]\s*[^\s,;|"'<>]+"#)
        .replace_all(&out, "$1=[REDACTED]")
        .into_owned();
    // 4) JWT 形态 token
    out = regex(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
        .replace_all(&out, "[REDACTED:token]")
        .into_owned();
    // 5) 连续 65+ 字符 base64 (疑似密钥/凭据材料)
    out = regex(r"[A-Za-z0-9+/]{65,}={0,2}")
        .replace_all(&out, "[REDACTED:long-base64]")
        .into_owned();
    // 6) URI userinfo 密码段: user:password@host -> user:[REDACTED]@host (置于大块替换之后, 顺序安全)
    out = regex(r"(\w+):([^@\s/]+)@")
        .replace_all(&out, "$1:[REDACTED]@")
        .into_owned();

    out
}

/// 从 user 标识提取用户名 (username@host -> username)。
pub fn extract_username(user: &str) -> &str {
    match user.find('@') {
        Some(at) => &user[..at],
        None => user,
    }
}

/// 路径脱敏: 将路径中「等于当前用户名」的路径段替换为 [REDACTED] (用户名过短 <2 不做)。
pub fn redact_path(p: &str, user: &str) -> String {
    if p.is_empty() {
        return p.to_string();
    }
    let username = extract_username(user).trim();
    if username.len() < 2 {
        return p.to_string();
    }
    p.split('/')
        .map(|seg| if seg == username { "[REDACTED]" } else { seg })
        .collect::<Vec<_>>()
        .join("/")
}

// ---------- 条目 ----------

/// 审计条目 (前端 audit_log 传入; ts 自动生成, 忽略传入)。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// 字段白名单清洗 + 自动 ts/默认值 (对应 audit-log.js _sanitize)。
fn sanitize(entry: &AuditEntry) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();

    if let Some(v) = entry.level.as_ref() {
        if !v.is_empty() {
            out.insert("level".into(), serde_json::Value::String(v.clone()));
        }
    }
    if let Some(v) = entry.user.as_ref() {
        if !v.is_empty() {
            out.insert("user".into(), serde_json::Value::String(v.clone()));
        }
    }
    if let Some(v) = entry.session.as_ref() {
        if !v.is_empty() {
            out.insert("session".into(), serde_json::Value::String(v.clone()));
        }
    }
    if let Some(v) = entry.r#type.as_ref() {
        if !v.is_empty() {
            out.insert("type".into(), serde_json::Value::String(v.clone()));
        }
    }
    if let Some(v) = entry.target.as_ref() {
        if !v.is_empty() {
            out.insert("target".into(), serde_json::Value::String(v.clone()));
        }
    }
    if let Some(v) = entry.result.as_ref() {
        if !v.is_empty() {
            out.insert("result".into(), serde_json::Value::String(v.clone()));
        }
    }
    if let Some(v) = entry.detail.as_ref() {
        if !v.is_empty() {
            out.insert("detail".into(), serde_json::Value::String(v.clone()));
        }
    }

    out.insert("ts".into(), serde_json::Value::String(now_iso()));
    if out.get("level").is_none() {
        out.insert("level".into(), serde_json::Value::String("INFO".into()));
    }
    if out.get("type").is_none() {
        out.insert("type".into(), serde_json::Value::String("unknown".into()));
    }
    if out.get("result").is_none() {
        out.insert("result".into(), serde_json::Value::String("success".into()));
    }
    out
}

fn now_iso() -> String {
    chrono::Local::now().to_rfc3339()
}

/// 记录一条操作日志 (fire-and-forget, 异步入队, 绝无同步 IO, 写入失败静默)。
pub fn log(entry: AuditEntry) {
    let core_guard = match AUDIT.get() {
        Some(c) => c,
        None => return, // 未初始化: 静默丢弃
    };
    let core = core_guard.lock().unwrap();
    let Some(tx) = &core.tx else {
        return;
    };

    let mut clean = sanitize(&entry);
    // 脱敏: 自由文本统一过 redact; target 额外做用户名段替换。
    // 先取出 user (owned), 避免与 get_mut 的借用冲突。
    let user_for_path = clean
        .get("user")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    for key in ALLOWED_FIELDS.iter() {
        if *key == "ts" {
            continue;
        }
        let Some(v) = clean.get_mut(*key) else { continue };
        let Some(s) = v.as_str() else { continue };
        let mut r = redact(s);
        if *key == "target" {
            r = redact_path(&r, &user_for_path);
        }
        *v = serde_json::Value::String(r);
    }
    // 可选字段为空则省略。
    for key in ["user", "session", "detail"] {
        if clean.get(key).map(|v| v.as_str().unwrap_or("").is_empty()).unwrap_or(false) {
            clean.remove(key);
        }
    }
    let line = serde_json::to_string(&serde_json::Value::Object(clean)).unwrap_or_default();
    let _ = tx.send(line);
}

// ---------- 查询 ----------

/// 查询筛选条件 (audit_query)。
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQueryFilters {
    /// ISO 字符串或毫秒时间戳; 可只给其一。
    pub from: Option<serde_json::Value>,
    pub to: Option<serde_json::Value>,
    /// 用户标识子串 (不区分大小写)。
    pub user: Option<String>,
    /// 操作类型精确匹配 (逗号分隔多选)。
    pub r#type: Option<String>,
    /// success | failure。
    pub result: Option<String>,
    /// 分页大小 (默认 100, 上限 1000)。
    pub limit: Option<usize>,
    /// 偏移 (默认 0)。
    pub offset: Option<usize>,
}

/// 查询结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQueryResult {
    pub ok: bool,
    pub total: usize,
    pub items: Vec<serde_json::Value>,
}

fn parse_ts(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => {
            if let Ok(ms) = s.parse::<i64>() {
                return Some(ms);
            }
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.timestamp_millis())
        }
        _ => None,
    }
}

fn collect_log_files(dir: &Path, from_ms: Option<i64>, to_ms: Option<i64>) -> Vec<PathBuf> {
    let mut files = vec![];
    let push_if_exists = |p: &Path, files: &mut Vec<PathBuf>| {
        if p.exists() && !files.contains(&p.to_path_buf()) {
            files.push(p.to_path_buf());
        }
    };

    let today = today_str();
    if from_ms.is_none() && to_ms.is_none() {
        push_if_exists(&dir.join(format!("audit-{}.jsonl", today)), &mut files);
        return files;
    }

    let start_ms = from_ms.unwrap_or_else(|| {
        chrono::Local::now().timestamp_millis()
    });
    let end_ms = to_ms.unwrap_or_else(|| chrono::Local::now().timestamp_millis());
    // chrono TimeZone trait 需显式导入才能调用 Local::timestamp_opt;
    // LocalResult 仅有 unwrap() (会 panic), 用 match 兜底。
    use chrono::TimeZone;
    let start = match chrono::Local.timestamp_opt(start_ms / 1000, 0) {
        chrono::LocalResult::Single(dt) => dt,
        _ => chrono::Local::now(),
    }
    .date_naive();
    let end = match chrono::Local.timestamp_opt(end_ms / 1000, 0) {
        chrono::LocalResult::Single(dt) => dt,
        _ => chrono::Local::now(),
    }
    .date_naive();

    // 逐日扫描范围内文件 (上限 366 天, 防异常)。
    let mut guard = 0;
    let mut day = start;
    while day <= end && guard < 366 {
        push_if_exists(&dir.join(format!("audit-{}.jsonl", day.format("%Y-%m-%d"))), &mut files);
        day = day.succ_opt().unwrap_or(day);
        guard += 1;
    }
    // 兜底包含当前文件 (to 为今天/未来时确保包含)。
    push_if_exists(&dir.join(format!("audit-{}.jsonl", today)), &mut files);
    files
}

fn match_type(obj: &serde_json::Value, type_filter: &str) -> bool {
    if type_filter.is_empty() {
        return true;
    }
    let types: Vec<&str> = type_filter.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    let t = obj.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
    types.contains(&t)
}

fn match_entry(obj: &serde_json::Value, f: &AuditQueryFilters, from_ms: Option<i64>, to_ms: Option<i64>) -> bool {
    let ts = obj.get("ts").and_then(parse_ts);
    if let Some(from) = from_ms {
        if ts.map(|t| t < from).unwrap_or(true) {
            return false;
        }
    }
    if let Some(to) = to_ms {
        if ts.map(|t| t > to).unwrap_or(true) {
            return false;
        }
    }
    if let Some(user) = &f.user {
        if !obj
            .get("user")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_lowercase()
            .contains(&user.to_lowercase())
        {
            return false;
        }
    }
    if let Some(typ) = &f.r#type {
        if !match_type(obj, typ) {
            return false;
        }
    }
    if let Some(result) = &f.result {
        if obj.get("result").and_then(serde_json::Value::as_str).unwrap_or("") != result {
            return false;
        }
    }
    true
}

/// 查询审计日志: 读文件 -> 过滤 -> 按 ts 降序 -> 分页。
pub fn query(filters: &AuditQueryFilters) -> AuditQueryResult {
    let Some(core_guard) = AUDIT.get() else {
        return AuditQueryResult { ok: true, total: 0, items: vec![] };
    };
    let core = core_guard.lock().unwrap();

    let limit = filters.limit.unwrap_or(100).clamp(1, 1000);
    let offset = filters.offset.unwrap_or(0);
    let from_ms = filters.from.as_ref().and_then(parse_ts);
    let to_ms = filters.to.as_ref().and_then(parse_ts);

    let mut entries: Vec<serde_json::Value> = vec![];
    for file in collect_log_files(&core.dir, from_ms, to_ms) {
        let content = match std::fs::read_to_string(&file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let obj: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if !obj.is_object() {
                continue;
            }
            if match_entry(&obj, filters, from_ms, to_ms) {
                entries.push(obj);
            }
        }
    }
    // 最新在前 (字符串 ts 比较即可, ISO 8601 字典序=时间序)。
    entries.sort_by(|a, b| {
        let a = a.get("ts").and_then(serde_json::Value::as_str).unwrap_or("");
        let b = b.get("ts").and_then(serde_json::Value::as_str).unwrap_or("");
        b.cmp(a)
    });
    let total = entries.len();
    let items = if offset >= total {
        vec![]
    } else {
        entries[offset..(offset + limit).min(total)].to_vec()
    };

    AuditQueryResult { ok: true, total, items }
}
