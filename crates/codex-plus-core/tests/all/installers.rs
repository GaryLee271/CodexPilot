use codex_plus_core::install::{
    APP_BINARY, APP_BUNDLE_ID, InstallOptions, MANAGER_BINARY, MANAGER_BUNDLE_ID, SILENT_BINARY,
    SILENT_BUNDLE_ID, app_bundle_names, build_macos_app_bundle, build_windows_entrypoint_plan,
    companion_binary_path_from_exe, default_install_root_strategy,
    macos_companion_bundle_identifier_from_exe, shortcut_names,
};
use std::path::{Path, PathBuf};

#[test]
fn windows_entrypoint_plan_has_one_gui_executable_and_shortcut() {
    let options = InstallOptions {
        install_root: Some("C:/Users/A/Desktop".into()),
        launcher_path: Some("C:/Tools/codex-pilot.exe".into()),
        manager_path: Some("C:/Tools/codex-pilot-manager.exe".into()),
        remove_owned_data: false,
    };
    let plan = build_windows_entrypoint_plan(&options);
    assert!(plan.silent_shortcut.ends_with("Codex Pilot.lnk"));
    assert_eq!(plan.silent_shortcut, plan.manager_shortcut);
    assert_eq!(plan.launcher_path, "C:/Tools/codex-pilot.exe");
    assert_eq!(plan.launcher_path, plan.manager_path);
    assert_eq!(plan.silent_icon_path, plan.manager_icon_path);
    assert_eq!(plan.uninstall_key, "CodexPilot");
    assert_eq!(plan.legacy_uninstall_key, "Codex Pilot");
    assert_eq!(
        plan.uninstaller_path.replace('\\', "/"),
        "C:/Tools/uninstall.exe"
    );
    assert_eq!(
        plan.uninstall_command.replace('\\', "/"),
        "\"C:/Tools/uninstall.exe\""
    );
    assert_eq!(
        plan.quiet_uninstall_command.replace('\\', "/"),
        "\"C:/Tools/uninstall.exe\" /S"
    );
}

#[test]
fn windows_entrypoint_plan_keeps_owned_data_removal_option() {
    let options = InstallOptions {
        remove_owned_data: true,
        ..InstallOptions::default()
    };
    let plan = build_windows_entrypoint_plan(&options);
    assert!(plan.remove_owned_data);
    assert_eq!(plan.silent_shortcut, plan.manager_shortcut);
    assert_eq!(plan.launcher_path, plan.manager_path);
}

#[test]
fn macos_bundle_metadata_has_one_native_gui_app_with_url_protocols() {
    let options = InstallOptions {
        install_root: Some("/Applications".into()),
        launcher_path: Some("/opt/Codex Pilot.app/Contents/MacOS/CodexPilot".into()),
        manager_path: Some("/opt/old-manager".into()),
        remove_owned_data: false,
    };
    let app = build_macos_app_bundle(&options, false);
    assert_eq!(app, build_macos_app_bundle(&options, true));
    assert!(app.app_path.ends_with("Codex Pilot.app"));
    assert!(app.info_plist.contains("<string>Codex Pilot</string>"));
    assert!(
        app.info_plist
            .contains("<key>CodexPlusUnifiedApp</key>\n  <true/>")
    );
    assert!(
        app.info_plist
            .contains("<string>com.garylee271.codexpilot</string>")
    );
    assert!(!app.info_plist.contains("<string>dreamskin</string>"));
    assert!(app.info_plist.contains("<string>codexpilot</string>"));
    assert!(
        app.info_plist
            .contains("<key>LSUIElement</key>\n  <false/>")
    );
    assert_eq!(app.binary_target_name.as_deref(), Some("CodexPilot"));
    assert!(app.launch_script.is_empty());
    assert_eq!(app.binary_source, options.launcher_path);
}

#[test]
fn installer_name_helpers_and_legacy_constants_keep_api_compatibility() {
    assert_eq!(shortcut_names(), ("Codex Pilot.lnk", "Codex Pilot.lnk"));
    assert_eq!(app_bundle_names(), ("Codex Pilot.app", "Codex Pilot.app"));
    assert_eq!(SILENT_BINARY, APP_BINARY);
    assert_eq!(SILENT_BUNDLE_ID, APP_BUNDLE_ID);
    assert_eq!(MANAGER_BINARY, "codex-pilot-manager");
    assert_eq!(MANAGER_BUNDLE_ID, "com.garylee271.codexpilot.manager");
}

