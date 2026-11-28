mod support;

use socket2::{Domain, Protocol, Socket, Type};
use std::{
    fs,
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        atomic::{AtomicU16, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use straggler_desktop::{
    configuration::environment::Environment, platform, ChatMessage, ChatRequest, Runtime,
};
use uuid::Uuid;

#[test]
fn fixture_port_selection_skips_an_ipv6_listener() {
    // Use a separate range so this test cannot take another fixture's port
    // between releasing its reservation and launching the server.
    let next_port = AtomicU16::new(10000);
    let reservation = support::reserve_port_from(&next_port);
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);

    let listener = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP)).unwrap();
    listener.set_only_v6(true).unwrap();
    listener
        .bind(&std::net::SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)).into())
        .unwrap();
    listener.listen(1).unwrap();

    // The IPv4 loopback address is free, but native launch must reject this port.
    let ipv4 = TcpListener::bind(("127.0.0.1", port)).unwrap();
    drop(ipv4);
    assert!(platform::inspect_port(port).unwrap().occupied);
    next_port.store(port, Ordering::Relaxed);
    let selected = support::reserve_port_from(&next_port);
    assert_ne!(selected.local_addr().unwrap().port(), port);
}

struct Fixture {
    _directory: tempfile::TempDir,
    environment: Environment,
    data: PathBuf,
    model: String,
    record: PathBuf,
    port: u16,
    reservation: Mutex<Option<TcpListener>>,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let models = root.join("models with spaces");
        fs::create_dir(&models).unwrap();
        let model = models.join("model ' $(touch unsafe).gguf");
        fs::write(&model, []).unwrap();
        let llama = root.join("llama.cpp");
        fs::create_dir_all(llama.join("build/bin")).unwrap();
        let server = llama.join("build/bin/llama-server");
        fs::write(&server, include_str!("../../tests/fixtures/server.py")).unwrap();
        fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();
        let reservation = support::reserve_server_port();
        let port = reservation.local_addr().unwrap().port();
        let record = root.join("request.json");
        let variables = std::collections::BTreeMap::from([
            ("HOME".into(), root.as_os_str().to_owned()),
            ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
            (
                "STRAGGLER_LLAMA_CPP_DIR".into(),
                llama.as_os_str().to_owned(),
            ),
            ("STRAGGLER_MODELS_DIR".into(), models.as_os_str().to_owned()),
            ("STRAGGLER_PORT".into(), port.to_string().into()),
            ("TEST_REQUEST".into(), record.as_os_str().to_owned()),
            (
                "TEST_LAUNCH".into(),
                root.join("launch.json").into_os_string(),
            ),
        ]);
        let environment = Environment::from_variables(variables, None).unwrap();
        Self {
            environment,
            data: root.join("data"),
            model: model.to_str().unwrap().into(),
            record,
            port,
            reservation: Mutex::new(Some(reservation)),
            _directory: directory,
        }
    }

    fn release_port(&self) {
        self.reservation.lock().unwrap().take();
    }

    fn runtime(&self) -> Arc<Runtime> {
        Arc::new(Runtime::new(self.environment.clone(), self.data.clone()).unwrap())
    }

    fn start(&self, runtime: &Runtime) {
        self.release_port();
        runtime.start(self.model.clone()).unwrap_or_else(|error| {
            let inspection =
                platform::inspect_port(self.port).map(|status| (status.occupied, status.listeners));
            panic!("Cannot start fixture server: {error}; current port inspection: {inspection:?}");
        });
    }

    async fn ready(&self, runtime: &Runtime) {
        self.start(runtime);
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let status = runtime.status().await.unwrap();
                assert_ne!(status.phase, "error", "{:?}", status.logs);
                if status.phase == "ready" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
    }
}

fn request(id: Uuid, content: &str) -> ChatRequest {
    ChatRequest {
        max_output_tokens: None,
        cloud: None,
        web_search: false,
        image_ids: Vec::new(),
        web_search_query: None,
        temporary_id: None,
        conversation_id: None,
        options: Default::default(),
        request_id: id,
        messages: vec![ChatMessage {
            reasoning_content: None,
            role: "user".into(),
            content: content.into(),
        }],
    }
}

#[test]
fn model_file_picker_validates_files_without_applying_settings() {
    use straggler_desktop::configuration::model_files::ModelFileKind;
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let original = runtime.inspect().unwrap().settings;
    let template = fixture._directory.path().join("custom.jinja");
    fs::write(&template, "{{ messages }}").unwrap();
    let selected = runtime
        .select_model_file(ModelFileKind::Template, &template)
        .unwrap();
    assert_eq!(selected, template.canonicalize().unwrap().to_str().unwrap());
    assert!(runtime
        .select_model_file(ModelFileKind::Mtp, &template)
        .is_err());
    assert_eq!(runtime.inspect().unwrap().settings, original);
}

#[tokio::test]
async fn supervised_launch_uses_saved_template_and_mtp_choices() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let template = PathBuf::from(&fixture.model).with_file_name("chat_template.jinja");
    let mtp = fixture._directory.path().join("external-mtp.gguf");
    fs::write(&template, "{{ messages[0].content }}").unwrap();
    fs::write(&mtp, b"GGUFfake MTP fixture").unwrap();
    let defaults = runtime.inspect().unwrap().settings;
    for mode in ["off", "model", "file"] {
        let mut settings = defaults.clone();
        settings.mtp = mode.into();
        if mode == "file" {
            settings.chat_template_file = template.to_str().unwrap().into();
            settings.mtp_file = mtp.to_str().unwrap().into();
        }
        runtime.configure(settings.clone()).unwrap();
        runtime
            .workspace_action(
                "save-profile",
                vec!["model-options".into(), "replace".into()],
                vec![],
            )
            .unwrap();
        runtime.configure(defaults.clone()).unwrap();
        let loaded = runtime
            .workspace_action("load-profile", vec!["model-options".into()], vec![])
            .unwrap();
        assert_eq!(loaded["settings"], serde_json::to_value(&settings).unwrap());
        assert_eq!(runtime.status().await.unwrap().phase, "stopped");
        fixture.ready(&runtime).await;
        let launch: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture._directory.path().join("launch.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(launch["jinja"], true);
        assert_eq!(
            launch["spec_type"],
            if mode == "off" { "none" } else { "draft-mtp" }
        );
        if mode == "file" {
            assert_eq!(launch["chat_template_file"], template.to_str().unwrap());
            assert_eq!(launch["spec_draft_model"], mtp.to_str().unwrap());
        } else {
            assert!(launch["chat_template_file"].is_null());
            assert!(launch["spec_draft_model"].is_null());
        }
        let mut changed = settings.clone();
        changed.chat_template_file = if mode == "file" {
            "".into()
        } else {
            template.to_str().unwrap().into()
        };
        let modified = runtime.configure(changed).unwrap();
        assert!(modified.modified);
        assert!(modified.restart_required);
        runtime.stop().unwrap();
    }
    // A selected file disappearing is an error; the embedded template is never substituted.
    let mut missing = defaults;
    missing.chat_template_file = template.to_str().unwrap().into();
    runtime.configure(missing).unwrap();
    fs::remove_file(&template).unwrap();
    assert!(runtime
        .start(fixture.model.clone())
        .unwrap_err()
        .contains("chat_template.jinja"));
}

