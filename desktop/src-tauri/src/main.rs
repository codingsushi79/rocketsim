// RocketSim desktop shell: the game is the web build (web/dist), shown in the system
// WebView (Edge WebView2 on Windows). All physics runs in the bundled WebAssembly core.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to start RocketSim");
}
