// The shell's whole life: start the local server as a child process (the
// user's own node or bun — the app ships no runtime), wait for it to answer,
// point the window at it, and take it down when the shell exits.
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant};
use tauri::Manager;

/// Where the server lives inside the built app bundle:
/// Contents/MacOS/server/{dist,node_modules}. In dev it is the repo itself.
fn server_root(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        app.path().resource_dir().expect("no resource dir").join("server")
    } else {
        let exe = std::env::current_exe().expect("no exe path");
        // Contents/MacOS/find-my-voice -> Contents/MacOS/server
        exe.parent().expect("no exe parent").join("server")
    }
}

/// A free localhost port for the server; the shell owns the choice so two
/// installs never fight over the configured one.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("cannot bind a local port")
        .local_addr()
        .expect("no local addr")
        .port()
}

struct ServerChild(Child);

impl Drop for ServerChild {
    fn drop(&mut self) {
        // The shell is going away; the server never outlives it.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The managed server slot: `Drop` of the whole shell state takes the
/// child down; `Mutex` only because Tauri state must be Sync.
#[derive(Default)]
struct ServerSlot(std::sync::Mutex<Option<ServerChild>>);

/// The user's own runtime; the app ships none. node first, bun as fallback.
fn runtime() -> Option<&'static str> {
    ["node", "bun"].iter().copied().find(|which| {
        std::env::var_os("PATH")
            .map(|path| {
                std::env::split_paths(&path).any(|dir| dir.join(which).exists())
            })
            .unwrap_or(false)
    })
}

fn start_server(root: &PathBuf, port: u16) -> Option<ServerChild> {
    let which = runtime()?;
    // The server keeps its npm layout inside the bundle: dist/server/index.js
    // with dist/web beside it, so its own packageRoot resolves correctly.
    let entry = root.join("dist").join("server").join("index.js");
    if !entry.exists() {
        eprintln!("server entry missing: {}", entry.display());
        return None;
    }
    let child = Command::new(which)
        .arg(entry)
        .arg("--no-open")
        .env("FIND_MY_VOICE_HOME", std::env::var("FIND_MY_VOICE_HOME").unwrap_or_else(|_| {
            // Each install keeps its data beside the app, never inside it.
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            format!("{home}/.find-my-voice")
        }))
        .env("FMV_PORT", port.to_string())
        .current_dir(root)
        .spawn()
        .ok()?;
    Some(ServerChild(child))
}

/// Poll until the server answers or the patience runs out.
fn wait_healthy(port: u16) -> bool {
    let deadline = Instant::now() + Duration::from_secs(30);
    let url = format!("http://127.0.0.1:{port}/api/status");
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            let _ = ureq::get(&url).call();
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .setup(|app| {
            // In dev the beforeDevCommand already runs server + Vite, and the
            // window starts on devUrl — no sidecar to spawn, nothing to navigate.
            if cfg!(debug_assertions) {
                return Ok(());
            }
            let handle = app.handle().clone();
            let root = server_root(&handle);
            let port = free_port();
            // The child goes straight into the managed slot; dropping it here
            // would kill it (ServerChild::drop kills the process).
            let child = start_server(&root, port);
            let started = child.is_some();
            app.manage(ServerSlot::default());
            if let Some(state) = app.try_state::<ServerSlot>() {
                *state.0.lock().unwrap() = child;
            }
            std::thread::spawn(move || {
                let ok = started && wait_healthy(port);
                let url = format!("http://127.0.0.1:{port}");
                if !ok {
                    eprintln!("server did not answer on {url}");
                }
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.navigate(url.parse().expect("valid url"));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the find-my-voice shell");
}
