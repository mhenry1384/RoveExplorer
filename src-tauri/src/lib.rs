use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct WatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched: Mutex<HashSet<String>>,
}

#[derive(Serialize)]
struct Entry {
    kind: String,
    name: String,
    extension: String,
    size: String,
    modified: String,
    path: String,
}

#[derive(Serialize)]
struct Drive {
    kind: String,
    name: String,
    path: String,
    total: String,
    free: String,
    #[serde(rename = "fileSystem")]
    file_system: String,
}

fn format_size(bytes: u64) -> String {
    if bytes < 1024 { return format!("{} B", bytes); }
    if bytes < 1024 * 1024 { return format!("{:.1} KB", bytes as f64 / 1024.0); }
    if bytes < 1024 * 1024 * 1024 { return format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0)); }
    format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

fn entry_kind_rank(kind: &str) -> u8 {
    if kind == "folder" { 0 } else { 1 }
}

#[cfg(windows)]
fn is_hidden(path: &Path, name: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn GetFileAttributesW(path: *const u16) -> u32;
    }

    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let attributes = unsafe { GetFileAttributesW(wide_path.as_ptr()) };
    name.starts_with('.') || (attributes != u32::MAX && attributes & (0x2 | 0x4) != 0)
}

#[cfg(not(windows))]
fn is_hidden(_path: &Path, name: &str) -> bool {
    name.starts_with('.')
}

#[cfg(windows)]
fn drive_details(letter: char) -> Option<Drive> {
    use std::os::windows::ffi::OsStrExt;
    extern "system" {
        fn GetDiskFreeSpaceExW(directory: *const u16, available: *mut u64, total: *mut u64, free: *mut u64) -> i32;
        fn GetVolumeInformationW(root: *const u16, name: *mut u16, name_len: u32, serial: *mut u32, max_component: *mut u32, flags: *mut u32, filesystem: *mut u16, filesystem_len: u32) -> i32;
    }

    let path = format!("{}:\\", letter);
    let wide_path: Vec<u16> = std::ffi::OsStr::new(&path).encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    let mut total = 0;
    let mut free = 0;
    if unsafe { GetDiskFreeSpaceExW(wide_path.as_ptr(), &mut available, &mut total, &mut free) } == 0 { return None; }
    let mut filesystem = [0u16; 32];
    let mut volume_name = [0u16; 256];
    let mut serial = 0;
    let mut max_component = 0;
    let mut flags = 0;
    let file_system = if unsafe { GetVolumeInformationW(wide_path.as_ptr(), volume_name.as_mut_ptr(), volume_name.len() as u32, &mut serial, &mut max_component, &mut flags, filesystem.as_mut_ptr(), filesystem.len() as u32) } != 0 {
        String::from_utf16_lossy(&filesystem[..filesystem.iter().position(|value| *value == 0).unwrap_or(filesystem.len())])
    } else { "—".to_string() };
    Some(Drive { kind: "drive".to_string(), name: format!("{}:", letter), path, total: format_size(total), free: format_size(free), file_system })
}

#[cfg(windows)]
#[tauri::command]
fn list_drives() -> Vec<Drive> {
    (b'A'..=b'Z').filter_map(|letter| drive_details(letter as char)).collect()
}

#[cfg(not(windows))]
#[tauri::command]
fn list_drives() -> Vec<Drive> {
    Vec::new()
}

#[tauri::command]
fn read_directory(path: String, show_hidden: bool) -> Result<Vec<Entry>, String> {
    let mut entries = fs::read_dir(&path).map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|item| {
            let metadata = item.metadata().ok()?;
            let name = item.file_name().to_string_lossy().to_string();
            if !show_hidden && is_hidden(&item.path(), &name) { return None; }
            let is_dir = metadata.is_dir();
            let extension = if is_dir { "—".to_string() } else {
                Path::new(&name).extension().map(|value| format!(".{}", value.to_string_lossy())).unwrap_or_else(|| "—".to_string())
            };
            Some(Entry {
                kind: if is_dir { "folder" } else { "file" }.to_string(),
                name,
                extension,
                size: if is_dir { "—".to_string() } else { format_size(metadata.len()) },
                modified: metadata.modified().ok().and_then(|date| date.duration_since(std::time::UNIX_EPOCH).ok()).map(|date| date.as_secs().to_string()).unwrap_or_else(|| "—".to_string()),
                path: item.path().to_string_lossy().to_string(),
            })
        }).collect::<Vec<_>>();
    entries.sort_by(|left, right| entry_kind_rank(&left.kind).cmp(&entry_kind_rank(&right.kind)).then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase())));
    Ok(entries)
}

#[tauri::command]
fn rename_entry(path: String, new_name: String) -> Result<(), String> {
    if new_name.is_empty() || new_name == "." || new_name == ".." || new_name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("Invalid folder name".to_string());
    }
    let source = Path::new(&path);
    let target = source.parent().ok_or_else(|| "Invalid folder path".to_string())?.join(new_name);
    fs::rename(source, target).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_watched_paths(app: AppHandle, state: State<WatcherState>, paths: Vec<String>) -> Result<(), String> {
    let mut watcher_guard = state.watcher.lock().map_err(|_| "watcher lock poisoned".to_string())?;
    if watcher_guard.is_none() {
        let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if matches!(event.kind, notify::EventKind::Access(_)) { return; }
            let mut parents: Vec<String> = event.paths.iter()
                .filter_map(|changed| changed.parent())
                .map(|parent| parent.to_string_lossy().to_string())
                .collect();
            parents.dedup();
            for parent in parents {
                let _ = app.emit("fs-changed", parent);
            }
        }).map_err(|error| error.to_string())?;
        *watcher_guard = Some(watcher);
    }
    let watcher = watcher_guard.as_mut().unwrap();
    let mut watched = state.watched.lock().map_err(|_| "watched lock poisoned".to_string())?;
    let desired: HashSet<String> = paths.into_iter().collect();
    for old in watched.iter() {
        if !desired.contains(old) {
            let _ = watcher.unwatch(Path::new(old));
        }
    }
    for new in desired.iter() {
        if !watched.contains(new) {
            let _ = watcher.watch(Path::new(new), RecursiveMode::NonRecursive);
        }
    }
    *watched = desired;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![read_directory, rename_entry, delete_entry, list_drives, set_watched_paths])
        .run(tauri::generate_context!())
        .expect("error while running Rove");
}
