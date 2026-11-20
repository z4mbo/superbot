fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=assets/superbot.ico");
        println!("cargo:rerun-if-changed=assets/superbot.rc");
        embed_resource::compile_for("assets/superbot.rc", &["superbot-desktop"], embed_resource::NONE)
            .manifest_required()
            .expect("compile the Superbot application icon");
    }
}
