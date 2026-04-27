use katulong_auth::{AuthStore, WebAuthnService};
use katulong_server::session::{
    dims::{DEFAULT_COLS, DEFAULT_ROWS},
    OutputRouter, SessionManager, Tmux, DEDICATED_SOCKET_NAME,
};
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

    // Spawn the tmux control-mode subprocess once at startup. Every
    // WS session shares it: tmux itself multiplexes across sessions,
    // so one subprocess is enough. Bailing on failure is correct —
    // without tmux katulong has no terminal surface; running anyway
    // would accept WS upgrades that fail at Attach time, which is
    // worse operator UX than a startup panic pointing at the
    // missing binary.
    let socket_name = std::env::var("KATULONG_TMUX_SOCKET")
        .unwrap_or_else(|_| DEDICATED_SOCKET_NAME.to_string());
    // The "keepalive" session is internal infrastructure: its
    // only job is keeping the CM client attached to something so
    // the control channel stays alive. It is NOT a user-facing
    // tile. The env var is named accordingly so an operator
    // overriding it knows they're naming a hidden session, not
    // configuring a user terminal.
    let keepalive_session = std::env::var("KATULONG_KEEPALIVE_SESSION")
        .unwrap_or_else(|_| "__cm_keepalive".to_string());
    let (tmux, notifs) =
        Tmux::spawn(&socket_name, &keepalive_session, DEFAULT_COLS, DEFAULT_ROWS)
            .await
            .expect("spawn tmux control-mode subprocess");
    let sessions = SessionManager::new(tmux);
    let output_router = OutputRouter::new();

    // The dispatcher task drains the (unbounded per `Tmux::spawn`
    // contract) notification receiver and routes `%output`
    // events through the router's decoder + per-pane fan-out.
    // The task's non-blocking invariant lives inside
    // `OutputRouter::spawn_dispatcher` itself — documented on
    // the method and enforced by `dispatch`'s `try_send` path.
    // Letting the tokio runtime abort the task on process exit
    // is fine; we ignore the `JoinHandle`.
    let _dispatcher = output_router.spawn_dispatcher(notifs, sessions.clone());

    let state = AppState::new(auth_store, webauthn, config)
        .with_sessions(sessions)
        .with_output_router(output_router);

    // Bind port: `PORT` env (matches the Node convention, plus
    // bin/katulong-stage's port-allocation contract). Defaults
    // to 3000 for parity with the Node default.
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000);
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
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
