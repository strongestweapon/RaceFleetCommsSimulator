use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};
use tauri::{Manager, Window};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;

const MAX_RECORD_BYTES: u64 = 5_000_000;

#[tauri::command]
async fn save_record(window: Window, filename: String, contents: String) -> Result<(), String> {
    let selected = window
        .app_handle()
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("탐색 기록 저장")
        .set_file_name(filename)
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(());
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    store_record(&path, contents.as_bytes()).map_err(|error| format!("기록 저장 실패 · {error}"))
}

fn store_record(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let folder = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    let mut pending = NamedTempFile::new_in(folder)?;
    pending.write_all(contents)?;
    pending.persist(path)?;
    Ok(())
}

#[tauri::command]
async fn open_record(window: Window) -> Result<Option<String>, String> {
    let selected = window
        .app_handle()
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("탐색 조건 불러오기")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    let mut contents = Vec::new();
    File::open(path)
        .and_then(|file| file.take(MAX_RECORD_BYTES + 1).read_to_end(&mut contents))
        .map_err(|error| format!("기록 열기 실패 · {error}"))?;
    if contents.len() > MAX_RECORD_BYTES as usize {
        return Err("5MB 이하 기록을 선택해 주세요.".into());
    }
    String::from_utf8(contents)
        .map(Some)
        .map_err(|_| "UTF-8 JSON 기록을 선택해 주세요.".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_record, open_record])
        .run(tauri::generate_context!())
        .expect("경기정 통신 시뮬레이터를 시작할 수 없습니다");
}
