//! The coding agents the app can run a review with, and what differs between them: the command
//! line, how a session is resumed, and the JSON each one streams. Every stream is turned into the
//! events Claude Code emits, which is what the frontend reads:
//!
//! - `{"type":"system","subtype":"init","session_id":…}` when the session starts,
//! - `{"type":"assistant","message":{"content":[{"type":"text",…} | {"type":"tool_use","name":…,"input":…}]}}`,
//! - `{"type":"result","session_id":…,"result":…,"usage":…}` at the end.

use serde_json::{Value, json};
use tokio::process::Command;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Harness {
    Claude,
    Codex,
    Gemini,
    Copilot,
}

/// Claude Code's tools. Everything else is denied in print mode, so the session is read-only.
const CLAUDE_TOOLS: &[&str] = &[
    "Read",
    "Grep",
    "Glob",
    "LS",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git diff:*)",
    "Bash(git blame:*)",
    "Bash(git merge-base:*)",
    "Bash(rg:*)",
];

/// Copilot CLI's tools. Only these are offered to the model, so no MCP server or editing tool is
/// there to call; `bash` runs only the allowed commands and ones Copilot deems read-only, and
/// files only inside the worktree, since a prompt run denies everything that would ask.
const COPILOT_TOOLS: &[&str] = &["view", "grep", "glob", "bash"];
const COPILOT_ALLOWED: &[&str] = &["shell(git log)", "shell(git show)", "shell(git diff)", "shell(git blame)", "shell(git merge-base)", "shell(rg)"];
const COPILOT_DENIED: &[&str] = &["write", "memory", "url"];
/// Settings from the environment that would approve what the lists above leave to be denied.
const COPILOT_UNSAFE_ENV: &[&str] = &["COPILOT_ALLOW_ALL", "COPILOT_ASSISTED_APPROVAL"];

/// Added to chat runs only: answers are read in a narrow side panel by someone mid-review.
/// Analyses, drafts and other runs describe their own output in the prompt.
const CHAT_STYLE: &str = "You are helping someone review a pull request inside a desktop app. \
Answer briefly: lead with the answer, then at most 5 short bullet points. \
No preamble, no recap, no headings. Use `inline code` for identifiers and file:line for locations.";

/// What one run needs, whichever agent runs it.
pub struct Run<'a> {
    pub prompt: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    /// A session id as this module handed it out (see `tag`), to continue that session.
    pub resume: Option<&'a str>,
    pub chat: bool,
    /// JSON Schema for the final answer. Only Claude Code enforces it; the others get the shape
    /// from the prompt, and the frontend reads the JSON out of their text.
    pub schema: Option<&'a str>,
    pub max_budget_usd: Option<f64>,
    /// The same schema written to a file, for Codex's --output-schema. Set only when Codex double-checks
    /// for another agent, so Codex's own reviews behave as before.
    pub schema_file: Option<&'a std::path::Path>,
}

/// The agent for one run: the configured one, or a different agent asked for just this run (such as a
/// double-check by another agent). The flag says the override is in effect.
pub fn run_agent(configured: &str, override_id: Option<&str>) -> (Harness, bool) {
    let base = Harness::from_id(configured);
    match override_id.map(Harness::from_id) {
        Some(h) if h != base => (h, true),
        _ => (base, false),
    }
}

impl Harness {
    pub const ALL: [Harness; 4] = [Harness::Claude, Harness::Codex, Harness::Gemini, Harness::Copilot];

    pub fn from_id(id: &str) -> Harness {
        match id.trim() {
            "codex" => Harness::Codex,
            "gemini" => Harness::Gemini,
            "copilot" => Harness::Copilot,
            _ => Harness::Claude,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
            Harness::Codex => "codex",
            Harness::Gemini => "gemini",
            Harness::Copilot => "copilot",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Harness::Claude => "Claude Code",
            Harness::Codex => "Codex",
            Harness::Gemini => "Gemini CLI",
            Harness::Copilot => "Copilot CLI",
        }
    }

