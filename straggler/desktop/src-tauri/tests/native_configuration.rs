use std::{collections::BTreeMap, ffi::OsString, fs, path::Path};
use straggler_desktop::{
    configuration::{
        environment::Environment,
        storage::{Paths, Store},
    },
    workspace::{ConfigurationError, Settings},
};

fn environment(home: &Path, controls: &[(&str, &str)]) -> Environment {
    let mut variables = BTreeMap::from([(OsString::from("HOME"), home.as_os_str().to_owned())]);
    variables.extend(
        controls
            .iter()
            .map(|(name, value)| ((*name).into(), (*value).into())),
    );
    Environment::from_variables(variables, None).unwrap()
}

#[test]
fn defaults_and_environment_precedence_preserve_explicit_empty_controls() {
    let work = tempfile::tempdir().unwrap();
    let env = environment(
        work.path(),
        &[
            ("LLAMA_CTX_SIZE", "2048"),
            ("STRAGGLER_CTX_SIZE", "0"),
            ("STRAGGLER_GENERATION_PRESET", "focused"),
            ("STRAGGLER_SEED", "42"),
            ("LLAMA_ARG_SPLIT_MODE", "row"),
        ],
    );
    let settings = Settings::from_environment(&env).unwrap();
    assert_eq!(settings.context, "0");
    assert_eq!(settings.seed, "42");
    assert_eq!(settings.max_tokens, "auto");
    assert_eq!(settings.split_mode, "auto");
    assert_eq!(settings.generation_preset(), "focused");
    let env = environment(
        work.path(),
        &[("LLAMA_THREADS", "4"), ("STRAGGLER_THREADS", "")],
    );
    let failure = ConfigurationError::from(Settings::from_environment(&env).unwrap_err());
    assert_eq!(failure.field.as_deref(), Some("threads"));
    let env = environment(
        work.path(),
        &[
            ("STRAGGLER_LLAMA_CPP_DIR", ""),
            ("LLAMA_CPP_DIR", "/legacy"),
            ("STRAGGLER_MODELS_DIR", ""),
            ("LLAMA_MODELS_DIR", "/legacy models"),
        ],
    );
    let paths = Store::new(env).unwrap().paths();
    assert!(paths.llama.is_empty() && paths.models.is_empty());
}

#[test]
fn renamed_controls_override_mir_aliases_without_changing_native_arguments() {
    let work = tempfile::tempdir().unwrap();
    for (controls, expected) in [
        (
            vec![
                ("LLAMA_THREADS", "2"),
                ("MIR_THREADS", "4"),
                ("STRAGGLER_THREADS", "8"),
            ],
            "8",
        ),
        (vec![("LLAMA_THREADS", "2"), ("MIR_THREADS", "4")], "4"),
        (vec![("LLAMA_THREADS", "2")], "2"),
    ] {
        let env = environment(work.path(), &controls);
        assert_eq!(Settings::from_environment(&env).unwrap().threads, expected);
    }
    for name in ["STRAGGLER_THREADS", "MIR_THREADS"] {
        let env = environment(
            work.path(),
            &[("LLAMA_THREADS", "2"), ("MIR_THREADS", "4"), (name, "")],
        );
        let error = ConfigurationError::from(Settings::from_environment(&env).unwrap_err());
        assert_eq!(error.field.as_deref(), Some("threads"));
    }
    let env = environment(
        work.path(),
        &[
            ("STRAGGLER_MODELS_DIR", ""),
            ("MIR_MODELS_DIR", "/old models"),
            ("LLAMA_MODELS_DIR", "/older models"),
            ("MIR_LLAMA_CPP_DIR", "/existing backend"),
            ("LLAMA_ARG_SPLIT_MODE", "row"),
        ],
    );
    let store = Store::new(env).unwrap();
    assert!(store.paths().models.is_empty());
    assert_eq!(store.paths().llama, "/existing backend");
    assert_eq!(
        store.environment.value("LLAMA_ARG_SPLIT_MODE").as_deref(),
        Some("row")
    );
    assert_eq!(
        Settings::from_environment(&store.environment)
            .unwrap()
            .split_mode,
        "auto"
    );
}