fn stored_files(root: &std::path::Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    let mut files = std::collections::BTreeMap::new();
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.insert(
                    path.strip_prefix(root).unwrap().to_owned(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    files
}

#[tokio::test]
async fn temporary_requests_disable_ram_cache_erase_the_advertised_slot_and_never_store_chat_data()
{
    for erase_fails in [false, true] {
        let mut fixture = Fixture::new();
        fixture
            .environment
            .variables
            .insert("TEST_EMIT_PROMPT_LOG".into(), "1".into());
        if erase_fails {
            fixture
                .environment
                .variables
                .insert("TEST_ERASE_FAIL".into(), "1".into());
        }
        let runtime = fixture.runtime();
        fixture.ready(&runtime).await;
        let before = stored_files(&fixture.data);
        let id = Uuid::new_v4();
        runtime.begin_temporary(id).unwrap();
        wait_phase(&runtime, "ready").await;
        let launch: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture._directory.path().join("launch.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(launch["cache_ram"], "0");
        assert_eq!(launch["slots"], true);
        assert_eq!(launch["log_disable"], true);
        assert!(runtime.ensure_persistent(id).is_err());
        let mut temporary = request(Uuid::new_v4(), "private test prompt");
        temporary.temporary_id = Some(id);
        runtime.generate(temporary, |_| Ok(())).await.unwrap();
        let recorded: serde_json::Value =
            serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
        assert_eq!(recorded["cache_prompt"], false);
        assert_eq!(recorded["id_slot"], 7);
        assert!(runtime.status().await.unwrap().logs.is_empty());
        assert_eq!(stored_files(&fixture.data), before);
        let erased = runtime.erase_temporary_slot(id).await;
        assert_eq!(erased.is_err(), erase_fails);
        runtime.finish_temporary(id, None, true).unwrap();
        wait_phase(&runtime, "ready").await;
        assert!(fixture.record.with_extension("json.erase").exists());
        assert!(runtime.history.list().unwrap().is_empty());
        assert_eq!(stored_files(&fixture.data), before);
        let launch: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture._directory.path().join("launch.json")).unwrap(),
        )
        .unwrap();
        assert!(launch["cache_ram"].is_null());
        assert_eq!(launch["slots"], false);
        runtime.stop().unwrap();
    }
}

#[tokio::test]
async fn temporary_http_errors_classify_context_rejection_without_exposing_backend_details() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    let id = Uuid::new_v4();
    runtime.begin_temporary(id).unwrap();
    wait_phase(&runtime, "ready").await;

    for (prompt, expected) in [
        (
            "context-reject",
            "exceed_context_size_error: The prompt exceeds the available context size.",
        ),
        (
            "context-reject-lookalike",
            "Temporary model request failed (400 Bad Request). The backend did not accept the request.",
        ),
        (
            "malformed-error",
            "Temporary model request failed (400 Bad Request). The backend did not accept the request.",
        ),
    ] {
        let mut turn = request(Uuid::new_v4(), prompt);
        turn.temporary_id = Some(id);
        let error = runtime
            .generate(turn, |_| panic!("An HTTP error must not emit a delta"))
            .await
            .unwrap_err();
        assert_eq!(error, expected);
    }
    runtime.erase_temporary_slot(id).await.unwrap();
    runtime.finish_temporary(id, None, true).unwrap();
    runtime.stop().unwrap();
}

#[tokio::test]
async fn saving_temporary_attachments_is_explicit_and_storage_failure_preserves_memory_for_retry() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    runtime.inspect().unwrap();
    let before = stored_files(&fixture.data);
    let id = Uuid::new_v4();
    runtime.begin_temporary(id).unwrap();
    let original = fixture._directory.path().join("private.txt");
    fs::write(&original, "temporary original bytes").unwrap();
    let attachment = runtime.temporary_attachment(id, &original).unwrap();
    let passages = runtime
        .search_attachments(id, true, "temporary", 100)
        .unwrap();
    assert_eq!(passages.len(), 1);
    assert_eq!(passages[0].text, "temporary original bytes");
    assert_eq!(passages[0].conversation_id, Some(id));
    assert_eq!(stored_files(&fixture.data), before);
    let chat: straggler_desktop::history::Conversation =
        serde_json::from_value(serde_json::json!({
            "id": id, "title": "Saved temporary chat", "createdAt": 1, "updatedAt": 1,
            "model": null, "messages": [], "attachments": [attachment]
        }))
        .unwrap();
    let directory = fixture.data.join("conversations");
    let backup = fixture.data.join("kept-conversations");
    fs::rename(&directory, &backup).unwrap();
    fs::write(&directory, "storage unavailable").unwrap();
    runtime.erase_temporary_slot(id).await.unwrap();
    assert!(runtime
        .finish_temporary(id, Some(chat.clone()), false)
        .is_err());
    assert!(runtime.ensure_persistent(id).is_err());
    fs::remove_file(&directory).unwrap();
    fs::rename(&backup, &directory).unwrap();
    runtime.finish_temporary(id, Some(chat), false).unwrap();
    runtime.ensure_persistent(id).unwrap();
    assert!(runtime
        .search_attachments(id, true, "temporary", 100)
        .is_err());
    let saved = runtime.history.list().unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].attachments[0].text, "temporary original bytes");
    let destination = fixture._directory.path().join("saved-original.txt");
    runtime
        .history
        .download_attachment(id, attachment.id, &destination)
        .unwrap();
    assert_eq!(fs::read(destination).unwrap(), b"temporary original bytes");
}

