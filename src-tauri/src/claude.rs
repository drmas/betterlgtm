use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;

use serde_json::{Value, json};
use tauri::State;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::oneshot;

use crate::config::ConfigState;
use crate::harness::{Normalizer, Run, run_agent};

/// Cancel handles for Claude runs that are still streaming, keyed by run id.
#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, oneshot::Sender<()>>>);

/// Runs the chosen agent in `cwd`, read-only, and forwards its events to the frontend in Claude
/// Code's shape (see `harness`). Pass `resume` to continue an earlier session, which is how the
/// chat stays persistent. `schema` is a JSON Schema the final answer must match and
/// `max_budget_usd` stops the run at that cost; both are Claude Code features and are left out
/// for the other agents.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn claude_run(
    runs: State<'_, Runs>,
    config: State<'_, ConfigState>,
    run_id: String,
    cwd: String,
    prompt: String,
    resume: Option<String>,
    chat: Option<bool>,
    schema: Option<String>,
    max_budget_usd: Option<f64>,
    harness: Option<String>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let config = config.get();
    let (harness, overridden) = run_agent(&config.harness, harness.as_deref());
    let name = harness.name();
    let program = config.agent_path(harness);
    // Codex reads a schema from a file. Removed when the run ends, however it ends.
    let schema_file = match (harness, overridden, schema.as_deref()) {
        (crate::harness::Harness::Codex, true, Some(s)) => {
            let path = schema_file_path(&run_id);
            std::fs::write(&path, s).map_err(|e| e.to_string())?;
            Some(TempFile(path))
        }
        _ => None,
    };
    let mut cmd = crate::process::command(&program);
    harness.arguments(
        &mut cmd,
        &Run {
            prompt: &prompt,
            // The model and effort settings belong to the configured agent; another agent runs with its own defaults.
            model: if overridden { "" } else { &config.model },
            effort: if overridden { "" } else { &config.effort },
            resume: resume.as_deref(),
            chat: chat.unwrap_or(false),
            schema: schema.as_deref(),
            max_budget_usd,
            schema_file: schema_file.as_ref().map(|f| f.0.as_path()),
        },
    );
    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start {name}: {e}. Is `{program}` installed and on PATH?"))?;
    let stdout = child.stdout.take().ok_or("No stdout from the agent")?;
    let mut stderr = child.stderr.take().ok_or("No stderr from the agent")?;
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    runs.0.lock().unwrap().insert(run_id.clone(), cancel_tx);

    let mut events = Normalizer::new(harness);
    let mut lines = BufReader::new(stdout).lines();
    let mut cancelled = false;
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) if line.trim().is_empty() => {}
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                    Ok(raw) => events.feed(raw).into_iter().for_each(|e| { let _ = on_event.send(e); }),
                    Err(_) => { let _ = on_event.send(json!({ "type": "raw", "text": line })); }
                },
                Ok(None) => break,
                Err(e) => return Err(e.to_string()),
            },
            _ = &mut cancel_rx => {
                cancelled = true;
                let _ = child.kill().await;
                break;
            }
        }
    }

    runs.0.lock().unwrap().remove(&run_id);
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = stderr_task.await.unwrap_or_default();
    if cancelled {
        return Err("Cancelled".into());
    }
    if let Some(error) = events.error.take() {
        return Err(format!("{name}: {error}"));
    }
    if !status.success() {
        // Some agents log a lot of unrelated noise before the line that matters; the end is the useful part.
        let detail: String = stderr.trim().chars().rev().take(1200).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("{name} exited with {status}: {detail}"));
    }
    events.finish().into_iter().for_each(|e| { let _ = on_event.send(e); });
    Ok(())
}

#[tauri::command]
pub fn claude_cancel(runs: State<'_, Runs>, run_id: String) {
    if let Some(tx) = runs.0.lock().unwrap().remove(&run_id) {
        let _ = tx.send(());
    }
}

/// Where a run's schema file goes. Run ids carry the PR key (`owner/repo#12`), so only letters,
/// digits and dashes are kept: the file must stay directly in the temp folder.
fn schema_file_path(run_id: &str) -> std::path::PathBuf {
    let safe: String = run_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    std::env::temp_dir().join(format!("betterlgtm-schema-{safe}.json"))
}

/// A file deleted when it goes out of scope.
struct TempFile(std::path::PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_file_for_a_pr_run_id_stays_in_the_temp_dir() {
        let path = schema_file_path("verify-owner/repo#123-1731400000000");
        assert_eq!(path.parent(), Some(std::env::temp_dir().as_path()));
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(!name.contains('/') && !name.contains('#'), "{name}");
    }
}