#[test]
fn renamed_storage_reuses_existing_directories_and_never_merges_them() {
    let work = tempfile::tempdir().unwrap();
    let controls = [
        ("XDG_CONFIG_HOME", work.path().to_str().unwrap()),
        ("XDG_DATA_HOME", work.path().to_str().unwrap()),
    ];
    let fresh = environment(work.path(), &controls);
    assert_eq!(fresh.config, work.path().join("straggler"));
    assert_eq!(fresh.data, fresh.config);
    let legacy = work.path().join("mir.cpp");
    fs::create_dir_all(legacy.join("profiles")).unwrap();
    fs::write(
        legacy.join("paths.conf"),
        "llama_dir=/existing backend\nmodels_dir=/existing models\n",
    )
    .unwrap();
    fs::write(
        legacy.join("profiles/Existing.conf"),
        "model=/existing.gguf\n",
    )
    .unwrap();
    let store = Store::new(environment(work.path(), &controls)).unwrap();
    assert_eq!(store.environment.config, legacy);
    assert_eq!(store.environment.data, legacy);
    assert_eq!(store.paths().models, "/existing models");
    assert_eq!(store.profiles().unwrap(), ["Existing"]);
    assert!(!fresh.config.exists());
    fs::create_dir(&fresh.config).unwrap();
    let store = Store::new(environment(work.path(), &controls)).unwrap();
    assert_eq!(store.environment.config, fresh.config);
    assert_eq!(store.environment.data, fresh.data);
    assert!(store.profiles().unwrap().is_empty());
    assert!(legacy.join("profiles/Existing.conf").is_file());
}

#[test]
fn legacy_storage_entries_are_not_silently_replaced_when_unusable() {
    let work = tempfile::tempdir().unwrap();
    let legacy = work.path().join(".config/mir.cpp");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(work.path().join("missing"), &legacy).unwrap();
    let store = Store::new(environment(work.path(), &[])).unwrap();
    assert_eq!(store.environment.config, legacy);
    assert!(store.save_paths(&Paths::default()).is_err());
    assert!(!work.path().join(".config/straggler").exists());
    assert!(legacy.symlink_metadata().unwrap().is_symlink());
}

#[tokio::test]
async fn existing_desktop_data_and_session_lock_survive_the_rename() {
    use straggler_desktop::{
        history::History,
        preferences::{Preferences, UiPreferences},
        Runtime,
    };
    let work = tempfile::tempdir().unwrap();
    let legacy = work.path().join(".local/share/mir.cpp/desktop");
    let history = History::new(legacy.join("conversations")).unwrap();
    let id = uuid::Uuid::new_v4();
    let conversation = serde_json::from_value(serde_json::json!({
        "id": id, "title": "Existing conversation", "createdAt": 1, "updatedAt": 1,
        "model": null, "messages": []
    }))
    .unwrap();
    history.save(&conversation).unwrap();
    let preferences = UiPreferences {
        sidebar_collapsed: true,
        presence_expanded: Some(false),
        ..Default::default()
    };
    Preferences::new(legacy.clone()).save(&preferences).unwrap();
    let env = environment(work.path(), &[]);
    let data = env.data.join("desktop");
    assert_eq!(data, legacy);
    let runtime = Runtime::new(env.clone(), data.clone()).unwrap();
    assert_eq!(runtime.history.list().unwrap()[0].id, id);
    assert_eq!(runtime.preferences.read().unwrap(), preferences);
    assert!(Runtime::new(env.clone(), data.clone())
        .err()
        .unwrap()
        .contains("session is already open"));
    drop(runtime);
    assert!(Runtime::new(env, data).is_ok());
    assert!(!work.path().join(".local/share/straggler").exists());
}