#[tokio::test]
async fn unsupported_temporary_mode_and_invalid_session_cleanup_leave_the_normal_server_running() {
    let fixture = Fixture::new();
    let server = fixture
        ._directory
        .path()
        .join("llama.cpp/build/bin/llama-server");
    let source = fs::read_to_string(&server)
        .unwrap()
        .replace("--cache-ram N", "unsupported option");
    fs::write(server, source).unwrap();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    let before = runtime.status().await.unwrap().run_id;
    assert!(runtime
        .begin_temporary(Uuid::new_v4())
        .unwrap_err()
        .contains("--cache-ram"));
    assert!(runtime
        .finish_temporary(Uuid::new_v4(), None, true)
        .is_err());
    let after = runtime.status().await.unwrap();
    assert_eq!(after.run_id, before);
    assert_eq!(after.phase, "ready");
    runtime.stop().unwrap();
}

#[tokio::test]
async fn native_configuration_stream_and_owned_shutdown() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let config = runtime.inspect().unwrap();
    assert_eq!(config.models[0].path, fixture.model);
    assert!(config.server_available);
    assert!(Runtime::new(fixture.environment.clone(), fixture.data.clone()).is_err());
    fixture.ready(&runtime).await;
    assert!(runtime.start(fixture.model.clone()).is_err());
    let mut content = String::new();
    let result = runtime
        .generate(request(Uuid::new_v4(), "hello"), |delta| {
            content += &delta.content;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(result, "complete");
    assert_eq!(content, "caffè ☕");
    let recorded: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
    assert_eq!(recorded["messages"][0]["content"], "hello");
    assert!(recorded.get("temperature").is_none());
    assert!(recorded.get("max_tokens").is_none());
    assert!(!fixture._directory.path().join("unsafe").exists());
    runtime.stop().unwrap();
    assert_eq!(runtime.status().await.unwrap().phase, "stopped");
    assert!(TcpListener::bind(("127.0.0.1", fixture.port)).is_ok());
}

async fn wait_phase(runtime: &Runtime, phase: &str) -> straggler_desktop::Status {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = runtime.status().await.unwrap();
            if status.phase == phase {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn fatal_memory_failure_survives_health_checks_until_a_new_server_run() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    let mut partial = String::new();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        runtime.generate(request(Uuid::new_v4(), "oom-stream"), |delta| {
            partial += &delta.content;
            fs::write(format!("{}.continue", fixture.record.display()), []).unwrap();
            Ok(())
        }),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    assert_eq!(partial, "caffè ☕");
    let status = wait_phase(&runtime, "needs-restart").await;
    assert_eq!(
        status.issue.unwrap().kind,
        straggler_desktop::diagnostics::IssueKind::Memory
    );
    // The fixture continues to advertise health after its backend has failed.
    assert!(
        reqwest::get(format!("http://127.0.0.1:{}/health", fixture.port))
            .await
            .unwrap()
            .status()
            .is_success()
    );
    assert_eq!(runtime.status().await.unwrap().phase, "needs-restart");
    assert!(runtime
        .generate(request(Uuid::new_v4(), "hello"), |_| Ok(()))
        .await
        .unwrap_err()
        .contains("restarted"));
    runtime.stop().unwrap();
    let stopped = runtime.status().await.unwrap();
    assert_eq!(stopped.phase, "stopped");
    assert!(stopped.issue.is_some());
    fixture.ready(&runtime).await;
    assert!(runtime.status().await.unwrap().issue.is_none());
    assert_eq!(
        runtime
            .generate(request(Uuid::new_v4(), "hello"), |_| Ok(()))
            .await
            .unwrap(),
        "complete"
    );
    runtime.stop().unwrap();
}

#[tokio::test]
async fn startup_and_request_oom_are_distinguished_from_recoverable_errors() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    assert_eq!(
        runtime
            .generate(request(Uuid::new_v4(), "memory-warning"), |_| Ok(()))
            .await
            .unwrap(),
        "complete"
    );
    assert_eq!(runtime.status().await.unwrap().phase, "ready");
    assert!(runtime
        .generate(request(Uuid::new_v4(), "compute-error"), |_| Ok(()))
        .await
        .unwrap_err()
        .contains("Compute error"));
    assert!(runtime.status().await.unwrap().issue.is_none());
    assert!(runtime
        .generate(request(Uuid::new_v4(), "oom"), |_| Ok(()))
        .await
        .is_err());
    wait_phase(&runtime, "needs-restart").await;
    runtime.stop().unwrap();
    fs::write(format!("{}.oom-init", fixture.record.display()), []).unwrap();
    fixture.start(&runtime);
    let status = wait_phase(&runtime, "needs-restart").await;
    assert_eq!(
        status.issue.unwrap().kind,
        straggler_desktop::diagnostics::IssueKind::Memory
    );
    runtime.stop().unwrap();
}

#[tokio::test]
async fn cancellation_before_and_during_stream_and_new_request() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    let early = Uuid::new_v4();
    runtime.cancel(early).unwrap();
    assert_eq!(
        runtime
            .generate(request(early, "hello"), |_| Ok(()))
            .await
            .unwrap(),
        "stopped"
    );
    let id = Uuid::new_v4();
    let partial = Arc::new(Mutex::new(String::new()));
    let task_runtime = runtime.clone();
    let task_partial = partial.clone();
    let (sent, received) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut sent = Some(sent);
        task_runtime
            .generate(request(id, "wait"), |delta| {
                task_partial.lock().unwrap().push_str(&delta.content);
                if let Some(sent) = sent.take() {
                    let _ = sent.send(());
                }
                Ok(())
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), received)
        .await
        .unwrap()
        .unwrap();
    assert!(runtime
        .generate(request(Uuid::new_v4(), "hello"), |_| Ok(()))
        .await
        .is_err());
    runtime.cancel(id).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        "stopped"
    );
    assert_eq!(&*partial.lock().unwrap(), "caffè ☕");
    assert_eq!(
        runtime
            .generate(request(Uuid::new_v4(), "hello"), |_| Ok(()))
            .await
            .unwrap(),
        "complete"
    );
    runtime.stop().unwrap();
}

#[tokio::test]
async fn unsupported_chat_and_interrupted_stream_preserve_errors() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    assert!(runtime
        .generate(request(Uuid::new_v4(), "reject"), |_| Ok(()))
        .await
        .unwrap_err()
        .contains("Unsupported chat template"));
    let mut partial = String::new();
    let error = runtime
        .generate(request(Uuid::new_v4(), "interrupted"), |delta| {
            partial += &delta.content;
            Ok(())
        })
        .await
        .unwrap_err();
    assert!(error.contains("ended unexpectedly"));
    assert_eq!(partial, "caffè ☕");
    runtime.stop().unwrap();
}

