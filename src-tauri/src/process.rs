use std::path::Path;
#[cfg(unix)]
use std::sync::OnceLock;
use tokio::process::Command;

/// Environment changes every external tool gets.
///
/// Inside an AppImage, AppRun points `LD_LIBRARY_PATH`, `PATH`, `XDG_DATA_DIRS` and friends at the
/// mounted bundle. System tools that inherit them load the bundle's libraries and crash, so drop
/// every path entry under `$APPDIR`. `None` means remove the variable.
fn env_fixes() -> Vec<(String, Option<String>)> {
    let Some(appdir) = std::env::var("APPDIR").ok().filter(|d| !d.is_empty()) else {
        return Vec::new();
    };
    std::env::vars()
        .filter(|(_, value)| value.contains(&appdir))
        .map(|(key, value)| {
            let kept: Vec<&str> = value.split(':').filter(|p| !p.is_empty() && !p.starts_with(&appdir)).collect();
            (key, (!kept.is_empty()).then(|| kept.join(":")))
        })
        .collect()
}

/// The PATH to find `gh`, `claude` and `git` on.
///
/// Apps opened from the Dock, Finder, Spotlight or a desktop launcher don't start from a shell, so
/// they get a bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) without Homebrew, npm or Claude Code's
/// folders. Ask the user's login shell for its PATH, then add the usual install folders in case
/// the shell setup lives somewhere a login shell doesn't read.
#[cfg(unix)]
pub fn tool_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<String> = Vec::new();
        let mut add = |dir: &str| {
            if !dir.is_empty() && !dirs.iter().any(|d| d == dir) {
                dirs.push(dir.to_string());
            }
        };
        if let Some(path) = shell_path() {
            path.split(':').for_each(&mut add);
        }
        let fixes = env_fixes();
        let current = match fixes.iter().find(|(k, _)| k == "PATH") {
            Some((_, fixed)) => fixed.clone(),
            None => std::env::var("PATH").ok(),
        };
        if let Some(path) = current {
            path.split(':').for_each(&mut add);
        }
        if let Ok(home) = std::env::var("HOME") {
            for dir in [".local/bin", ".claude/local", ".npm-global/bin", ".local/share/mise/shims", ".volta/bin", ".bun/bin"] {
                add(&format!("{home}/{dir}"));
            }
        }
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            add(dir);
        }
        dirs.join(":")
    })
}

/// `$PATH` as the user's interactive login shell sets it, or `None` if that fails or takes over 3 s.
#[cfg(unix)]
fn shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    const MARK: &str = "__BETTERLGTM_PATH__";
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    // fish keeps PATH as a list, so join it the way other shells store it.
    let script = if shell.ends_with("fish") {
        format!("printf '{MARK}%s{MARK}' (string join : $PATH)")
    } else {
        format!("printf '{MARK}%s{MARK}' \"$PATH\"")
    };
    let mut cmd = std::process::Command::new(&shell);
    cmd.args(["-i", "-l", "-c", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // From the home folder, so project-specific shell setup (mise, direnv, …) in whatever folder
    // the app was started from doesn't change or break the result.
    if let Some(home) = home_dir() {
        cmd.current_dir(home);
    }
    for (key, value) in env_fixes() {
        match value {
            Some(v) => cmd.env(key, v),
            None => cmd.env_remove(key),
        };
    }
    let mut child = cmd.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(3) => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    out.split(MARK).nth(1).filter(|p| !p.is_empty()).map(str::to_string)
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(Into::into)
}

/// A command for an external tool (`git`, `gh`, `claude`), with a usable PATH and environment.
pub fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    for (key, value) in env_fixes() {
        match value {
            Some(v) => cmd.env(key, v),
            None => cmd.env_remove(key),
        };
    }
    #[cfg(unix)]
    cmd.env("PATH", tool_path());
    // The release build has no console of its own, so without this Windows opens one for every
    // console program the app starts, and it flashes on screen.
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where a tool's command resolves to: the file itself when given as a path, otherwise the first
/// match on the PATH the tools run with. `None` when nothing is found.
pub fn resolve(program: &str) -> Option<String> {
    let given = Path::new(program);
    if given.components().count() > 1 {
        return given.is_file().then(|| program.to_string());
    }
    #[cfg(unix)]
    let (path, exts) = (tool_path().to_string(), vec![String::new()]);
    #[cfg(not(unix))]
    let (path, exts) = (
        std::env::var("PATH").unwrap_or_default(),
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into()).split(';').map(str::to_string).chain([String::new()]).collect::<Vec<_>>(),
    );
    std::env::split_paths(&path)
        .flat_map(|dir| exts.iter().map(move |ext| dir.join(format!("{program}{ext}"))))
        .find(|candidate| candidate.is_file())
        .map(|found| found.to_string_lossy().into_owned())
}

/// Runs a program to completion and returns its stdout, or an error that includes stderr.
pub async fn run(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut cmd = command(program);
    cmd.args(args);
    // Commands that don't need a folder run from home, not from wherever the app was started,
    // so version-manager shims don't pick up an unrelated project's config.
    if let Some(dir) = cwd.map(Path::to_path_buf).or_else(home_dir) {
        cmd.current_dir(dir);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Could not run `{program}`: {e}. Is it installed and on PATH?"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("`{program} {}` failed: {}", args.join(" "), stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn tool_path_finds_user_folders() {
        let path = super::tool_path();
        println!("PATH={path}");
        assert!(path.split(':').any(|d| d == "/usr/bin"));
    }
}