#[test]
fn windows_workflows_verify_nsis_and_support_both_program_files_directories() {
    for workflow in ["pr-build.yml", "release-assets.yml"] {
        let text = std::fs::read_to_string(format!("../../.github/workflows/{workflow}"))
            .unwrap()
            .replace("\r\n", "\n");
        let install = text
            .split_once("      - name: Install NSIS\n")
            .unwrap()
            .1
            .split("      - name:")
            .next()
            .unwrap();
        let build = text
            .split_once("      - name: Build Windows installer\n")
            .unwrap()
            .1
            .split("      - name:")
            .next()
            .unwrap();
        for step in [install, build] {
            assert!(step.contains("shell: pwsh"), "{workflow}");
            assert!(
                step.contains(r"${env:ProgramFiles(x86)}\NSIS\makensis.exe"),
                "{workflow}"
            );
            assert!(
                step.contains(r"$env:ProgramFiles\NSIS\makensis.exe"),
                "{workflow}"
            );
            assert!(step.contains("Get-Command makensis.exe"), "{workflow}");
            assert!(
                step.contains("Test-Path -LiteralPath $_ -PathType Leaf"),
                "{workflow}"
            );
            assert!(step.contains("if (-not $makensis) {"), "{workflow}");
        }
        assert!(install.contains("& $makensis /VERSION"), "{workflow}");
        assert!(
            install.contains("if ($LASTEXITCODE -eq 0) { break }"),
            "{workflow}"
        );
        assert!(install.contains("$attempt -le 3"), "{workflow}");
        assert!(
            build.contains("if ($LASTEXITCODE -ne 0) { throw"),
            "{workflow}"
        );
        assert!(build.contains("} finally {"), "{workflow}");
    }
}

#[test]
fn windows_installer_writes_the_same_uninstall_key_as_the_runtime() {
    let nsi = std::fs::read_to_string("../../scripts/installer/windows/CodexPilot.nsi").unwrap();
    assert!(nsi.contains(r"Uninstall\CodexPilot"));
    assert!(nsi.contains(
        r#"DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexPilot""#
    ));
    assert!(nsi.contains(
        r#"DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Pilot""#
    ));
    assert!(!nsi.contains(
        r#"WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Pilot""#
    ));
}