#[tokio::test]
async fn occupied_port_never_stops_its_listener() {
    let fixture = Fixture::new();
    let external = fixture.reservation.lock().unwrap().take().unwrap();
    let runtime = fixture.runtime();
    assert!(runtime.inspect().unwrap().port_status.contains("IN USE"));
    fixture.release_port();
    assert!(runtime
        .start(fixture.model.clone())
        .unwrap_err()
        .contains("IN USE"));
    assert_eq!(runtime.status().await.unwrap().phase, "stopped");
    runtime.stop().unwrap();
    assert!(std::net::TcpStream::connect(external.local_addr().unwrap()).is_ok());
}

#[tokio::test]
async fn full_configuration_profiles_and_folder_changes_are_transactional() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let initial = runtime.inspect().unwrap();
    assert_eq!(initial.settings.temperature, "auto");
    assert_eq!(initial.devices[0].name, "Test0");
    let mut settings = initial.settings;
    settings.temperature = "0.6".into();
    settings.top_p = "0.95".into();
    settings.top_k = "20".into();
    settings.min_p = "0".into();
    settings.repeat_penalty = "1".into();
    settings.presence_penalty = "0".into();
    settings.frequency_penalty = "0".into();
    settings.seed = "42".into();
    settings.max_tokens = "512".into();
    let focused = runtime.configure(settings.clone()).unwrap();
    assert_eq!(focused.generation_preset, "focused");
    let saved = runtime
        .workspace_action(
            "save-profile",
            vec!["My profile".into(), "new".into()],
            vec![],
        )
        .unwrap();
    assert_eq!(saved["currentProfile"], "My profile");
    assert_eq!(saved["modified"], false);
    settings.context = "1024".into();
    settings.threads = "2".into();
    let edited = runtime.configure(settings.clone()).unwrap();
    assert!(edited.modified);
    let mut invalid = settings.clone();
    invalid.threads = "0".into();
    assert!(runtime.configure(invalid).is_err());
    assert_eq!(runtime.inspect().unwrap().settings, settings);
    assert!(runtime
        .workspace_action(
            "save-profile",
            vec!["My profile".into(), "new".into()],
            vec![]
        )
        .is_err());
    let restored = runtime
        .workspace_action("load-profile", vec!["My profile".into()], vec![])
        .unwrap();
    assert_eq!(restored["settings"]["context"], "auto");
    assert_eq!(restored["settings"]["seed"], "42");
    assert_eq!(restored["modified"], false);
    assert!(runtime
        .workspace_action("load-profile", vec!["../escape".into()], vec![])
        .is_err());
    assert_eq!(
        runtime.inspect().unwrap().current_profile.as_deref(),
        Some("My profile")
    );
    let deleted = runtime
        .workspace_action(
            "delete-profile",
            vec!["My profile".into(), "confirm".into()],
            vec![],
        )
        .unwrap();
    assert!(deleted["currentProfile"].is_null());
    assert_eq!(deleted["settings"]["seed"], "42");

    let directory = fixture._directory.path().join("empty models");
    fs::create_dir_all(directory.join(".hidden")).unwrap();
    let folder = runtime
        .workspace_action(
            "browse",
            vec![directory.to_str().unwrap().into(), "false".into()],
            vec![],
        )
        .unwrap();
    assert!(folder["directories"].as_array().unwrap().is_empty());
    let folder = runtime
        .workspace_action(
            "browse",
            vec![directory.to_str().unwrap().into(), "true".into()],
            vec![],
        )
        .unwrap();
    assert_eq!(folder["directories"][0]["name"], ".hidden");
    let next = runtime
        .workspace_action(
            "set-path",
            vec!["models".into(), directory.to_str().unwrap().into()],
            vec![],
        )
        .unwrap();
    assert!(next["models"].as_array().unwrap().is_empty());
    assert_eq!(next["settings"]["model"], "");
    assert_eq!(
        runtime.inspect().unwrap().models_dir,
        directory.canonicalize().unwrap().to_str().unwrap()
    );
    assert!(runtime
        .workspace_action(
            "set-path",
            vec!["llama".into(), directory.to_str().unwrap().into()],
            vec![]
        )
        .is_err());
    assert!(runtime.inspect().unwrap().server_available);
}

#[tokio::test]
async fn explicit_settings_reach_the_server_and_pending_changes_require_restart() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let mut settings = runtime.inspect().unwrap().settings;
    settings.context = "1024".into();
    settings.device = "none".into();
    settings.gpu_layers = "all".into();
    runtime.configure(settings.clone()).unwrap();
    fixture.ready(&runtime).await;
    assert_eq!(
        runtime.status().await.unwrap().running_settings.unwrap(),
        settings
    );
    settings.chat_system_prompt = "Changed request instructions\nLiteral $(touch unsafe)".into();
    settings.chat_reasoning = "on".into();
    settings.chat_reasoning_effort = "high".into();
    assert!(
        !runtime
            .configure(settings.clone())
            .unwrap()
            .restart_required
    );
    settings.context = "2048".into();
    assert!(runtime.configure(settings).unwrap().restart_required);
    runtime.stop().unwrap();
    assert!(!runtime.inspect().unwrap().restart_required);
}

