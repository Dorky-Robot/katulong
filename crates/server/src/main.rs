use axum::{response::Json, routing::get, Router};
use katulong_shared::{ServerMessage, PROTOCOL_VERSION};
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "katulong_server=info,axum=info".into()),
        )
        .init();

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/hello", get(hello));

    let addr: SocketAddr = "127.0.0.1:3000".parse().expect("valid bind address");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind listener");

    tracing::info!(%addr, "katulong-server listening");
    axum::serve(listener, app).await.expect("serve");
}

async fn health() -> &'static str {
    "ok"
}

async fn hello() -> Json<ServerMessage> {
    Json(ServerMessage::Hello {
        protocol_version: PROTOCOL_VERSION.to_string(),
    })
}
