use codex_plus_core::user_scripts::UserScriptManager;
use serde_json::{Value, json};
use std::fs;

#[test]
fn production_manager_does_not_load_retired_packages_or_change_their_files() {
    let temp = tempfile::tempdir().unwrap();
    let builtin = temp.path().join("bundled_extensions");
    let user = temp.path().join("user_scripts");
    for directory in [&builtin, &user] {
        let package = directory.join("agent-pet");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("codexpp.json"),
            json!({"id":"agent-pet","renderer":"main.js"}).to_string(),
        )
        .unwrap();
        fs::write(
            package.join("main.js"),
            "window.retiredPackageLoaded = true;",
        )
        .unwrap();
    }
    let config = temp.path().join("user_scripts.json");
    let original = json!({"enabled":false,"skip_next_start":true,"scripts":{"bundled:agent-pet":true,"user:agent-pet":true}}).to_string();
    fs::write(&config, &original).unwrap();
    let manager = UserScriptManager::new(&builtin, &user, &config).with_builtins_only();
    let inventory = manager.inventory().unwrap();
    assert!(inventory["scripts"].as_array().unwrap().is_empty());
    assert!(!inventory["builtins"].as_array().unwrap().is_empty());
    assert!(manager.load_config().enabled);
    assert!(!manager.load_config().skip_next_start);
    for bundle in [
        manager.build_initial_bundle().unwrap(),
        manager.build_reload_bundle().unwrap(),
    ] {
        assert!(bundle.contains("__codexPlusBuiltinExtensionState"));
        assert!(!bundle.contains("retiredPackageLoaded"));
        assert!(!bundle.contains("runtime.prepareReload"));
        assert!(!bundle.contains("runtime.registerCleanup"));
    }
    assert!(
        manager
            .set_script_enabled("bundled:agent-pet", true)
            .is_err()
    );
    assert!(manager.set_script_enabled("user:agent-pet", true).is_err());
    assert!(
        manager
            .set_extension_config("bundled:agent-pet", &serde_json::Map::new())
            .is_err()
    );
    assert_eq!(fs::read_to_string(config).unwrap(), original);
    assert_eq!(
        fs::read_to_string(builtin.join("agent-pet/main.js")).unwrap(),
        "window.retiredPackageLoaded = true;"
    );
    let settings: Value = serde_json::from_str(&original).unwrap();
    assert!(settings["scripts"]["bundled:agent-pet"].as_bool().unwrap());
}

#[test]
fn production_inventory_does_not_create_a_user_script_directory() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("missing");
    let manager = UserScriptManager::new(
        temp.path().join("bundled"),
        &directory,
        temp.path().join("scripts.json"),
    )
    .with_builtins_only();
    assert!(
        manager.inventory().unwrap()["scripts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(!directory.exists());
}