#[tokio::test]
async fn model_properties_request_switches_and_stream_usage_match_upstream_contracts() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    let details = runtime.server_details().await.unwrap();
    assert_eq!(details.context_size, Some(4096));
    assert_eq!(details.effort_levels, ["low", "high"]);
    assert_eq!(details.reasoning_supported, Some(true));
    let mut query = request(Uuid::new_v4(), "hello");
    query.options.reasoning = Some("on".into());
    query.options.effort = Some("high".into());
    let mut metrics = straggler_desktop::stream::GenerationMetrics::default();
    runtime
        .generate(query, |delta| {
            if let Some(value) = delta.metrics {
                metrics.merge(&value);
            }
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(metrics.context_tokens, Some(32));
    assert_eq!(metrics.tokens_per_second, Some(20.0));
    let recorded: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
    assert_eq!(recorded["chat_template_kwargs"]["enable_thinking"], true);
    assert_eq!(recorded["reasoning_effort"], "high");
    assert_eq!(recorded["stream_options"]["include_usage"], true);
    assert_eq!(recorded["timings_per_token"], true);
    let mut query = request(Uuid::new_v4(), "hello");
    query.options.reasoning = Some("off".into());
    query.options.effort = Some("unavailable".into());
    runtime.generate(query, |_| Ok(())).await.unwrap();
    let recorded: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
    assert_eq!(recorded["reasoning_effort"], "none");
    assert_eq!(recorded["chat_template_kwargs"]["enable_thinking"], false);
    let mut query = request(Uuid::new_v4(), "hello");
    query.options.effort = Some("medium".into());
    assert!(runtime
        .generate(query, |_| Ok(()))
        .await
        .unwrap_err()
        .contains("not advertised"));
    runtime.stop().unwrap();
    fixture.ready(&runtime).await;
    assert_ne!(
        runtime.server_details().await.unwrap().run_id,
        details.run_id
    );
}

#[tokio::test]
async fn listeners_require_matching_identity_and_term_does_not_force_kill() {
    use std::process::{Command, Stdio};
    let fixture = Fixture::new();
    fixture.release_port();
    let script = "import signal,socket,time,sys;signal.signal(signal.SIGTERM,lambda *a:None);s=socket.socket();s.bind(('127.0.0.1',int(sys.argv[1])));s.listen();print('ready',flush=True);time.sleep(30)";
    let mut external = Command::new("python3")
        .args(["-u", "-c", script, &fixture.port.to_string()])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    use std::io::BufRead;
    std::io::BufReader::new(external.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let runtime = fixture.runtime();
    let targets = runtime.inspect().unwrap().listeners;
    assert!(targets.iter().any(|target| target.pid == external.id()));
    let mut stale = targets.clone();
    for target in &mut stale {
        target.identity = "stale identity".into();
    }
    runtime
        .workspace_action("stop-listeners", vec!["TERM".into()], stale)
        .unwrap();
    assert!(external.try_wait().unwrap().is_none());
    let remaining = runtime
        .workspace_action("stop-listeners", vec!["TERM".into()], targets.clone())
        .unwrap();
    assert!(!remaining["listeners"].as_array().unwrap().is_empty());
    assert!(external.try_wait().unwrap().is_none());
    runtime
        .workspace_action("stop-listeners", vec!["KILL".into()], targets)
        .unwrap();
    assert!(!external.wait().unwrap().success());
}

#[tokio::test]
async fn bundled_backend_selection_preserves_settings_and_uses_the_pinned_release() {
    let mut fixture = Fixture::new();
    let manifest = straggler_desktop::configuration::native::bundled_manifest();
    fixture.environment.variables.insert(
        "TEST_BACKEND_VERSION".into(),
        manifest["commit"].as_str().unwrap().into(),
    );
    fixture.environment.bundled_server = Some(
        fixture
            ._directory
            .path()
            .join("llama.cpp/build/bin/llama-server"),
    );
    fixture
        .environment
        .variables
        .remove(&std::ffi::OsString::from("STRAGGLER_LLAMA_CPP_DIR"));
    let runtime = fixture.runtime();
    let initial = runtime.inspect().unwrap();
    assert!(initial.server_available);
    assert!(initial.llama_dir.is_empty());
    assert_eq!(initial.build["tag"], manifest["tag"]);
    assert_eq!(initial.build["backend"], "bundled");
    let mut settings = initial.settings.clone();
    settings.threads = "2".into();
    runtime.configure(settings.clone()).unwrap();
    let external = fixture._directory.path().join("llama.cpp");
    runtime
        .workspace_action(
            "set-path",
            vec!["llama".into(), external.to_str().unwrap().into()],
            vec![],
        )
        .unwrap();
    assert!(!runtime.inspect().unwrap().llama_dir.is_empty());
    let bundled = runtime
        .workspace_action("use-bundled", vec![], vec![])
        .unwrap();
    assert_eq!(bundled["settings"], serde_json::to_value(settings).unwrap());
    assert_eq!(bundled["llamaDir"], "");
    assert!(runtime.workspace_action("latest", vec![], vec![]).is_err());
    fixture.ready(&runtime).await;
    assert!(runtime
        .workspace_action("use-bundled", vec![], vec![])
        .is_err());
    runtime.stop().unwrap();
}

#[tokio::test]
async fn tokenization_counts_text_and_rendered_prompts_without_generation() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    let count = runtime.tokenize_text("caffè ☕").await.unwrap();
    assert_eq!(count, "caffè ☕".len().div_ceil(4));
    let recorded: serde_json::Value = serde_json::from_slice(
        &fs::read(format!("{}.tokenize", fixture.record.display())).unwrap(),
    )
    .unwrap();
    assert_eq!(recorded["parse_special"], false);
    let count = runtime
        .prompt_tokens(vec![ChatMessage {
            reasoning_content: None,
            role: "user".into(),
            content: "Attachment text".into(),
        }])
        .await
        .unwrap();
    assert!(count.templated);
    assert_eq!(count.tokens, "Attachment text<think>".len().div_ceil(4));
    assert!(!fixture.record.exists());
    runtime.stop().unwrap();
    assert!(runtime.tokenize_text("offline").await.is_err());
}

fn project_record(name: &str) -> straggler_desktop::projects::Project {
    serde_json::from_value(serde_json::json!({
        "id": Uuid::new_v4(), "name": name, "description": "", "instructions": "Original instructions",
        "starred": false, "archived": false, "createdAt": 1, "updatedAt": 1, "files": []
    })).unwrap()
}

fn stored_chat(runtime: &Runtime) -> straggler_desktop::history::Conversation {
    let chat = serde_json::from_value(serde_json::json!({
        "id": Uuid::new_v4(), "title": "Project chat", "createdAt": 1, "updatedAt": 2,
        "model": null, "messages": [], "options": {"systemPrompt": "Own prompt", "reasoning": null, "effort": null}
    })).unwrap();
    runtime.history.create(&chat).unwrap();
    chat
}

#[tokio::test]
async fn project_storage_and_generation_use_identity_and_immutable_request_snapshots() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let mut project = runtime
        .save_project(project_record("Native project"))
        .unwrap()
        .project
        .unwrap()
        .project;
    let active = stored_chat(&runtime);
    let other = stored_chat(&runtime);
    runtime
        .move_project_chat(active.id, Some(project.id))
        .unwrap();
    runtime
        .move_project_chat(other.id, Some(project.id))
        .unwrap();
    project.archived = true;
    project = runtime
        .save_project(project)
        .unwrap()
        .project
        .unwrap()
        .project;
    fixture.ready(&runtime).await;
    let mut archived = request(Uuid::new_v4(), "hello");
    archived.conversation_id = Some(active.id);
    assert!(runtime
        .generate(archived, |_| Ok(()))
        .await
        .unwrap_err()
        .contains("Restore"));
    assert!(!fixture.record.exists());
    project.archived = false;
    project = runtime
        .save_project(project)
        .unwrap()
        .project
        .unwrap()
        .project;
    let id = Uuid::new_v4();
    let task_runtime = runtime.clone();
    let (sent, received) = tokio::sync::oneshot::channel();
    let snapshot = project.instructions.clone();
    let mut submitted = request(id, "wait");
    submitted.conversation_id = Some(active.id);
    submitted.messages.insert(
        0,
        ChatMessage {
            reasoning_content: None,
            role: "system".into(),
            content: snapshot.clone(),
        },
    );
    let task = tokio::spawn(async move {
        let mut sent = Some(sent);
        task_runtime
            .generate(submitted, |_| {
                if let Some(sent) = sent.take() {
                    let _ = sent.send(());
                }
                Ok(())
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), received)
        .await
        .unwrap()
        .unwrap();
    project.instructions = "Changes apply from the next message.".into();
    project = runtime
        .save_project(project)
        .unwrap()
        .project
        .unwrap()
        .project;
    let source = fixture._directory.path().join("project.txt");
    fs::write(&source, "A file added during generation").unwrap();
    let added = runtime
        .projects
        .add_file(&runtime.history, project.id, &source, 4)
        .unwrap()
        .project
        .unwrap()
        .project;
    runtime
        .projects
        .remove_file(&runtime.history, project.id, added.files[0].id)
        .unwrap();
    assert!(runtime
        .move_project_chat(active.id, None)
        .unwrap_err()
        .contains("Available when the response ends."));
    assert!(runtime
        .delete_conversation(active.id)
        .unwrap_err()
        .contains("Available when the response ends."));
    assert!(runtime
        .delete_project(project.id, false)
        .unwrap_err()
        .contains("Available when the response ends."));
    project = runtime
        .projects
        .list(&runtime.history)
        .unwrap()
        .remove(0)
        .project;
    project.archived = true;
    assert!(runtime
        .save_project(project)
        .unwrap_err()
        .contains("Available when the response ends."));
    runtime.move_project_chat(other.id, None).unwrap();
    let recorded: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
    assert_eq!(recorded["messages"][0]["content"], snapshot);
    runtime.cancel(id).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        "stopped"
    );
    runtime.move_project_chat(active.id, None).unwrap();
    assert_eq!(
        runtime
            .history
            .list()
            .unwrap()
            .iter()
            .find(|chat| chat.id == active.id)
            .unwrap()
            .options
            .as_ref()
            .unwrap()
            .system_prompt
            .as_deref(),
        Some("Own prompt")
    );
    runtime.stop().unwrap();
}

#[tokio::test]
async fn unknown_capacity_rejection_preserves_upstream_type_and_complete_submitted_content() {
    let fixture = Fixture::new();
    fs::write(
        format!("{}.context-unavailable", fixture.record.display()),
        "",
    )
    .unwrap();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    let unavailable = runtime.server_details().await.unwrap();
    assert!(unavailable.context_size.is_none());
    let prefix = format!("Project instructions\n--- BEGIN ATTACHMENT \\\"notes.txt\\\" ---\n{}\n--- END ATTACHMENT \\\"notes.txt\\\" ---", "Full file ☕\n".repeat(3000));
    let user = "The complete user draft\n\ncontext-reject";
    let mut submitted = request(Uuid::new_v4(), user);
    submitted.messages.insert(
        0,
        ChatMessage {
            reasoning_content: None,
            role: "system".into(),
            content: prefix.clone(),
        },
    );
    let mut deltas = 0;
    let error = runtime
        .generate(submitted, |_| {
            deltas += 1;
            Ok(())
        })
        .await
        .unwrap_err();
    assert!(error.contains("exceed_context_size_error:"), "{error}");
    assert!(
        error.contains("request (5000 tokens) exceeds the available context size (4096 tokens)"),
        "{error}"
    );
    assert_eq!(deltas, 0);
    let recorded: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
    assert_eq!(recorded["stream"], true);
    assert_eq!(recorded["messages"][0]["content"], prefix);
    assert_eq!(recorded["messages"][1]["content"], user);
    assert_eq!(runtime.status().await.unwrap().phase, "ready");
    fs::remove_file(format!("{}.context-unavailable", fixture.record.display())).unwrap();
    let available = runtime.server_details().await.unwrap();
    assert_eq!(available.context_size, Some(4096));
    assert_eq!(available.run_id, unavailable.run_id);
    runtime.stop().unwrap();
}

#[tokio::test]
async fn corrupt_projects_report_storage_errors_without_disabling_server_controls() {
    let fixture = Fixture::new();
    let project_id = Uuid::new_v4();
    let directory = fixture.data.join("projects").join(project_id.to_string());
    fs::create_dir_all(&directory).unwrap();
    let record = directory.join("project.json");
    fs::write(&record, "broken project JSON").unwrap();
    let runtime = fixture.runtime();
    let chat = stored_chat(&runtime);
    let chat_path = fixture
        .data
        .join("conversations")
        .join(format!("{}.json", chat.id));
    let original_chat = fs::read(&chat_path).unwrap();
    assert!(runtime.inspect().is_ok());
    assert!(runtime
        .projects
        .list(&runtime.history)
        .unwrap_err()
        .contains("data was kept"));
    assert_eq!(runtime.history.list().unwrap().len(), 1);
    fixture.ready(&runtime).await;
    assert_eq!(runtime.status().await.unwrap().phase, "ready");
    runtime.stop().unwrap();
    assert_eq!(fs::read_to_string(record).unwrap(), "broken project JSON");
    assert_eq!(fs::read(chat_path).unwrap(), original_chat);
}

#[test]
fn unavailable_project_storage_and_failed_recovery_stay_at_storage_boundaries() {
    for recovery_error in [false, true] {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.data).unwrap();
        if recovery_error {
            let stage = fixture
                .data
                .join("projects/.transactions")
                .join(Uuid::new_v4().to_string());
            fs::create_dir_all(&stage).unwrap();
            fs::write(stage.join("operation.json"), "invalid recovery record").unwrap();
        } else {
            fs::write(fixture.data.join("projects"), "Unavailable directory").unwrap();
        }
        let runtime = fixture.runtime();
        assert!(runtime.inspect().is_ok());
        assert!(runtime.projects.list(&runtime.history).is_err());
        assert!(runtime.history.list().is_err());
        assert!(runtime.stop().is_ok());
    }
}