#[test]
fn validation_covers_native_ranges_and_keeps_field_identifiers() {
    for (field, valid, invalid) in [
        ("context", "2147483647", "2147483648"),
        ("port", "06535", "65536"),
        ("threads", "1", "0"),
        ("top_p", "1.000000000", "1.000000001"),
        ("seed", "4294967295", "4294967296"),
        ("max_tokens", "-1", "-2"),
        ("repeat_penalty", "0.000000001", "0"),
        ("tensor_split", "0,1.5", "0,0.0"),
        ("fit_target", "0,2147483647", "0.5"),
        ("cache_type_k", "q4_0", "Q4_0"),
        ("chat_reasoning_effort", "very_high", "high$(touch unsafe)"),
    ] {
        let mut fields = Settings::default().fields();
        fields.insert(field.into(), valid.into());
        assert!(
            Settings::from_fields(fields.clone())
                .unwrap()
                .validated()
                .is_ok(),
            "{field}: {valid}"
        );
        fields.insert(field.into(), invalid.into());
        let failure = ConfigurationError::from(
            Settings::from_fields(fields)
                .unwrap()
                .validated()
                .unwrap_err(),
        );
        assert_eq!(failure.field.as_deref(), Some(field));
    }
}

#[test]
fn legacy_profiles_use_independent_defaults_and_round_trip_literal_prompts() {
    let profile = "model=/a/model.gguf\ncontext=1024\nremoved_option=$(touch unsafe)\n";
    let mut settings = Settings::from_profile(profile).unwrap();
    assert_eq!(settings.cache_type_v, "q4_0");
    assert_eq!(settings.port, "9931");
    assert_eq!(settings.temperature, "auto");
    settings.chat_system_prompt = "Literal $(touch unsafe)\nUnicode: caffè ☕".into();
    assert_eq!(
        Settings::from_profile(&settings.profile_data().unwrap()).unwrap(),
        settings
    );
    assert!(Settings::from_profile(&format!("{profile}context=2048\n")).is_err());
    assert!(Settings::from_profile("model=/a.gguf\nthreads=0\n").is_err());
    assert!(Settings::from_profile("context=1024\n").is_err());
}

#[test]
fn migration_preserves_originals_and_never_merges_existing_settings() {
    let work = tempfile::tempdir().unwrap();
    let env = environment(work.path(), &[]);
    let legacy = work.path().join(".config/llama-launcher");
    fs::create_dir_all(legacy.join("profiles")).unwrap();
    fs::write(
        legacy.join("paths.conf"),
        "llama_dir=/old\nmodels_dir=/models\n",
    )
    .unwrap();
    fs::write(legacy.join("profiles/Old.conf"), "model=/old.gguf\n").unwrap();
    let store = Store::new(env.clone()).unwrap();
    assert_eq!(store.paths().llama, "/old");
    assert_eq!(store.profiles().unwrap(), ["Old"]);
    assert!(legacy.join("profiles/Old.conf").is_file());
    fs::write(legacy.join("profiles/New.conf"), "model=/new.gguf\n").unwrap();
    let store = Store::new(env).unwrap();
    assert_eq!(store.profiles().unwrap(), ["Old"]);
}

#[test]
fn saves_are_literal_atomic_and_require_overwrite_and_delete_confirmation() {
    let work = tempfile::tempdir().unwrap();
    let env = environment(work.path(), &[]);
    let config = env.config.clone();
    let store = Store::new(env).unwrap();
    let model = work.path().join("model ' $(touch unsafe).gguf");
    fs::write(&model, []).unwrap();
    let mut settings = Settings {
        model: model.to_str().unwrap().into(),
        ..Settings::default()
    };
    store.save_profile("My profile", &settings, false).unwrap();
    let file = config.join("profiles/My profile.conf");
    let original = fs::read(&file).unwrap();
    settings.threads = "2".into();
    assert!(store.save_profile("My profile", &settings, false).is_err());
    assert_eq!(fs::read(&file).unwrap(), original);
    store.save_profile("My profile", &settings, true).unwrap();
    assert_eq!(store.load_profile("My profile").unwrap(), settings);
    assert!(store.delete_profile("My profile", false).is_err());
    assert!(store.save_profile("../escape", &settings, false).is_err());
    assert!(!work.path().join("unsafe").exists());
    let paths = Paths {
        llama: "/literal ' $(touch unsafe)".into(),
        models: work.path().to_str().unwrap().into(),
        warning: String::new(),
    };
    store.save_paths(&paths).unwrap();
    assert_eq!(store.paths().llama, paths.llama);
    fs::remove_file(config.join("paths.conf")).unwrap();
    fs::create_dir(config.join("paths.conf")).unwrap();
    assert!(store.save_paths(&paths).is_err());
    assert_eq!(store.load_profile("My profile").unwrap(), settings);
    store.delete_profile("My profile", true).unwrap();
    assert!(store.profiles().unwrap().is_empty());
}