    /// The command when the user hasn't set a path.
    pub fn command(self) -> &'static str {
        self.id()
    }

    /// A session id marked with the agent it belongs to, so a session started with one agent is
    /// never resumed with another. Claude Code's stay bare: those are the ids saved before the
    /// app could run anything else.
    fn tag(self, id: &str) -> String {
        match self {
            Harness::Claude => id.to_string(),
            other => format!("{}:{id}", other.id()),
        }
    }

    /// The agent's own session id from a tagged one, or `None` when it belongs to another agent.
    fn own_session(self, tagged: &str) -> Option<&str> {
        let other = Harness::ALL.iter().find(|h| **h != Harness::Claude && tagged.starts_with(&format!("{}:", h.id())));
        match (self, other) {
            (Harness::Claude, None) => Some(tagged),
            (me, Some(owner)) if me == *owner => tagged.split_once(':').map(|(_, id)| id),
            _ => None,
        }
    }

    /// Adds this agent's arguments for a read-only, non-interactive run that streams JSON.
    pub fn arguments(self, cmd: &mut Command, run: &Run) {
        let resume = run.resume.and_then(|id| self.own_session(id));
        let model = run.model.trim();
        let effort = run.effort.trim();
        // Only Claude Code takes a system prompt; the others get the chat style ahead of the question.
        let prompt = if run.chat && self != Harness::Claude { format!("{CHAT_STYLE}\n\n{}", run.prompt) } else { run.prompt.to_string() };
        match self {
            Harness::Claude => {
                if !model.is_empty() {
                    cmd.args(["--model", model]);
                }
                if !effort.is_empty() {
                    cmd.args(["--effort", effort]);
                }
                cmd.arg("-p")
                    .arg(&prompt)
                    .args(["--output-format", "stream-json", "--verbose"])
                    .arg("--allowedTools")
                    .args(CLAUDE_TOOLS)
                    .args(["--disallowedTools", "Edit", "Write", "NotebookEdit"]);
                if run.chat {
                    cmd.args(["--append-system-prompt", CHAT_STYLE]);
                }
                if let Some(schema) = run.schema.filter(|s| !s.trim().is_empty()) {
                    cmd.args(["--json-schema", schema]);
                }
                if let Some(budget) = run.max_budget_usd.filter(|b| *b > 0.0) {
                    cmd.args(["--max-budget-usd", &format!("{budget:.2}")]);
                }
                if let Some(id) = resume {
                    cmd.args(["--resume", id]);
                }
            }
            Harness::Codex => {
                cmd.arg("exec");
                if resume.is_some() {
                    cmd.arg("resume");
                }
                // The sandbox is what makes the run read-only: commands can read the worktree and nothing can write.
                // Set as config because `exec resume` has no --sandbox option.
                cmd.args(["--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"read-only\""]);
                if let Some(file) = run.schema_file {
                    cmd.arg("--output-schema").arg(file);
                }
                if !model.is_empty() {
                    cmd.args(["--model", model]);
                }
                if !effort.is_empty() {
                    // Codex has no "max"; its highest level is xhigh.
                    let level = if effort == "max" { "xhigh" } else { effort };
                    cmd.args(["-c", &format!("model_reasoning_effort=\"{level}\"")]);
                }
                if let Some(id) = resume {
                    cmd.arg(id);
                }
                cmd.arg(&prompt);
            }
            Harness::Gemini => {
                // Plan mode is Gemini CLI's read-only mode.
                cmd.args(["-p", &prompt, "--output-format", "stream-json", "--approval-mode", "plan", "--skip-trust"]);
                if !model.is_empty() {
                    cmd.args(["--model", model]);
                }
                if let Some(id) = resume {
                    cmd.args(["--resume", id]);
                }
            }
            Harness::Copilot => {
                // `=` keeps the prompt from being read as one more tool name after the lists.
                for key in COPILOT_UNSAFE_ENV {
                    cmd.env_remove(key);
                }
                cmd.arg(format!("--prompt={prompt}"))
                    .args(["--output-format", "json", "--no-ask-user", "--disable-builtin-mcps", "--disallow-temp-dir"])
                    .arg("--available-tools")
                    .args(COPILOT_TOOLS)
                    .arg("--allow-tool")
                    .args(COPILOT_ALLOWED)
                    .arg("--deny-tool")
                    .args(COPILOT_DENIED);
                if !model.is_empty() {
                    cmd.args(["--model", model]);
                }
                if !effort.is_empty() {
                    cmd.args(["--reasoning-effort", effort]);
                }
                if let Some(id) = resume {
                    cmd.arg(format!("--resume={id}"));
                }
            }
        }
    }
}