#[derive(Default)]
struct CountingSearch {
    calls: std::sync::atomic::AtomicUsize,
    offline: bool,
    slow: bool,
}
#[async_trait::async_trait]
impl straggler_desktop::web_search::provider::SearchProvider for CountingSearch {
    fn id(&self) -> straggler_desktop::web_search::types::ProviderId {
        straggler_desktop::web_search::types::ProviderId("test-search".into())
    }
    fn capabilities(&self) -> straggler_desktop::web_search::types::Capabilities {
        Default::default()
    }
    async fn verify(
        &self,
    ) -> std::result::Result<(), straggler_desktop::web_search::types::SearchError> {
        Ok(())
    }
    async fn search(
        &self,
        request: &straggler_desktop::web_search::types::SearchRequest,
    ) -> std::result::Result<
        straggler_desktop::web_search::types::SearchResponse,
        straggler_desktop::web_search::types::SearchError,
    > {
        use straggler_desktop::web_search::types::*;
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.slow {
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        if self.offline {
            return Err(SearchError::Offline);
        }
        Ok(SearchResponse {
            query: request.query.clone(),
            hits: vec![SearchHit::new(
                "Recorded source".into(),
                reqwest::Url::parse("https://example.org/source").unwrap(),
                "A recorded snippet.",
            )?],
            provider: self.id(),
            elapsed_ms: 0,
            cost_units: Some(1),
        })
    }
}

#[tokio::test]
async fn web_search_is_false_when_omitted_and_never_passes_tools_or_calls_the_provider() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.environment.clone(), fixture.data.clone()).unwrap();
    let provider = Arc::new(CountingSearch::default());
    runtime.web_search =
        straggler_desktop::web_search::WebSearchService::with_provider(provider.clone());
    fixture.ready(&runtime).await;
    let request: ChatRequest = serde_json::from_value(serde_json::json!({"requestId":Uuid::new_v4(), "messages":[{"role":"user","content":"Ordinary local question"}]})).unwrap();
    assert!(!request.web_search);
    runtime
        .generate(request, |delta| {
            assert!(delta.web_search.is_none());
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    let body: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
    assert!(body.get("tools").is_none());
    assert!(!body.to_string().contains("Web search is enabled"));
    let launch: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture._directory.path().join("launch.json")).unwrap())
            .unwrap();
    assert_eq!(launch["jinja"], true);
}

