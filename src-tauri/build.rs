fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&["save_record", "open_record"]);
    let attributes = tauri_build::Attributes::new().app_manifest(manifest);
    tauri_build::try_build(attributes).expect("could not prepare the desktop bundle");
}
