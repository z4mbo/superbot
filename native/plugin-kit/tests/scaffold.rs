use std::{fs, path::Path, process::Command};

use serde_json::Value;

fn plugin(dir: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_superbot-plugin"));
    command.current_dir(dir);
    command
}

fn init_app(dir: &Path) {
    let output = plugin(dir)
        .args(["init", "temperature-tool", "--template", "mcp-app"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn binary_scaffolds_and_validates_mcp_app() {
    let dir = tempfile::tempdir().unwrap();
    let example: Value = serde_json::from_str(include_str!(
        "../../../examples/plugins/marketplace-unit-converter/manifest.json"
    ))
    .unwrap();
    init_app(dir.path());
    assert!(plugin(dir.path())
        .arg("validate")
        .status()
        .unwrap()
        .success());
    let manifest: Value =
        serde_json::from_slice(&fs::read(dir.path().join("plugin.json")).unwrap()).unwrap();
    assert_eq!(manifest, example);
    assert!(dir.path().join("server.ts").is_file());
    assert!(dir.path().join("README.md").is_file());
}

#[test]
fn binary_scaffolds_the_record_app_byte_for_byte_and_validates_edits() {
    let dir = tempfile::tempdir().unwrap();
    let output = plugin(dir.path())
        .args(["init", "kcal-diary", "--template", "kcal-diary"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let path = dir.path().join("plugin.json");
    assert_eq!(
        fs::read(&path).unwrap(),
        include_bytes!("../../../examples/plugins/kcal-diary/plugin.json")
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    let validate = plugin(dir.path()).arg("validate").output().unwrap();
    assert!(validate.status.success());
    assert_eq!(
        String::from_utf8_lossy(&validate.stdout).trim(),
        "Manifest is valid"
    );

    let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["parts"][0]["summaryField"] = Value::from("meal");
    fs::write(&path, manifest.to_string()).unwrap();
    let refused = plugin(dir.path()).arg("validate").output().unwrap();
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("parts[0].summaryField"));
}

#[test]
fn binary_scaffolds_app_beside_custom_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir(&project).unwrap();
    let output = plugin(dir.path())
        .args([
            "init",
            "temperature-tool",
            "--template",
            "mcp-app",
            "--name",
            "Temperature tool",
            "--manifest",
            "project/custom.json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let manifest: Value =
        serde_json::from_slice(&fs::read(project.join("custom.json")).unwrap()).unwrap();
    assert_eq!(manifest["name"], "Temperature tool");
    assert!(project.join("server.ts").is_file());
    assert!(project.join("README.md").is_file());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn binary_preserves_existing_files_when_scaffolding_fails() {
    let dir = tempfile::tempdir().unwrap();
    let readme = dir.path().join("README.md");
    fs::write(&readme, "Current project instructions").unwrap();
    let output = plugin(dir.path())
        .args(["init", "temperature-tool", "--template", "mcp-app"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(
        fs::read_to_string(&readme).unwrap(),
        "Current project instructions"
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn binary_keeps_skill_default_and_custom_manifest_path() {
    let dir = tempfile::tempdir().unwrap();
    let output = plugin(dir.path())
        .args(["init", "release-notes", "--manifest", "skill.json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    let manifest: Value =
        serde_json::from_slice(&fs::read(dir.path().join("skill.json")).unwrap()).unwrap();
    assert_eq!(manifest["name"], "release notes");
    assert_eq!(manifest["parts"][0]["kind"], "skill");
}

#[test]
#[ignore = "requires Node.js 24"]
fn binary_mcp_app_calculates_over_loopback() {
    let dir = tempfile::tempdir().unwrap();
    init_app(dir.path());
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            include_str!("mcp-smoke.mjs"),
        ])
        .current_dir(dir.path())
        .output()
        .expect("Node.js 24 is required for the MCP smoke test");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