#[test]
fn release_profile_fields_keep_independent_defaults_and_ignore_removed_keys() {
    use straggler_desktop::configuration::settings::PROFILE_FIELDS;

    let complete = Settings {
        model: "/literal model.gguf".into(),
        context: "8192".into(),
        port: "10001".into(),
        device: "Future1,Future0".into(),
        threads: "4".into(),
        gpu_layers: "12".into(),
        prompt_processing: "large-batch".into(),
        cache_type_k: "q8_0".into(),
        cache_type_v: "f16".into(),
        split_mode: "layer".into(),
        tensor_split: "2,1".into(),
        fit_target: "2048,1024".into(),
        temperature: "0.6".into(),
        seed: "42".into(),
        max_tokens: "1024".into(),
        chat_system_prompt: "Literal $(touch unsafe)\nUnicode: caffè ☕".into(),
        chat_reasoning: "off".into(),
        chat_reasoning_effort: "xhigh".into(),
        ..Settings::default()
    };
    let data = complete.profile_data().unwrap();
    assert_eq!(data.lines().count(), PROFILE_FIELDS.len());
    let defaults = Settings::default().fields();
    for field in PROFILE_FIELDS {
        let partial = data
            .lines()
            .filter(|line| line.split_once('=').unwrap().0 != *field)
            .collect::<Vec<_>>()
            .join("\n");
        if *field == "model" {
            assert!(Settings::from_profile(&partial).is_err());
        } else {
            let mut expected = complete.fields();
            expected.insert((*field).into(), defaults[*field].clone());
            assert_eq!(Settings::from_profile(&partial).unwrap().fields(), expected);
        }
        let duplicate = data
            .lines()
            .find(|line| line.split_once('=').unwrap().0 == *field)
            .unwrap();
        assert!(Settings::from_profile(&format!("{data}{duplicate}\n")).is_err());
    }
    let compatible = format!(
        "{data}reasoning=on\nremoved_control=auto\nremoved_control=off\nfuture_control=$(touch unsafe)\n"
    );
    let loaded = Settings::from_profile(&compatible).unwrap();
    assert_eq!(loaded, complete);
    assert_eq!(loaded.profile_data().unwrap(), data);
    let minimal = Settings::from_profile("model=/literal model.gguf").unwrap();
    assert_eq!(
        minimal,
        Settings {
            model: complete.model,
            ..Settings::default()
        }
    );
}

#[test]
fn profile_storage_failures_preserve_saved_data_and_remove_temporary_files() {
    let work = tempfile::tempdir().unwrap();
    let store = Store::new(environment(work.path(), &[])).unwrap();
    let model = work.path().join("model.gguf");
    fs::write(&model, []).unwrap();
    let settings = Settings {
        model: model.to_str().unwrap().into(),
        ..Settings::default()
    };
    store.save_profile("Saved", &settings, false).unwrap();
    let directory = store.environment.config.join("profiles");
    let original = fs::read(directory.join("Saved.conf")).unwrap();
    fs::create_dir(directory.join("Blocked.conf")).unwrap();
    assert!(store.save_profile("Blocked", &settings, true).is_err());
    assert_eq!(fs::read(directory.join("Saved.conf")).unwrap(), original);
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
    fs::remove_dir(directory.join("Blocked.conf")).unwrap();
    let backup = store.environment.config.join("profiles-backup");
    fs::rename(&directory, &backup).unwrap();
    fs::write(&directory, b"Blocked storage").unwrap();
    assert!(store.save_profile("Saved", &settings, true).is_err());
    assert_eq!(fs::read(backup.join("Saved.conf")).unwrap(), original);
    assert_eq!(fs::read(&directory).unwrap(), b"Blocked storage");
}

#[test]
fn saved_configuration_names_are_bounded_and_cannot_escape_the_profile_folder() {
    use straggler_desktop::configuration::storage::profile_name;

    for name in [
        "",
        ".hidden",
        "../escape",
        "a/b",
        "-name",
        "$(touch unsafe)",
    ] {
        assert!(!profile_name(name), "{name}");
    }
    assert!(!profile_name(&"Z".repeat(81)));
    assert!(profile_name(&"Z".repeat(80)));
    assert!(profile_name("Name with spaces._-"));
}