fn text_event(text: &str) -> Value {
    json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": text }] } })
}

fn tool_event(name: &str, input: Value) -> Value {
    json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "name": name, "input": input }] } })
}

/// Codex runs commands as `/usr/bin/bash -lc '<command>'`; show the command itself.
fn shell_command(raw: &str) -> &str {
    let inner = raw.split_once(" -lc ").map(|(_, rest)| rest).unwrap_or(raw).trim();
    inner.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')).or_else(|| inner.strip_prefix('"').and_then(|s| s.strip_suffix('"'))).unwrap_or(inner)
}

/// Turns one agent's stream into Claude Code's events.
pub struct Normalizer {
    harness: Harness,
    session: Option<String>,
    /// The last complete message from the agent: its answer, once the run ends.
    answer: String,
    /// Gemini CLI streams a message in pieces; they collect here until it's complete.
    partial: String,
    finished: bool,
    /// Copilot CLI reports tokens in checkpoints along the way; the last one counts.
    usage: Value,
    /// What the agent said went wrong, which is clearer than its stderr.
    pub error: Option<String>,
}

impl Normalizer {
    pub fn new(harness: Harness) -> Self {
        Self { harness, session: None, answer: String::new(), partial: String::new(), finished: false, usage: json!({}), error: None }
    }

    /// The events to forward for one line of the agent's output.
    pub fn feed(&mut self, raw: Value) -> Vec<Value> {
        match self.harness {
            Harness::Claude => vec![raw],
            Harness::Codex => self.codex(&raw),
            Harness::Gemini => self.gemini(&raw),
            Harness::Copilot => self.copilot(&raw),
        }
    }

    /// Events still owed when the stream ends: an agent that stopped without a closing event still gets a result.
    pub fn finish(&mut self) -> Vec<Value> {
        if self.harness == Harness::Claude || self.finished || self.error.is_some() {
            return Vec::new();
        }
        let mut out = self.flush();
        if !self.answer.is_empty() {
            let usage = self.usage.clone();
            out.push(self.result(usage));
        }
        out
    }

    fn init(&mut self, id: &str) -> Value {
        let tagged = self.harness.tag(id);
        self.session = Some(tagged.clone());
        json!({ "type": "system", "subtype": "init", "session_id": tagged })
    }

    fn result(&mut self, usage: Value) -> Value {
        self.finished = true;
        json!({ "type": "result", "subtype": "success", "is_error": false, "session_id": self.session, "result": self.answer, "usage": usage })
    }

    /// Ends the message being streamed, if any, and forwards it whole.
    fn flush(&mut self) -> Vec<Value> {
        let text = std::mem::take(&mut self.partial);
        if text.trim().is_empty() {
            return Vec::new();
        }
        self.answer = text.trim().to_string();
        vec![text_event(&self.answer)]
    }

