mod mcp_server;

use std::sync::Arc;
use tauri::Manager;
use mcp_server::McpHost;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let mcp_host = Arc::new(McpHost::new());
            let mcp_host_clone = Arc::clone(&mcp_host);

            // Start MCP server in background
            tauri::async_runtime::spawn(async move {
                log::info!("Starting MCP server...");
                match mcp_host_clone.start_server("127.0.0.1:8888").await {
                    Ok(_) => log::info!("MCP server stopped"),
                    Err(e) => log::error!("Failed to start MCP server: {}", e),
                }
            });

            // Give the server a moment to start
            std::thread::sleep(std::time::Duration::from_millis(100));
            log::info!("MCP server startup initiated");

            app.manage(mcp_host);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_status,
            register_tool,
            register_resource
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn get_server_status() -> Result<String, String> {
    Ok("MCP Server running on 127.0.0.1:8888".to_string())
}

#[tauri::command]
async fn register_tool(
    tool_name: String,
    tool_definition: serde_json::Value,
    state: tauri::State<'_, Arc<McpHost>>,
) -> Result<String, String> {
    state.register_tool(tool_name.clone(), tool_definition);
    Ok(format!("Tool '{}' registered successfully", tool_name))
}

#[tauri::command]
async fn register_resource(
    resource_name: String,
    resource_definition: serde_json::Value,
    state: tauri::State<'_, Arc<McpHost>>,
) -> Result<String, String> {
    state.register_resource(resource_name.clone(), resource_definition);
    Ok(format!("Resource '{}' registered successfully", resource_name))
}
