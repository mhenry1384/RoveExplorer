use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct WatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched: Mutex<HashSet<String>>,
}

#[derive(Default)]
struct TreeState {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Default)]
struct IconCacheState {
    cache: Mutex<HashMap<String, Option<String>>>,
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

#[derive(Serialize, Clone)]
struct FolderNode {
    name: String,
    path: String,
    #[serde(rename = "fileCount")]
    file_count: u64,
    #[serde(rename = "totalSize")]
    total_size: u64,
    children: Vec<FolderNode>,
}

#[derive(Serialize, Clone)]
struct TreeProgress {
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "scannedFiles")]
    scanned_files: u64,
    #[serde(rename = "scannedFolders")]
    scanned_folders: u64,
}

#[derive(Serialize, Clone)]
struct TreeDone {
    #[serde(rename = "requestId")]
    request_id: String,
    tree: FolderNode,
}

#[derive(Serialize, Clone)]
struct TreeCancelled {
    #[serde(rename = "requestId")]
    request_id: String,
}

fn walk_folder(
    path: &Path,
    cancel: &AtomicBool,
    scanned_files: &mut u64,
    scanned_folders: &mut u64,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Option<FolderNode> {
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let mut file_count = 0u64;
    let mut total_size = 0u64;
    let mut children = Vec::new();
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.filter_map(Result::ok) {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let metadata = match entry.metadata() {
                Ok(value) => value,
                Err(_) => continue,
            };
            if metadata.is_dir() {
                let child = walk_folder(&entry.path(), cancel, scanned_files, scanned_folders, on_progress)?;
                file_count += child.file_count;
                total_size += child.total_size;
                *scanned_folders += 1;
                on_progress(*scanned_files, *scanned_folders);
                children.push(child);
            } else {
                file_count += 1;
                total_size += metadata.len();
                *scanned_files += 1;
                on_progress(*scanned_files, *scanned_folders);
            }
        }
    }
    children.sort_by(|left, right| right.total_size.cmp(&left.total_size));
    Some(FolderNode { name, path: path.to_string_lossy().to_string(), file_count, total_size, children })
}