    fn codex(&mut self, e: &Value) -> Vec<Value> {
        let kind = e["type"].as_str().unwrap_or("");
        let item = &e["item"];
        match (kind, item["type"].as_str().unwrap_or("")) {
            ("thread.started", _) => e["thread_id"].as_str().map(|id| vec![self.init(id)]).unwrap_or_default(),
            ("item.completed", "agent_message") => {
                let text = item["text"].as_str().unwrap_or("").trim();
                if text.is_empty() {
                    return Vec::new();
                }
                self.answer = text.to_string();
                vec![text_event(text)]
            }
            ("item.started", "command_execution") => vec![tool_event("Bash", json!({ "command": shell_command(item["command"].as_str().unwrap_or("")) }))],
            ("item.started", "web_search") => vec![tool_event("WebSearch", json!({ "query": item["query"] }))],
            ("item.started", "mcp_tool_call") => vec![tool_event(item["tool"].as_str().unwrap_or("Tool"), json!({}))],
            ("turn.completed", _) => {
                let usage = &e["usage"];
                let cached = usage["cached_input_tokens"].as_u64().unwrap_or(0);
                let input = usage["input_tokens"].as_u64().unwrap_or(0);
                vec![self.result(json!({
                    // Codex counts cached tokens inside input tokens; Claude Code reports them apart.
                    "input_tokens": input.saturating_sub(cached),
                    "cache_read_input_tokens": cached,
                    "output_tokens": usage["output_tokens"].as_u64().unwrap_or(0),
                }))]
            }
            ("turn.failed", _) => {
                self.error = Some(e["error"]["message"].as_str().unwrap_or("The run failed.").to_string());
                Vec::new()
            }
            ("error", _) => {
                self.error = Some(e["message"].as_str().unwrap_or("The run failed.").to_string());
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn gemini(&mut self, e: &Value) -> Vec<Value> {
        match e["type"].as_str().unwrap_or("") {
            "init" => e["session_id"].as_str().map(|id| vec![self.init(id)]).unwrap_or_default(),
            "message" if e["role"].as_str() == Some("assistant") => {
                let text = e["content"].as_str().unwrap_or("");
                if e["delta"].as_bool().unwrap_or(false) {
                    self.partial.push_str(text);
                    return Vec::new();
                }
                let mut out = self.flush();
                self.partial.push_str(text);
                out.extend(self.flush());
                out
            }
            "tool_use" => {
                let mut out = self.flush();
                let params = e["parameters"].clone();
                let name = e["tool_name"].as_str().unwrap_or("Tool");
                // Named as Claude Code names them, so the progress lines read the same.
                out.push(match name {
                    "read_file" | "read_many_files" => tool_event("Read", json!({ "file_path": params["file_path"].as_str().or(params["absolute_path"].as_str()).or(params["path"].as_str()) })),
                    "search_file_content" | "grep" | "grep_search" => tool_event("Grep", json!({ "pattern": params["pattern"] })),
                    "glob" | "list_directory" => tool_event("Glob", json!({ "pattern": params["pattern"].as_str().or(params["path"].as_str()).or(params["dir_path"].as_str()) })),
                    "run_shell_command" => tool_event("Bash", json!({ "command": params["command"] })),
                    other => tool_event(other, params),
                });
                out
            }
            "error" => {
                self.error = Some(e["message"].as_str().or(e["error"].as_str()).unwrap_or("The run failed.").to_string());
                Vec::new()
            }
            "result" => {
                let mut out = self.flush();
                if e["status"].as_str().is_some_and(|s| s != "success") {
                    self.error = Some(e["error"]["message"].as_str().or(e["error"].as_str()).unwrap_or("The run failed.").to_string());
                    return out;
                }
                let stats = &e["stats"];
                let cached = stats["cached"].as_u64().unwrap_or(0);
                out.push(self.result(json!({
                    "input_tokens": stats["input_tokens"].as_u64().unwrap_or(0).saturating_sub(cached),
                    "cache_read_input_tokens": cached,
                    "output_tokens": stats["output_tokens"].as_u64().unwrap_or(0),
                })));
                out
            }
            _ => Vec::new(),
        }
    }

    fn copilot(&mut self, e: &Value) -> Vec<Value> {
        let data = &e["data"];
        match e["type"].as_str().unwrap_or("") {
            "session.start" => data["sessionId"].as_str().map(|id| vec![self.init(id)]).unwrap_or_default(),
            "assistant.message" => {
                let text = data["content"].as_str().unwrap_or("").trim();
                if text.is_empty() {
                    return Vec::new();
                }
                self.answer = text.to_string();
                vec![text_event(text)]
            }
            "tool.execution_start" => {
                let args = &data["arguments"];
                // Named as Claude Code names them, so the progress lines read the same.
                vec![match data["toolName"].as_str().unwrap_or("Tool") {
                    "view" => tool_event("Read", json!({ "file_path": args["path"] })),
                    "grep" => tool_event("Grep", json!({ "pattern": args["pattern"] })),
                    "glob" => tool_event("Glob", json!({ "pattern": args["pattern"] })),
                    "bash" => tool_event("Bash", json!({ "command": args["command"] })),
                    other => tool_event(other, args.clone()),
                }]
            }
            "session.usage_checkpoint" => {
                let (mut input, mut output, mut read, mut write) = (0, 0, 0, 0);
                for m in data["providerModelMetrics"].as_array().into_iter().flatten() {
                    let u = &m["metrics"]["usage"];
                    let n = |k: &str| u[k].as_u64().unwrap_or(0);
                    input += n("inputTokens");
                    output += n("outputTokens");
                    read += n("cacheReadTokens");
                    write += n("cacheWriteTokens");
                }
                // Input tokens include cached ones; Claude Code reports those apart.
                self.usage = json!({
                    "input_tokens": input.saturating_sub(read + write),
                    "cache_read_input_tokens": read,
                    "cache_creation_input_tokens": write,
                    "output_tokens": output,
                });
                Vec::new()
            }
            "session.error" => {
                self.error = Some(data["message"].as_str().unwrap_or("The run failed.").to_string());
                Vec::new()
            }
            "result" => {
                // A resumed session announces no id until here.
                if self.session.is_none()
                    && let Some(id) = e["sessionId"].as_str()
                {
                    self.session = Some(self.harness.tag(id));
                }
                if e["exitCode"].as_i64().is_some_and(|c| c != 0) {
                    self.error.get_or_insert_with(|| "The run failed.".to_string());
                    return Vec::new();
                }
                let usage = self.usage.clone();
                vec![self.result(usage)]
            }
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(harness: Harness, lines: &[&str]) -> (Vec<Value>, Normalizer) {
        let mut n = Normalizer::new(harness);
        let mut out = Vec::new();
        for line in lines {
            out.extend(n.feed(serde_json::from_str(line).unwrap()));
        }
        out.extend(n.finish());
        (out, n)
    }

    #[test]
    fn codex_stream_becomes_claude_events() {
        // Recorded from codex-cli 0.166.0.
        let (out, _) = feed_all(
            Harness::Codex,
            &[
                r#"{"type":"thread.started","thread_id":"01a1c265"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll check the latest commit.\n"}}"#,
                r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/bash -lc 'git log --oneline -1 .'","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#,
                r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/bash -lc 'git log --oneline -1 .'","aggregated_output":"0c6d54b x\n","exit_code":0,"status":"completed"}}"#,
                r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Point the website at 0.4.3"}}"#,
                r#"{"type":"turn.completed","usage":{"input_tokens":50285,"cached_input_tokens":38400,"cache_write_input_tokens":0,"output_tokens":89,"reasoning_output_tokens":0}}"#,
            ],
        );
        assert_eq!(out.len(), 5);
        assert_eq!(out[0]["session_id"], "codex:01a1c265");
        assert_eq!(out[2]["message"]["content"][0]["name"], "Bash");
        assert_eq!(out[2]["message"]["content"][0]["input"]["command"], "git log --oneline -1 .");
        let result = &out[4];
        assert_eq!(result["type"], "result");
        assert_eq!(result["result"], "Point the website at 0.4.3");
        assert_eq!(result["session_id"], "codex:01a1c265");
        assert_eq!(result["usage"]["input_tokens"], 11885);
        assert_eq!(result["usage"]["cache_read_input_tokens"], 38400);
    }

    #[test]
    fn codex_failure_is_reported() {
        let (out, n) = feed_all(Harness::Codex, &[r#"{"type":"thread.started","thread_id":"t"}"#, r#"{"type":"turn.failed","error":{"message":"usage limit reached"}}"#]);
        assert_eq!(out.len(), 1);
        assert_eq!(n.error.as_deref(), Some("usage limit reached"));
    }

    #[test]
    fn gemini_pieces_are_joined() {
        let (out, _) = feed_all(
            Harness::Gemini,
            &[
                r#"{"type":"init","session_id":"s1","model":"gemini"}"#,
                r#"{"type":"message","role":"user","content":"hi"}"#,
                r#"{"type":"message","role":"assistant","content":"Looking ","delta":true}"#,
                r#"{"type":"message","role":"assistant","content":"now.","delta":true}"#,
                r#"{"type":"tool_use","tool_name":"read_file","tool_id":"1","parameters":{"file_path":"a.rs"}}"#,
                r#"{"type":"message","role":"assistant","content":"Done.","delta":true}"#,
                r#"{"type":"result","status":"success","stats":{"input_tokens":100,"output_tokens":5,"cached":40}}"#,
            ],
        );
        assert_eq!(out[1]["message"]["content"][0]["text"], "Looking now.");
        assert_eq!(out[2]["message"]["content"][0]["name"], "Read");
        assert_eq!(out[3]["message"]["content"][0]["text"], "Done.");
        assert_eq!(out[4]["result"], "Done.");
        assert_eq!(out[4]["session_id"], "gemini:s1");
        assert_eq!(out[4]["usage"]["input_tokens"], 60);
    }

    #[test]
    fn copilot_stream_becomes_claude_events() {
        // Recorded from Copilot CLI 1.0.109, trimmed to the fields read.
        let (out, n) = feed_all(
            Harness::Copilot,
            &[
                r#"{"type":"session.start","data":{"sessionId":"3764643a","selectedModel":"claude-opus-5.5"}}"#,
                r#"{"type":"assistant.message_delta","data":{"messageId":"m0","deltaContent":"Di"},"ephemeral":true}"#,
                r#"{"type":"assistant.message","data":{"messageId":"m0","content":"","toolRequests":[{"name":"bash","arguments":{"command":"git log -1"}}]}}"#,
                r#"{"type":"tool.execution_start","data":{"toolName":"bash","arguments":{"command":"git --no-pager log -1","description":"Show latest commit"}}}"#,
                r#"{"type":"tool.execution_start","data":{"toolName":"view","arguments":{"path":"/repo/docs/HOMEBREW.md"}}}"#,
                r#"{"type":"assistant.message","data":{"messageId":"m1","content":"Points the docs at 0.5.1.","toolRequests":[]}}"#,
                r#"{"type":"session.usage_checkpoint","data":{"providerModelMetrics":[{"metrics":{"usage":{"inputTokens":27726,"outputTokens":1365,"cacheReadTokens":21755,"cacheWriteTokens":5963}}}]}}"#,
                r#"{"type":"result","sessionId":"3764643a","exitCode":0,"usage":{"premiumRequests":15}}"#,
            ],
        );
        assert_eq!(out.len(), 5);
        assert_eq!(out[0]["session_id"], "copilot:3764643a");
        assert_eq!(out[1]["message"]["content"][0]["input"]["command"], "git --no-pager log -1");
        assert_eq!(out[2]["message"]["content"][0]["name"], "Read");
        assert_eq!(out[2]["message"]["content"][0]["input"]["file_path"], "/repo/docs/HOMEBREW.md");
        let result = &out[4];
        assert_eq!(result["result"], "Points the docs at 0.5.1.");
        assert_eq!(result["session_id"], "copilot:3764643a");
        assert_eq!(result["usage"]["input_tokens"], 8);
        assert_eq!(result["usage"]["cache_read_input_tokens"], 21755);
        assert!(n.error.is_none());
    }

    #[test]
    fn copilot_run_cannot_be_widened_from_the_environment() {
        let mut cmd = Command::new("copilot");
        cmd.env("COPILOT_ALLOW_ALL", "true");
        Harness::Copilot.arguments(&mut cmd, &Run { prompt: "p", model: "", effort: "", resume: None, chat: false, schema: None, max_budget_usd: None, schema_file: None });
        let removed: Vec<_> = cmd.as_std().get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        assert!(removed.contains(&"COPILOT_ALLOW_ALL".to_string()));
        assert!(removed.contains(&"COPILOT_ASSISTED_APPROVAL".to_string()));
    }

    #[test]
    fn copilot_resume_and_failure() {
        // A resumed session only names itself in the result.
        let (out, _) = feed_all(Harness::Copilot, &[r#"{"type":"assistant.message","data":{"content":"ok"}}"#, r#"{"type":"result","sessionId":"abc","exitCode":0}"#]);
        assert_eq!(out[1]["session_id"], "copilot:abc");
        let (out, n) = feed_all(
            Harness::Copilot,
            &[
                r#"{"type":"session.start","data":{"sessionId":"s"}}"#,
                r#"{"type":"session.error","data":{"errorType":"query","message":"Execution failed: Model \"x\" is not available."}}"#,
                r#"{"type":"result","sessionId":"s","exitCode":1}"#,
            ],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(n.error.as_deref(), Some("Execution failed: Model \"x\" is not available."));
    }

    #[test]
    fn sessions_stay_with_their_agent() {
        assert_eq!(Harness::Claude.own_session("abc"), Some("abc"));
        assert_eq!(Harness::Claude.own_session("codex:abc"), None);
        assert_eq!(Harness::Codex.own_session("codex:abc"), Some("abc"));
        assert_eq!(Harness::Codex.own_session("abc"), None);
        assert_eq!(Harness::Gemini.own_session("codex:abc"), None);
    }

    #[test]
    fn shell_wrapper_is_removed() {
        assert_eq!(shell_command("/usr/bin/bash -lc 'git diff a...b'"), "git diff a...b");
        assert_eq!(shell_command("git status"), "git status");
    }

    #[test]
    fn run_agent_uses_the_configured_agent_without_an_override() {
        assert_eq!(run_agent("claude", None), (Harness::Claude, false));
    }

    #[test]
    fn run_agent_takes_a_different_override() {
        assert_eq!(run_agent("claude", Some("codex")), (Harness::Codex, true));
    }

    #[test]
    fn run_agent_ignores_an_override_that_matches_the_configured_agent() {
        assert_eq!(run_agent("codex", Some("codex")), (Harness::Codex, false));
    }

    fn codex_args(schema_file: Option<&std::path::Path>) -> Vec<String> {
        let mut cmd = Command::new("codex");
        Harness::Codex.arguments(&mut cmd, &Run { prompt: "p", model: "", effort: "", resume: None, chat: false, schema: None, max_budget_usd: None, schema_file });
        cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn codex_gets_output_schema_when_a_schema_file_is_given() {
        let args = codex_args(Some(std::path::Path::new("/tmp/s.json")));
        let at = args.iter().position(|a| a == "--output-schema").expect("--output-schema missing");
        assert_eq!(args[at + 1], "/tmp/s.json");
    }

    #[test]
    fn codex_has_no_output_schema_without_a_schema_file() {
        assert!(!codex_args(None).iter().any(|a| a == "--output-schema"));
    }
}