#[test]
fn windows_installer_migrates_existing_shortcuts_without_reviving_deleted_ones() {
    let nsi = std::fs::read_to_string("../../scripts/installer/windows/CodexPilot.nsi").unwrap();
    let lf = nsi.replace("\r\n", "\n");
    for text in [&lf, &lf.replace('\n', "\r\n")] {
        let text = text.replace("\r\n", "\n");
        for key in ["CodexPilot", "Codex Pilot"] {
            let read = format!(
                r#"ReadRegStr $ExistingInstall HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{key}" "InstallLocation""#
            );
            assert!(text.find(&read).unwrap() < text.find("CreateShortcut").unwrap());
        }
        assert!(text.contains("StrCmp $ExistingInstall \"\" desktop_entry_create 0"));
        assert!(text.contains("StrCmp $HadDesktopEntry 1 desktop_entry_create desktop_entry_done"));
        assert!(
            text.contains(r#"IfFileExists "$DESKTOP\Codex Pilot 管理工具.lnk" desktop_entry_found 0"#)
        );
        assert!(
            text.contains(
                r#"CreateShortcut "$DESKTOP\Codex Pilot.lnk" "$INSTDIR\codex-pilot.exe""#
            )
        );
        assert!(text.contains(r#"CreateShortcut "$SMPROGRAMS\Codex Pilot\Codex Pilot.lnk""#));
        assert!(!text.contains(r#"CreateShortcut "$DESKTOP\Codex Pilot 管理工具.lnk""#));
        assert!(!text.contains(r#"File "${ROOT}\dist\windows\app\codex-pilot-manager.exe""#));
    }
}

#[test]
fn windows_installer_waits_for_normal_exit_and_cancels_without_writing_apps() {
    let nsi = std::fs::read_to_string("../../scripts/installer/windows/CodexPilot.nsi")
        .unwrap()
        .replace("\r\n", "\n");
    assert!(!nsi.contains("taskkill"));
    assert!(nsi.contains("IntCmp $2 20 wait_prompt 0 wait_prompt"));
    assert!(nsi.contains("MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION"));
    assert!(nsi.contains("IDRETRY wait_retry IDCANCEL wait_cancel"));
    assert!(nsi.contains("wait_cancel:\n    Abort"));
    for (name, wait) in [
        ("Install", "Call WaitForProcessExit"),
        ("Uninstall", "Call un.WaitForProcessExit"),
    ] {
        let section = nsi
            .split_once(&format!("Section \"{name}\""))
            .unwrap()
            .1
            .split_once("SectionEnd")
            .unwrap()
            .0;
        let last_wait = section.rfind(wait).unwrap();
        let first_write = section.find("\n  Delete ").unwrap();
        assert!(last_wait < first_write);
        if let Some(file) = section.find("\n  File ") {
            assert!(last_wait < file);
        }
    }
}

#[test]
fn windows_uninstaller_restores_proxy_config_before_deleting_main_exe() {
    // issue #406：卸载后 config.toml 仍指向本机代理，官方 Codex 一直 502。
    // 卸载器必须在进程退出后、删除主程序前让主程序清理一次。
    let nsi = std::fs::read_to_string("../../scripts/installer/windows/CodexPilot.nsi")
        .unwrap()
        .replace("\r\n", "\n");
    let section = nsi
        .split_once("Section \"Uninstall\"")
        .unwrap()
        .1
        .split_once("SectionEnd")
        .unwrap()
        .0;
    let cleanup = section
        .find(r#"ExecWait '"$INSTDIR\codex-pilot.exe" --codex-plus-uninstall-cleanup'"#)
        .expect("卸载器应调用主程序清理代理配置");
    let last_wait = section.rfind("Call un.WaitForProcessExit").unwrap();
    let delete_exe = section
        .find(r#"Delete "$INSTDIR\codex-pilot.exe""#)
        .unwrap();
    assert!(last_wait < cleanup);
    assert!(cleanup < delete_exe);
}

#[test]
fn macos_dmg_ships_a_single_app_bundle() {
    let script = std::fs::read_to_string("../../scripts/installer/macos/package-dmg.sh").unwrap();
    assert!(script.contains("ln -s /Applications \"$STAGE/Applications\""));
    assert!(script.contains("Codex Pilot.app"));
    let app_commands: Vec<_> = script
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("create_app "))
        .collect();
    assert_eq!(
        app_commands,
        [r#"create_app "Codex Pilot" "CodexPilot" "$BINARY_DIR/codex-pilot" "com.garylee271.codexpilot" "false""#]
    );
    // 旧更新器兼容壳已移除，DMG 里只保留一个 app。
    assert!(!script.contains("管理工具.app"));
    assert!(!script.contains("legacy-shim"));
}

#[test]
fn both_companion_names_resolve_to_current_unified_app() {
    let exe = Path::new("/Applications/Codex Pilot.app/Contents/MacOS/CodexPilot");
    for binary in [APP_BINARY, MANAGER_BINARY] {
        assert_eq!(companion_binary_path_from_exe(exe, binary), exe);
        assert_eq!(
            macos_companion_bundle_identifier_from_exe(exe, binary),
            Some(APP_BUNDLE_ID)
        );
    }
}

#[test]
fn legacy_macos_layout_redirects_companions_to_unified_app() {
    for old in [
        "/Applications/Codex Pilot.app/Contents/MacOS/CodexPilot",
        "/Applications/Codex Pilot 管理工具.app/Contents/MacOS/CodexPilotManager",
    ] {
        for binary in [APP_BINARY, MANAGER_BINARY] {
            assert!(
                companion_binary_path_from_exe(Path::new(old), binary)
                    .to_string_lossy()
                    .replace('\\', "/")
                    .eq_ignore_ascii_case("/Applications/Codex Pilot.app/Contents/MacOS/CodexPilot")
            );
            assert_eq!(
                macos_companion_bundle_identifier_from_exe(Path::new(old), binary),
                Some(APP_BUNDLE_ID)
            );
        }
    }
}

#[test]
fn translocated_unified_app_uses_stable_bundle_id() {
    let exe = Path::new(
        "/private/var/folders/x/AppTranslocation/id/d/Codex Pilot.app/Contents/MacOS/CodexPilot",
    );
    assert_eq!(
        macos_companion_bundle_identifier_from_exe(exe, MANAGER_BINARY),
        Some(APP_BUNDLE_ID)
    );
}

#[test]
fn bare_unified_executable_resolves_both_roles_to_itself() {
    let exe = Path::new("/tmp/target/debug/codex-pilot");
    for binary in [APP_BINARY, MANAGER_BINARY] {
        assert_eq!(companion_binary_path_from_exe(exe, binary), exe);
        assert_eq!(
            macos_companion_bundle_identifier_from_exe(exe, binary),
            None
        );
    }
}

#[test]
fn default_install_root_uses_platform_strategy() {
    assert_eq!(
        default_install_root_strategy(),
        if cfg!(windows) {
            "windows-known-folder"
        } else if cfg!(target_os = "macos") {
            "macos-applications"
        } else {
            "user-dirs-desktop"
        }
    );
}

#[cfg(target_os = "macos")]
mod macos_install {
    use super::*;

    fn write_native_app(root: &Path) -> Vec<PathBuf> {
        let contents = root.join("Codex Pilot.app/Contents");
        let binary = contents.join("MacOS/CodexPilot");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        let mut bytes = vec![0_u8; 2048];
        bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        std::fs::write(&binary, bytes).unwrap();
        std::fs::create_dir_all(contents.join("_CodeSignature")).unwrap();
        std::fs::create_dir_all(contents.join("Resources")).unwrap();
        let plist = contents.join("Info.plist");
        std::fs::write(&plist, "<plist><dict><key>CodexPlusUnifiedApp</key><true/><key>CFBundleName</key><string>Codex Pilot</string><key>CFBundleIdentifier</key><string>com.garylee271.codexpilot</string><key>CFBundleExecutable</key><string>CodexPilot</string><key>CFBundleIconFile</key><string>native.icns</string><key>LSUIElement</key><false/></dict></plist>").unwrap();
        let signature = contents.join("_CodeSignature/CodeResources");
        std::fs::write(&signature, b"sealed resource sentinel").unwrap();
        let icon = contents.join("Resources/native.icns");
        std::fs::write(&icon, b"native icon sentinel").unwrap();
        vec![plist, binary, signature, icon]
    }

    fn options(root: &Path, source: &Path) -> InstallOptions {
        InstallOptions {
            install_root: Some(root.to_path_buf()),
            launcher_path: Some(source.to_path_buf()),
            ..InstallOptions::default()
        }
    }

    fn snapshot(paths: &[PathBuf]) -> Vec<Vec<u8>> {
        paths
            .iter()
            .map(|path| std::fs::read(path).unwrap())
            .collect()
    }

    #[test]
    fn repair_preserves_native_app_and_sealed_files_without_a_manager() {
        let root = tempfile::tempdir().unwrap();
        let files = write_native_app(root.path());
        let before = snapshot(&files);
        let plan = options(root.path(), &files[1]);
        for _ in 0..2 {
            codex_plus_core::install::macos::install_app_bundles(&plan).unwrap();
            assert_eq!(snapshot(&files), before);
        }
        assert!(
            !root
                .path()
                .join("Codex Pilot.app/Contents/MacOS/codex-pilot")
                .exists()
        );
        assert!(!root.path().join("Codex Pilot 管理工具.app").exists());
    }

    #[test]
    fn repair_preserves_native_app_through_symlink_and_hard_link_aliases() {
        let root = tempfile::tempdir().unwrap();
        let files = write_native_app(root.path());
        let before = snapshot(&files);
        let symlink = root.path().join("exe-symlink");
        let hard_link = root.path().join("exe-hard-link");
        std::os::unix::fs::symlink(&files[1], &symlink).unwrap();
        std::fs::hard_link(&files[1], &hard_link).unwrap();
        for alias in [symlink, hard_link] {
            codex_plus_core::install::macos::install_app_bundles(&options(root.path(), &alias))
                .unwrap();
            assert_eq!(snapshot(&files), before);
        }
    }

    #[test]
    fn install_copies_complete_native_app_without_rebuilding_its_files() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let files = write_native_app(source.path());
        let before = snapshot(&files);
        codex_plus_core::install::macos::install_app_bundles(&options(target.path(), &files[1]))
            .unwrap();
        let copied = files
            .iter()
            .map(|path| {
                target
                    .path()
                    .join(path.strip_prefix(source.path()).unwrap())
            })
            .collect::<Vec<_>>();
        assert_eq!(snapshot(&copied), before);
        assert_eq!(snapshot(&files), before);
        assert!(!target.path().join("Codex Pilot 管理工具.app").exists());
    }

    #[test]
    fn renamed_gui_bundle_wins_over_same_named_legacy_sibling() {
        let root = tempfile::tempdir().unwrap();
        let files = write_native_app(root.path());
        let before_gui = snapshot(&files);
        let original = root.path().join("Codex Pilot.app");
        let renamed = root.path().join("Codex Pilot 2.app");
        std::fs::rename(root.path().join("Codex Pilot.app"), &renamed).unwrap();
        let current = renamed.join("Contents/MacOS/CodexPilot");
        let legacy = write_native_app(root.path());
        let plist = std::fs::read_to_string(&legacy[0]).unwrap().replace(
            "<key>CodexPlusUnifiedApp</key><true/>",
            "<key>CodexPlusUnifiedApp</key><false/>",
        );
        std::fs::write(&legacy[0], plist).unwrap();
        let before = snapshot(&legacy);
        assert_eq!(
            codex_plus_core::install::macos::native_application_bundle_from_executable(&current)
                .unwrap(),
            std::fs::canonicalize(&renamed).unwrap(),
        );
        for binary in [APP_BINARY, MANAGER_BINARY] {
            assert_eq!(companion_binary_path_from_exe(&current, binary), current);
        }
        assert!(
            codex_plus_core::install::macos::native_application_bundle_from_executable(&legacy[1])
                .is_err()
        );
        assert_eq!(snapshot(&legacy), before);
        let renamed_files = files
            .iter()
            .map(|path| renamed.join(path.strip_prefix(&original).unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(snapshot(&renamed_files), before_gui);
    }

    #[test]
    fn native_gui_bundle_helper_rejects_auxiliary_executable_inside_the_bundle() {
        let root = tempfile::tempdir().unwrap();
        let files = write_native_app(root.path());
        let auxiliary = files[1].with_file_name("auxiliary");
        std::fs::copy(&files[1], &auxiliary).unwrap();
        let error =
            codex_plus_core::install::macos::native_application_bundle_from_executable(&auxiliary)
                .unwrap_err();
        assert!(error.to_string().contains("不是 Codex Pilot 原生界面的主程序"));
    }

    #[test]
    fn bare_binary_cannot_create_a_partial_or_unsigned_wrapper_app() {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("codex-pilot");
        std::fs::write(&binary, vec![0_u8; 2048]).unwrap();
        let target = root.path().join("apps");
        let error =
            codex_plus_core::install::macos::install_app_bundles(&options(&target, &binary))
                .unwrap_err();
        assert!(error.to_string().contains("完整的 Codex Pilot.app"));
        assert!(!target.exists());
    }

    #[test]
    fn legacy_silent_app_with_same_bundle_id_cannot_be_installed_as_gui() {
        let root = tempfile::tempdir().unwrap();
        let files = write_native_app(root.path());
        let plist = std::fs::read_to_string(&files[0]).unwrap().replace(
            "<key>CodexPlusUnifiedApp</key><true/>",
            "<key>CodexPlusUnifiedApp</key><false/>",
        );
        std::fs::write(&files[0], plist).unwrap();
        let before = snapshot(&files);
        let error =
            codex_plus_core::install::macos::install_app_bundles(&options(root.path(), &files[1]))
                .unwrap_err();
        assert!(error.to_string().contains("Codex Pilot 原生界面包"));
        assert_eq!(snapshot(&files), before);
    }

    #[test]
    fn other_native_source_cannot_overwrite_installed_signed_app() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let files = write_native_app(root.path());
        let other = write_native_app(source.path());
        let before = snapshot(&files);
        let error =
            codex_plus_core::install::macos::install_app_bundles(&options(root.path(), &other[1]))
                .unwrap_err();
        assert!(error.to_string().contains("不会改写"));
        assert_eq!(snapshot(&files), before);
    }
}
