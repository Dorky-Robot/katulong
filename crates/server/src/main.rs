use katulong_auth::{AuthStore, WebAuthnService};
use katulong_server::{app, state::AppState, state::ServerConfig};
use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "katulong_server=info,axum=info".into()),
        )
        .init();

    let config = load_config_from_env();
    let auth_store = AuthStore::open(&config_data_file())
        .await
        .expect("open auth store");
    let webauthn = WebAuthnService::new(&config.rp_id, &config.rp_name, &config.public_origin)
        .expect("build WebAuthn service");
    let state = AppState::new(auth_store, webauthn, config);

    let addr: SocketAddr = "127.0.0.1:3000".parse().expect("valid bind address");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind listener");
    tracing::info!(%addr, "katulong-server listening");

    // `into_make_service_with_connect_info` is required so the auth
    // middleware can read the peer socket address (needed to
    // distinguish localhost from remote, see `access.rs`). Without it
    // `ConnectInfo::<SocketAddr>` panics at request time.
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("serve");
}

fn load_config_from_env() -> ServerConfig {
    let public_origin =
        std::env::var("KATULONG_ORIGIN").unwrap_or_else(|_| "http://localhost:3000".into());
    let rp_id = std::env::var("KATULONG_RP_ID").unwrap_or_else(|_| "localhost".into());
    let rp_name = std::env::var("KATULONG_RP_NAME").unwrap_or_else(|_| "Katulong".into());
    // Secure cookies only make sense when the public origin is https.
    // Flipping this for loopback deployments so dev-over-http still works.
    let cookie_secure = public_origin.starts_with("https://");
    ServerConfig {
        public_origin,
        rp_id,
        rp_name,
        cookie_secure,
    }
}

fn config_data_file() -> PathBuf {
    // Default to `~/.config/katulong/auth.json` — matches Node's
    // `KATULONG_DATA_DIR` convention so a migrated install points at
    // the same file. Override via `KATULONG_DATA_DIR` for test rigs.
    let data_dir = std::env::var_os("KATULONG_DATA_DIR").map_or_else(
        || {
            let home = std::env::var("HOME").expect("HOME must be set");
            PathBuf::from(home).join(".config").join("katulong")
        },
        PathBuf::from,
    );
    data_dir.join("auth.json")
}
