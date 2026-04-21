use katulong_shared::PROTOCOL_VERSION;
use leptos::*;

fn main() {
    console_error_panic_hook::set_once();
    mount_to_body(|| view! { <App/> });
}

#[component]
fn App() -> impl IntoView {
    view! {
        <main>
            <h1>"katulong"</h1>
            <p>"Rust + Leptos rewrite — hello world"</p>
            <p>{format!("Protocol version: {PROTOCOL_VERSION}")}</p>
        </main>
    }
}
