// Standalone test for MCP server
use std::sync::Arc;

// Copy the MCP server code for testing
mod mcp_server {
    use anyhow::Result;
    use dashmap::DashMap;
    use futures_util::{SinkExt, StreamExt};
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use std::sync::Arc;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::mpsc;
    use tokio_tungstenite::{accept_async, tungstenite::Message};
    use uuid::Uuid;

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct McpRequest {
        pub id: Option<Value>,
        pub method: String,
        pub params: Option<Value>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct McpResponse {
        pub id: Option<Value>,
        pub result: Option<Value>,
        pub error: Option<McpError>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct McpError {
        pub code: i32,
        pub message: String,
        pub data: Option<Value>,
    }

    type ClientId = String;

    pub struct McpHost {
        clients: Arc<DashMap<ClientId, mpsc::UnboundedSender<Message>>>,
        tools: Arc<DashMap<String, Value>>,
        resources: Arc<DashMap<String, Value>>,
    }

    impl McpHost {
        pub fn new() -> Self {
            Self {
                clients: Arc::new(DashMap::new()),
                tools: Arc::new(DashMap::new()),
                resources: Arc::new(DashMap::new()),
            }
        }

        pub async fn start_server(&self, address: &str) -> Result<()> {
            let listener = TcpListener::bind(address).await?;
            println!("MCP Server listening on: {}", address);

            while let Ok((stream, addr)) = listener.accept().await {
                println!("New connection from: {}", addr);
                let clients = Arc::clone(&self.clients);
                let tools = Arc::clone(&self.tools);
                let resources = Arc::clone(&self.resources);

                tokio::spawn(async move {
                    if let Err(e) = Self::handle_connection(stream, clients, tools, resources).await {
                        eprintln!("Error handling connection: {}", e);
                    }
                });
            }

            Ok(())
        }

        async fn handle_connection(
            stream: TcpStream,
            clients: Arc<DashMap<ClientId, mpsc::UnboundedSender<Message>>>,
            tools: Arc<DashMap<String, Value>>,
            resources: Arc<DashMap<String, Value>>,
        ) -> Result<()> {
            let ws_stream = accept_async(stream).await?;
            let (mut ws_sender, mut ws_receiver) = ws_stream.split();
            let client_id = Uuid::new_v4().to_string();

            let (tx, mut rx) = mpsc::unbounded_channel();
            clients.insert(client_id.clone(), tx);

            tokio::spawn(async move {
                while let Some(message) = rx.recv().await {
                    if ws_sender.send(message).await.is_err() {
                        break;
                    }
                }
            });

            while let Some(msg) = ws_receiver.next().await {
                match msg? {
                    Message::Text(text) => {
                        println!("Received: {}", text);
                        if let Ok(request) = serde_json::from_str::<McpRequest>(&text) {
                            let response = Self::handle_mcp_request(&request, &tools, &resources).await;
                            let response_text = serde_json::to_string(&response)?;
                            if let Some(client_tx) = clients.get(&client_id) {
                                let _ = client_tx.send(Message::Text(response_text));
                            }
                        }
                    }
                    Message::Close(_) => {
                        println!("Client {} disconnected", client_id);
                        clients.remove(&client_id);
                        break;
                    }
                    _ => {}
                }
            }

            Ok(())
        }

        async fn handle_mcp_request(
            request: &McpRequest,
            tools: &DashMap<String, Value>,
            resources: &DashMap<String, Value>,
        ) -> McpResponse {
            println!("Handling request: {}", request.method);
            
            match request.method.as_str() {
                "initialize" => {
                    let result = serde_json::json!({
                        "protocolVersion": "2024-11-05",
                        "serverInfo": {
                            "name": "katulong-mcp-host",
                            "version": "0.1.0"
                        },
                        "capabilities": {
                            "tools": {
                                "listChanged": true
                            },
                            "resources": {
                                "listChanged": true
                            }
                        }
                    });
                    McpResponse {
                        id: request.id.clone(),
                        result: Some(result),
                        error: None,
                    }
                }
                "tools/list" => {
                    let tool_list: Vec<Value> = tools.iter().map(|entry| entry.value().clone()).collect();
                    let result = serde_json::json!({
                        "tools": tool_list
                    });
                    McpResponse {
                        id: request.id.clone(),
                        result: Some(result),
                        error: None,
                    }
                }
                _ => McpResponse {
                    id: request.id.clone(),
                    result: None,
                    error: Some(McpError {
                        code: -32601,
                        message: format!("Method not found: {}", request.method),
                        data: None,
                    }),
                },
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🤖 Testing Katulong MCP Server Standalone");
    
    let mcp_host = mcp_server::McpHost::new();
    
    println!("Starting server on 127.0.0.1:8888...");
    mcp_host.start_server("127.0.0.1:8888").await?;
    
    Ok(())
}