#[test]
fn chat_defaults_reuse_profile_serialization_and_preserve_environment_precedence() {
    use straggler_desktop::configuration::chat_defaults::merge;
    let work = tempfile::tempdir().unwrap();
    let store = Store::new(environment(work.path(), &[])).unwrap();
    let settings = Settings {
        context: "8192".into(),
        temperature: "0.6".into(),
        seed: "42".into(),
        chat_auto_compact: "on".into(),
        chat_system_prompt: "Literal $(touch unsafe)\nUnicode: caffè ☕".into(),
        ..Settings::default()
    };
    store.save_chat_defaults(&settings).unwrap();
    let path = store.environment.config.join("chat-defaults.conf");
    let data = fs::read_to_string(&path).unwrap();
    assert_eq!(data.lines().count(), 12);
    assert!(!data.contains("context="));
    assert!(data.lines().all(|line| settings
        .profile_data()
        .unwrap()
        .lines()
        .any(|profile| profile == line)));
    fs::write(
        &path,
        format!("{data}future_default=literal $(touch unsafe)\n"),
    )
    .unwrap();
    let loaded = store.initial_settings().unwrap();
    assert_eq!(loaded.temperature, "0.6");
    assert_eq!(loaded.seed, "42");
    assert_eq!(loaded.chat_system_prompt, settings.chat_system_prompt);
    assert_eq!(loaded.chat_auto_compact, "on");
    assert!(loaded.same_server_configuration(&Settings {
        chat_auto_compact: "off".into(),
        ..loaded.clone()
    }));
    assert_eq!(
        Settings::from_profile("model=test.gguf\n")
            .unwrap()
            .chat_auto_compact,
        "off"
    );
    assert_eq!(loaded.context, "auto");
    let controlled = Store::new(environment(
        work.path(),
        &[
            ("STRAGGLER_TEMPERATURE", "0.8"),
            ("MIR_TEMPERATURE", "1"),
            ("LLAMA_TEMPERATURE", "2"),
        ],
    ))
    .unwrap();
    assert_eq!(controlled.initial_settings().unwrap().temperature, "0.8");
    let explicit_empty = Store::new(environment(
        work.path(),
        &[("STRAGGLER_TEMPERATURE", ""), ("MIR_TEMPERATURE", "1")],
    ))
    .unwrap();
    assert!(explicit_empty.initial_settings().is_err());
    assert!(merge(&loaded, BTreeMap::from([("context".into(), "4096".into())])).is_err());
    let before = fs::read(&path).unwrap();
    assert!(merge(&loaded, BTreeMap::from([("top_p".into(), "2".into())])).is_err());
    assert!(merge(
        &loaded,
        BTreeMap::from([("chat_auto_compact".into(), "invalid".into())])
    )
    .is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::write(&path, "temperature=broken\n").unwrap();
    assert!(store.save_chat_defaults(&settings).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "temperature=broken\n");
}

#[test]
fn generation_defaults_do_not_change_server_identity_or_launch_arguments() {
    use straggler_desktop::configuration::capabilities;
    let work = tempfile::tempdir().unwrap();
    let environment = environment(work.path(), &[]);
    let initial = Settings::default();
    let mut values = initial.fields();
    for field in straggler_desktop::generation::fields() {
        values.insert(field.into(), "1".into());
    }
    let settings = Settings::from_fields(values).unwrap().validated().unwrap();
    assert!(initial.same_server_configuration(&settings));
    let arguments = capabilities::arguments(&settings, "", None, &environment).unwrap();
    for flag in [
        "--temperature",
        "--top-p",
        "--top-k",
        "--min-p",
        "--repeat-penalty",
        "--presence-penalty",
        "--frequency-penalty",
        "--seed",
        "--n-predict",
    ] {
        assert!(!arguments.iter().any(|argument| argument == flag));
    }
    let changed = Settings {
        context: "8192".into(),
        ..settings
    };
    assert!(!initial.same_server_configuration(&changed));
}