#[tokio::test]
async fn web_tools_stream_fragments_cache_and_limit_searches_without_affecting_normal_requests() {
    for tools_supported in [false, true] {
        let mut fixture = Fixture::new();
        if tools_supported {
            fixture
                .environment
                .variables
                .insert("TEST_TOOLS".into(), "1".into());
            fixture
                .environment
                .variables
                .insert("TEST_TOOL_ROUNDS".into(), "5".into());
        }
        let mut runtime = Runtime::new(fixture.environment.clone(), fixture.data.clone()).unwrap();
        let provider = Arc::new(CountingSearch::default());
        runtime.web_search =
            straggler_desktop::web_search::WebSearchService::with_provider(provider.clone());
        fixture.ready(&runtime).await;
        let mut request = request(
            Uuid::new_v4(),
            "Question plus private local attachment context",
        );
        request.web_search = true;
        request.web_search_query = Some("contract query".into());
        let mut summary = None;
        let mut sources = vec![];
        let mut events = vec![];
        runtime
            .generate(request, |delta| {
                if let Some(value) = delta.web_search {
                    summary = Some(value);
                }
                if let Some(value) = delta.sources {
                    sources = value;
                }
                events.extend(delta.web_events.into_iter().map(|event| event.name));
                Ok(())
            })
            .await
            .unwrap();
        let summary = summary.unwrap();
        assert_eq!(summary.fallback, !tools_supported);
        assert_eq!(summary.queries.len(), if tools_supported { 3 } else { 1 });
        assert!(summary
            .queries
            .iter()
            .all(|query| query == "contract query"));
        assert_eq!(summary.credits, 1);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].n, 1);
        assert!(events.contains(&"web_search:completed"));
        let turns: Vec<serde_json::Value> =
            fs::read_to_string(fixture.record.with_extension("json.turns"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        if tools_supported {
            assert_eq!(turns[0]["tools"][0]["function"]["name"], "web_search");
            assert_eq!(
                turns[1]["messages"].as_array().unwrap().last().unwrap()["tool_call_id"],
                "call_fixture"
            );
            assert!(turns
                .last()
                .unwrap()
                .to_string()
                .contains("Search limit reached"));
        } else {
            assert_eq!(turns.len(), 1);
            assert!(turns[0].get("tools").is_none());
            assert!(turns[0].to_string().contains("Recorded source"));
        }
    }
}

#[tokio::test]
async fn offline_web_search_still_generates_and_temporary_search_does_not_persist() {
    for offline in [false, true] {
        let fixture = Fixture::new();
        let mut runtime = Runtime::new(fixture.environment.clone(), fixture.data.clone()).unwrap();
        let provider = Arc::new(CountingSearch {
            offline,
            ..Default::default()
        });
        runtime.web_search =
            straggler_desktop::web_search::WebSearchService::with_provider(provider.clone());
        fixture.ready(&runtime).await;
        let temporary_id = Uuid::new_v4();
        runtime.begin_temporary(temporary_id).unwrap();
        wait_phase(&runtime, "ready").await;
        let before = stored_files(&fixture.data);
        let mut request = request(Uuid::new_v4(), "A temporary question");
        request.temporary_id = Some(temporary_id);
        request.web_search = true;
        let mut content = String::new();
        let mut errors = vec![];
        runtime
            .generate(request, |delta| {
                content.push_str(&delta.content);
                if let Some(summary) = delta.web_search {
                    errors = summary.errors;
                }
                Ok(())
            })
            .await
            .unwrap();
        assert!(!content.is_empty());
        assert_eq!(errors, if offline { vec!["offline"] } else { vec![] });
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(stored_files(&fixture.data), before);
    }
}