#[tauri::command]
fn compute_tree_stats(app: AppHandle, state: State<TreeState>, request_id: String, path: String) -> Result<(), String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .map_err(|_| "tree state lock poisoned".to_string())?
        .insert(request_id.clone(), cancel_flag.clone());

    std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let mut scanned_files = 0u64;
            let mut scanned_folders = 0u64;
            let mut last_emit = Instant::now();
            let result = walk_folder(Path::new(&path), &cancel_flag, &mut scanned_files, &mut scanned_folders, &mut |files, folders| {
                if last_emit.elapsed().as_millis() >= 100 {
                    let _ = app.emit("tree-progress", TreeProgress { request_id: request_id.clone(), scanned_files: files, scanned_folders: folders });
                    last_emit = Instant::now();
                }
            });
            match result {
                Some(tree) => {
                    let _ = app.emit("tree-done", TreeDone { request_id: request_id.clone(), tree });
                }
                None => {
                    let _ = app.emit("tree-cancelled", TreeCancelled { request_id: request_id.clone() });
                }
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn cancel_tree_stats(state: State<TreeState>, request_id: String) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().map_err(|_| "tree state lock poisoned".to_string())?.get(&request_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(CHARS[(b0 >> 2) as usize] as char);
        out.push(CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { CHARS[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[(b2 & 0x3f) as usize] as char } else { '=' });
    }
    out
}

// Extracts the small (16x16) shell icon associated with a file extension - the same icon
// Windows Explorer shows in its details view - by asking the shell for the icon it would use
// for a hypothetical file with that extension (SHGFI_USEFILEATTRIBUTES, no real file needed),
// then compositing that HICON onto a 32bpp DIB section via DrawIconEx so both old-style
// mask-based icons and modern per-pixel-alpha icons come out with correct transparency.
#[cfg(windows)]
fn extract_extension_icon_rgba(extension: &str) -> Option<(u32, u32, Vec<u8>)> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    const SHGFI_ICON: u32 = 0x100;
    const SHGFI_SMALLICON: u32 = 0x1;
    const SHGFI_USEFILEATTRIBUTES: u32 = 0x10;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const DIB_RGB_COLORS: u32 = 0;
    const DI_NORMAL: u32 = 0x3;
    const BI_RGB: u32 = 0;
    const ICON_SIZE: i32 = 16;

    #[repr(C)]
    struct ShFileInfoW {
        h_icon: isize,
        i_icon: i32,
        dw_attributes: u32,
        sz_display_name: [u16; 260],
        sz_type_name: [u16; 80],
    }
    #[repr(C)]
    struct BitmapInfoHeader {
        bi_size: u32,
        bi_width: i32,
        bi_height: i32,
        bi_planes: u16,
        bi_bit_count: u16,
        bi_compression: u32,
        bi_size_image: u32,
        bi_x_pels_per_meter: i32,
        bi_y_pels_per_meter: i32,
        bi_clr_used: u32,
        bi_clr_important: u32,
    }
    #[repr(C)]
    struct BitmapInfo {
        header: BitmapInfoHeader,
        colors: [u32; 1],
    }

    extern "system" {
        fn SHGetFileInfoW(path: *const u16, attrs: u32, info: *mut ShFileInfoW, size: u32, flags: u32) -> isize;
        fn DestroyIcon(icon: isize) -> i32;
        fn CreateCompatibleDC(hdc: isize) -> isize;
        fn DeleteDC(hdc: isize) -> i32;
        fn CreateDIBSection(hdc: isize, info: *const BitmapInfo, usage: u32, bits: *mut *mut u8, section: isize, offset: u32) -> isize;
        fn SelectObject(hdc: isize, obj: isize) -> isize;
        fn DeleteObject(obj: isize) -> i32;
        fn DrawIconEx(hdc: isize, x: i32, y: i32, icon: isize, width: i32, height: i32, frame: u32, flicker_brush: isize, flags: u32) -> i32;
    }

    let dummy_name = format!("dummy{}", extension);
    let wide: Vec<u16> = OsStr::new(&dummy_name).encode_wide().chain(Some(0)).collect();

    let mut info = ShFileInfoW { h_icon: 0, i_icon: 0, dw_attributes: 0, sz_display_name: [0; 260], sz_type_name: [0; 80] };
    let result = unsafe {
        SHGetFileInfoW(wide.as_ptr(), FILE_ATTRIBUTE_NORMAL, &mut info, std::mem::size_of::<ShFileInfoW>() as u32, SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES)
    };
    if result == 0 || info.h_icon == 0 {
        return None;
    }

    let hdc = unsafe { CreateCompatibleDC(0) };
    if hdc == 0 {
        unsafe { DestroyIcon(info.h_icon) };
        return None;
    }

    let bitmap_info = BitmapInfo {
        header: BitmapInfoHeader {
            bi_size: std::mem::size_of::<BitmapInfoHeader>() as u32,
            bi_width: ICON_SIZE,
            bi_height: -ICON_SIZE,
            bi_planes: 1,
            bi_bit_count: 32,
            bi_compression: BI_RGB,
            bi_size_image: 0,
            bi_x_pels_per_meter: 0,
            bi_y_pels_per_meter: 0,
            bi_clr_used: 0,
            bi_clr_important: 0,
        },
        colors: [0],
    };

    let mut bits_ptr: *mut u8 = std::ptr::null_mut();
    let bitmap = unsafe { CreateDIBSection(hdc, &bitmap_info, DIB_RGB_COLORS, &mut bits_ptr, 0, 0) };
    if bitmap == 0 || bits_ptr.is_null() {
        unsafe {
            DeleteDC(hdc);
            DestroyIcon(info.h_icon);
        }
        return None;
    }

    let buffer_len = (ICON_SIZE * ICON_SIZE * 4) as usize;
    let previous = unsafe { SelectObject(hdc, bitmap) };
    unsafe {
        std::ptr::write_bytes(bits_ptr, 0, buffer_len);
        DrawIconEx(hdc, 0, 0, info.h_icon, ICON_SIZE, ICON_SIZE, 0, 0, DI_NORMAL);
    }

    let mut rgba = vec![0u8; buffer_len];
    unsafe { std::ptr::copy_nonoverlapping(bits_ptr, rgba.as_mut_ptr(), buffer_len) };
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2); // BGRA -> RGBA
    }

    unsafe {
        SelectObject(hdc, previous);
        DeleteObject(bitmap);
        DeleteDC(hdc);
        DestroyIcon(info.h_icon);
    }

    Some((ICON_SIZE as u32, ICON_SIZE as u32, rgba))
}

#[cfg(windows)]
#[tauri::command]
fn get_extension_icon(state: State<IconCacheState>, extension: String) -> Option<String> {
    let key = extension.to_lowercase();
    if let Ok(cache) = state.cache.lock() {
        if let Some(cached) = cache.get(&key) {
            return cached.clone();
        }
    }
    let result = extract_extension_icon_rgba(&key).and_then(|(width, height, rgba)| {
        let image = image::RgbaImage::from_raw(width, height, rgba)?;
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .ok()?;
        Some(format!("data:image/png;base64,{}", base64_encode(&bytes)))
    });
    if let Ok(mut cache) = state.cache.lock() {
        cache.insert(key, result.clone());
    }
    result
}

#[cfg(not(windows))]
#[tauri::command]
fn get_extension_icon(_state: State<IconCacheState>, _extension: String) -> Option<String> {
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(WatcherState::default())
        .manage(TreeState::default())
        .manage(IconCacheState::default())
        .invoke_handler(tauri::generate_handler![read_directory, rename_entry, delete_entry, list_drives, set_watched_paths, compute_tree_stats, cancel_tree_stats, get_extension_icon])
        .run(tauri::generate_context!())
        .expect("error while running Rove");
}