#[tokio::test]
async fn cancelling_remote_search_stops_the_turn_and_allows_the_next_local_response() {
    let fixture = Fixture::new();
    let mut runtime = Runtime::new(fixture.environment.clone(), fixture.data.clone()).unwrap();
    let provider = Arc::new(CountingSearch {
        slow: true,
        ..Default::default()
    });
    runtime.web_search =
        straggler_desktop::web_search::WebSearchService::with_provider(provider.clone());
    let runtime = Arc::new(runtime);
    fixture.ready(&runtime).await;
    let id = Uuid::new_v4();
    let mut pending = request(id, "Question");
    pending.web_search = true;
    let task_runtime = runtime.clone();
    let task = tokio::spawn(async move { task_runtime.generate(pending, |_| Ok(())).await });
    tokio::time::timeout(Duration::from_secs(5), async {
        while provider.calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    runtime.cancel(id).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        "stopped"
    );
    assert_eq!(
        runtime
            .generate(request(Uuid::new_v4(), "Local follow-up"), |_| Ok(()))
            .await
            .unwrap(),
        "complete"
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn owned_images_use_the_existing_server_and_require_advertised_vision() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let chat = stored_chat(&runtime);
    let source = fixture._directory.path().join("picture.png");
    image::DynamicImage::new_rgb8(64, 32).save(&source).unwrap();
    let chat = runtime.history.add_attachment(chat.id, &source).unwrap();
    fixture.ready(&runtime).await;
    let mut turn = request(Uuid::new_v4(), "Describe this image");
    turn.conversation_id = Some(chat.id);
    turn.image_ids = vec![chat.attachments[0].id];
    assert!(runtime
        .generate(turn, |_| Ok(()))
        .await
        .unwrap_err()
        .contains("can’t read images"));
    assert!(!fixture.record.exists());
    runtime.stop().unwrap();
    fs::write(fixture.record.with_extension("json.vision"), "true").unwrap();
    fixture.ready(&runtime).await;
    let mut turn = request(Uuid::new_v4(), "Describe this image");
    turn.conversation_id = Some(chat.id);
    turn.image_ids = vec![chat.attachments[0].id];
    runtime.generate(turn, |_| Ok(())).await.unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
    assert_eq!(body["messages"][0]["content"][0]["type"], "text");
    assert!(body["messages"][0]["content"][1]["image_url"]["url"]
        .as_str()
        .unwrap()
        .starts_with("data:image/png;base64,"));
    let mut forged = request(Uuid::new_v4(), "Unauthorized image");
    forged.conversation_id = Some(chat.id);
    forged.image_ids = vec![Uuid::new_v4()];
    assert!(runtime
        .generate(forged, |_| Ok(()))
        .await
        .unwrap_err()
        .contains("no longer in the chat"));
    runtime.stop().unwrap();
}

#[tokio::test]
async fn adjacent_projector_is_passed_to_the_supervised_server() {
    let fixture = Fixture::new();
    let projector = PathBuf::from(&fixture.model).with_file_name("projector.gguf");
    let mut bytes = b"GGUF".to_vec();
    bytes.extend(3u32.to_le_bytes());
    bytes.extend(0u64.to_le_bytes());
    bytes.extend(1u64.to_le_bytes());
    bytes.extend(12u64.to_le_bytes());
    bytes.extend(b"general.type");
    bytes.extend(8u32.to_le_bytes());
    bytes.extend(6u64.to_le_bytes());
    bytes.extend(b"mmproj");
    fs::write(&projector, bytes).unwrap();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    let launch: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture._directory.path().join("launch.json")).unwrap())
            .unwrap();
    assert_eq!(
        launch["mmproj"],
        projector.canonicalize().unwrap().to_str().unwrap()
    );
    assert!(launch["ctx_size"].is_null());
    assert!(launch["gpu_layers"].is_null());
    runtime.stop().unwrap();
}

#[tokio::test]
async fn saved_chat_defaults_reach_requests_without_restarting_or_applying_server_fields() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    fixture.ready(&runtime).await;
    let before = runtime.status().await.unwrap();
    let accepted = runtime.inspect().unwrap().settings;
    let mut patch = std::collections::BTreeMap::from([
        ("chat_system_prompt".into(), "A saved default".into()),
        ("chat_reasoning".into(), "off".into()),
    ]);
    for field in straggler_desktop::generation::fields() {
        patch.insert(field.into(), "1".into());
    }
    let saved = runtime.save_chat_defaults(patch).unwrap();
    assert_eq!(saved.settings.context, accepted.context);
    assert_eq!(saved.settings.threads, accepted.threads);
    assert_eq!(saved.settings.port, accepted.port);
    assert_eq!(
        saved.settings.chat_reasoning_effort,
        accepted.chat_reasoning_effort
    );
    assert!(!saved.restart_required);
    assert!(runtime
        .save_chat_defaults(std::collections::BTreeMap::from([(
            "port".into(),
            "1".into()
        )]))
        .is_err());
    let mut message = request(Uuid::new_v4(), "generation defaults");
    message.max_output_tokens = Some(32);
    runtime.generate(message, |_| Ok(())).await.unwrap();
    let recorded: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
    for field in straggler_desktop::generation::fields() {
        assert_eq!(recorded[field], if field == "max_tokens" { 32 } else { 1 });
    }
    let after = runtime.status().await.unwrap();
    assert_eq!(before.run_id, after.run_id);
    assert_eq!(before.running_settings, after.running_settings);
    runtime.stop().unwrap();
}

#[test]
fn reviewing_a_profile_saves_only_chat_defaults_and_preserves_the_server_review() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let initial = runtime.inspect().unwrap().settings;
    let profile = straggler_desktop::Settings {
        context: "8192".into(),
        temperature: "0.7".into(),
        chat_system_prompt: "Profile default".into(),
        ..initial.clone()
    };
    runtime.configure(profile.clone()).unwrap();
    runtime
        .workspace_action(
            "save-profile",
            vec!["Review example".into(), "new".into()],
            vec![],
        )
        .unwrap();
    runtime.configure(initial.clone()).unwrap();
    let reviewed = runtime.review_profile("Review example").unwrap();
    assert_eq!(reviewed.settings.context, initial.context);
    assert_eq!(reviewed.settings.temperature, profile.temperature);
    assert_eq!(
        reviewed.settings.chat_system_prompt,
        profile.chat_system_prompt
    );
    assert_eq!(reviewed.saved_settings, Some(profile.clone()));
    assert_eq!(runtime.preview_profile("Review example").unwrap(), profile);
    assert_eq!(runtime.inspect().unwrap().settings.context, initial.context);
}
