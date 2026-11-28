use super::*;
use crate::{configuration::environment::Environment, ChatMessage, ChatRequest, Runtime};
use std::os::unix::process::CommandExt;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::atomic::{AtomicBool, Ordering},
    thread,
};

struct HttpFixture {
    base: String,
    reply: Arc<Mutex<(u16, String, String)>>,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
use serde_json::{json, Value};
impl HttpFixture {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let reply: Arc<Mutex<(u16, String, String)>> = Arc::new(Mutex::new((200, "".into(), r#"{"data":[{"id":"example","context_length":8192,"architecture":{"input_modalities":["text","image"]},"supported_parameters":["tools","reasoning","max_tokens"],"max_context_length":4096,"capabilities":{"vision":false,"function_calling":true}}]}"#.into())));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (response, record, done) = (reply.clone(), requests.clone(), stop.clone());
        let worker = thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let Ok((mut socket, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                };
                // Accepted sockets can inherit nonblocking mode on macOS.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let (head_end, length) = loop {
                    let count = socket
                        .read(&mut buffer)
                        .expect("Cannot read fixture request");
                    if count == 0 {
                        break (bytes.len(), 0);
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        break (end + 4, length);
                    }
                };
                while bytes.len() < head_end + length {
                    let count = socket
                        .read(&mut buffer)
                        .expect("Cannot read fixture request");
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                let path = String::from_utf8_lossy(&bytes)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                let body = serde_json::from_slice(&bytes[head_end..]).unwrap_or(Value::Null);
                record.lock().unwrap().push((path, body.clone())); // Never retain Authorization headers.
                let (status, headers, mut response_body) = response.lock().unwrap().clone();
                if headers.contains("X-Fixture-Tools")
                    && body["messages"]
                        .as_array()
                        .and_then(|messages| messages.last())
                        .is_some_and(|last| last["role"] != "tool")
                {
                    response_body = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Tool reasoning\",\"tool_calls\":[{\"index\":0,\"id\":\"call1\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{\\\"query\\\":\\\"test evidence\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n".into();
                }
                let body = response_body;
                let wire = format!("HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len() + if headers.contains("X-Fixture-Hold") {1024} else {0});
                let _ = socket.write_all(wire.as_bytes());
                if headers.contains("X-Fixture-Hold") {
                    while !done.load(Ordering::Relaxed) {
                        thread::sleep(Duration::from_millis(2));
                    }
                }
            }
        });
        Self {
            base,
            reply,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn respond(&self, status: u16, headers: &str, body: &str) {
        *self.reply.lock().unwrap() = (status, headers.into(), body.into());
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn service(root: &std::path::Path, fixture: &HttpFixture) -> CloudService {
    CloudService::loopback_fixture(root.into(), Some(&fixture.base)).unwrap()
}
async fn configured(service: &CloudService, id: &str) -> Selection {
    service
        .save_key(id, Some(Uuid::new_v4().to_string()))
        .await
        .unwrap();
    service.show_models(id, vec!["example".into()]).unwrap();
    Selection {
        provider_id: id.into(),
        model_id: "example".into(),
    }
}

#[derive(Default)]
struct BlockingCloudKeys {
    keys: credentials::MemoryCloudKeys,
    fail_reads: Arc<AtomicBool>,
    fail_writes: Arc<AtomicBool>,
}

struct BlockingTokenStore {
    store: Arc<dyn crate::huggingface::credentials::TokenStore>,
    fail_reads: Arc<AtomicBool>,
    fail_writes: Arc<AtomicBool>,
}

fn run_keychain_runtime() {
    // The Linux blocking keychain API drives its own runtime, even during reads.
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(async {});
}

impl CloudKeys for BlockingCloudKeys {
    fn store(&self, id: &str) -> Arc<dyn crate::huggingface::credentials::TokenStore> {
        Arc::new(BlockingTokenStore {
            store: self.keys.store(id),
            fail_reads: self.fail_reads.clone(),
            fail_writes: self.fail_writes.clone(),
        })
    }
}

impl crate::huggingface::credentials::TokenStore for BlockingTokenStore {
    fn read(&self) -> Result<Option<String>> {
        run_keychain_runtime();
        if self.fail_reads.load(Ordering::Relaxed) {
            return Err("Fixture keychain read failed.".into());
        }
        self.store.read()
    }

    fn write(&self, key: Option<&str>) -> Result<()> {
        run_keychain_runtime();
        if self.fail_writes.load(Ordering::Relaxed) {
            return Err("Fixture keychain write failed.".into());
        }
        self.store.write(key)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_key_lifecycle_isolates_blocking_keychain_and_reports_storage_errors() {
    let root = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::new();
    let mut service = service(root.path(), &fixture);
    let keys = Arc::new(BlockingCloudKeys::default());
    service.keys = keys.clone();

    let status = service
        .save_key("deepseek", Some("first-key".into()))
        .await
        .unwrap();
    assert_eq!(
        status.generation_parameters,
        crate::generation::provider_parameters()
    );
    assert!(status.providers[0].saved);
    assert!(!status.providers[1].saved);
    assert_eq!(status.providers[0].provider.models[0].id, "example");
    assert!(service.refresh("deepseek").await.unwrap().providers[0].saved);

    keys.fail_writes.store(true, Ordering::Relaxed);
    assert_eq!(
        service
            .save_key("deepseek", Some("replacement-key".into()))
            .await
            .err()
            .unwrap(),
        "Fixture keychain write failed."
    );
    assert_eq!(
        service.save_key("deepseek", None).await.err().unwrap(),
        "Fixture keychain write failed."
    );
    assert_eq!(
        keys.keys.store("deepseek").read().unwrap().as_deref(),
        Some("first-key")
    );
    keys.fail_writes.store(false, Ordering::Relaxed);

    keys.fail_reads.store(true, Ordering::Relaxed);
    let status = service
        .save_key("deepseek", Some("replacement-key".into()))
        .await
        .unwrap();
    assert!(!status.providers[0].saved);
    assert_eq!(
        status.providers[0].key_error.as_deref(),
        Some("Fixture keychain read failed.")
    );
    assert_eq!(
        service.refresh("deepseek").await.err().unwrap(),
        "Fixture keychain read failed."
    );
    keys.fail_reads.store(false, Ordering::Relaxed);

    let count = fixture.count();
    assert!(!service.save_key("deepseek", None).await.unwrap().providers[0].saved);
    assert!(!service.save_key("deepseek", None).await.unwrap().providers[0].saved);
    assert!(service
        .refresh("deepseek")
        .await
        .err()
        .unwrap()
        .contains("API key"));
    assert_eq!(fixture.count(), count);
}

#[tokio::test]
async fn cloud_generation_reads_blocking_keychain_without_a_nested_runtime() {
    let root = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::new();
    let mut runtime = runtime(root.path(), &fixture);
    let keys = Arc::new(BlockingCloudKeys::default());
    runtime.cloud.keys = keys.clone();
    runtime
        .cloud
        .save_key("deepseek", Some("fixture-key".into()))
        .await
        .unwrap();
    let runtime = Arc::new(runtime);
    let selection = Selection {
        provider_id: "deepseek".into(),
        model_id: "example".into(),
    };
    let worker = runtime.clone();
    let selected = selection.clone();
    tokio::task::spawn_blocking(move || {
        worker
            .cloud
            .show_models("deepseek", vec!["example".into()])?;
        worker.choose_cloud_model(selected)
    })
    .await
    .unwrap()
    .unwrap();
    let mut preferences = runtime.preferences.read().unwrap();
    preferences
        .cloud_notice_seen
        .insert("deepseek".into(), "https://api.deepseek.com".into());
    runtime.preferences.save(&preferences).unwrap();
    fixture.respond(200, "Content-Type: text/event-stream\r\n", "data: {\"choices\":[{\"delta\":{\"content\":\"Answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
    let mut text = String::new();
    assert_eq!(
        runtime
            .generate(request(selection.clone()), |delta| {
                text.push_str(&delta.content);
                Ok(())
            })
            .await
            .unwrap(),
        "complete"
    );
    assert_eq!(text, "Answer");
    keys.fail_reads.store(true, Ordering::Relaxed);
    let count = fixture.count();
    assert_eq!(
        runtime
            .generate(request(selection), |_| Ok(()))
            .await
            .unwrap_err(),
        "Fixture keychain read failed."
    );
    assert_eq!(fixture.count(), count);
}

#[tokio::test]
async fn model_metadata_round_trip_key_rejection_and_corrupt_file_are_transactional() {
    let root = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::new();
    let service = service(root.path(), &fixture);
    assert_eq!(service.status().unwrap().providers.len(), 3);
    assert_eq!(fixture.count(), 0);
    for id in ["deepseek", "openrouter", "mistral"] {
        let selection = configured(&service, id).await;
        let model = service.choose(&selection).unwrap().model;
        match id {
            "deepseek" => {
                assert!(model.details.context_size.is_none());
                assert!(model.details.tools_supported.is_none());
            }
            "openrouter" => {
                assert_eq!(model.details.context_size, Some(8192));
                assert_eq!(model.details.vision_supported, Some(true));
            }
            _ => {
                assert_eq!(model.details.context_size, Some(4096));
                assert_eq!(model.details.vision_supported, Some(false));
                assert_eq!(model.details.tools_supported, Some(true));
            }
        }
    }
    let previous = service.keys.store("deepseek").read().unwrap();
    fixture.respond(401, "", "ignored upstream error");
    let error = service
        .save_key("deepseek", Some(Uuid::new_v4().to_string()))
        .await
        .err()
        .unwrap();
    assert!(error.contains("previous key was kept"));
    assert!(service.keys.store("deepseek").read().unwrap() == previous);
    let saved = fs::read_to_string(&service.path).unwrap();
    assert!(!saved.contains(previous.as_ref().unwrap()));
    assert_eq!(service.read().unwrap()[0].shown, vec!["example"]);
    fs::write(&service.path, "unreadable JSON").unwrap();
    let status = service.status().unwrap();
    assert!(status.error.is_some());
    assert_eq!(
        status.generation_parameters,
        crate::generation::provider_parameters()
    );
    assert!(service
        .add_custom("Example".into(), "https://example.org/v1".into())
        .is_err());
    assert_eq!(
        fs::read_to_string(&service.path).unwrap(),
        "unreadable JSON"
    );
}

#[tokio::test]
async fn urls_redirects_status_errors_and_retry_after_never_echo_upstream_data() {
    for value in [
        "http://example.org",
        "https://user:password@example.org",
        "https://example.org/?key=value",
        "file:///tmp/a",
        "https://example.org/#key",
    ] {
        assert!(validate_base_url(value).is_err());
    }
    for value in [
        "https://example.org/v1",
        "http://127.0.0.1:1234/v1",
        "http://[::1]:1234",
    ] {
        assert!(validate_base_url(value).is_ok());
    }
    let root = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::new();
    let service = service(root.path(), &fixture);
    for (status, expected) in [
        (401, "API key"),
        (402, "credit"),
        (500, "temporarily unavailable"),
        (302, "302"),
    ] {
        fixture.respond(
            status,
            "Location: http://127.0.0.1:1/other\r\n",
            "PRIVATE-UPSTREAM-DATA",
        );
        let error = service
            .save_key("deepseek", Some(Uuid::new_v4().to_string()))
            .await
            .err()
            .unwrap();
        assert!(error.contains(expected));
        assert!(!error.contains("PRIVATE-UPSTREAM"));
    }
    assert_eq!(fixture.count(), 4);
    let date = httpdate::fmt_http_date(std::time::SystemTime::now() + Duration::from_secs(60));
    for (id, retry) in [("deepseek", "60".to_owned()), ("mistral", date)] {
        fixture.respond(429, &format!("Retry-After: {retry}\r\n"), "ignored");
        assert!(service
            .save_key(id, Some(Uuid::new_v4().to_string()))
            .await
            .err()
            .unwrap()
            .contains("Try again in a moment"));
        let count = fixture.count();
        assert!(service
            .save_key(id, Some(Uuid::new_v4().to_string()))
            .await
            .is_err());
        assert_eq!(fixture.count(), count);
    }
    let endpoint = fixture.base.clone();
    drop(fixture);
    let offline =
        CloudService::loopback_fixture(root.path().join("offline"), Some(&endpoint)).unwrap();
    assert!(offline
        .save_key("deepseek", Some(Uuid::new_v4().to_string()))
        .await
        .err()
        .unwrap()
        .contains("connection"));
}

fn runtime(root: &std::path::Path, fixture: &HttpFixture) -> Runtime {
    let environment = Environment::from_variables(
        std::collections::BTreeMap::from([("HOME".into(), root.as_os_str().to_owned())]),
        None,
    )
    .unwrap();
    let mut runtime = Runtime::new(environment, root.join("data")).unwrap();
    runtime.cloud = service(&root.join("data"), fixture);
    runtime
}
fn request(selection: Selection) -> ChatRequest {
    ChatRequest {
        max_output_tokens: None,
        request_id: Uuid::new_v4(),
        conversation_id: None,
        temporary_id: None,
        web_search: false,
        web_search_query: None,
        cloud: Some(selection),
        image_ids: vec![],
        options: Default::default(),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: "A question".into(),
            reasoning_content: None,
        }],
    }
}
#[tokio::test]
async fn cloud_generation_requires_consent_but_no_local_server_or_temporary_slots() {
    for id in ["deepseek", "openrouter", "mistral"] {
        let root = tempfile::tempdir().unwrap();
        let fixture = HttpFixture::new();
        let runtime = runtime(root.path(), &fixture);
        let selection = configured(&runtime.cloud, id).await;
        let status = runtime.choose_cloud_model(selection.clone()).unwrap();
        assert!(status.active.unwrap().output_limit_supported);
        let count = fixture.count();
        assert!(runtime
            .generate(request(selection.clone()), |_| Ok(()))
            .await
            .unwrap_err()
            .contains("first-send notice"));
        assert_eq!(fixture.count(), count);
        let mut prefs = runtime.preferences.read().unwrap();
        prefs
            .cloud_notice_seen
            .insert(id.into(), runtime.cloud.active().unwrap().unwrap().base_url);
        runtime.preferences.save(&prefs).unwrap();
        let wire = "data: {\"choices\":[{\"delta\":{\"content\":\"Answer\",\"reasoning_content\":\"Reason\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"usage\":{\"total_tokens\":12,\"completion_tokens\":3,\"cost\":0.01}}\n\ndata: [DONE]\n\n";
        let wire = match id {
            "openrouter" => wire.replace("reasoning_content", "reasoning"),
            "mistral" => wire.replace("\"content\":\"Answer\",\"reasoning_content\":\"Reason\"", "\"content\":[{\"type\":\"thinking\",\"thinking\":[{\"type\":\"text\",\"text\":\"Reason\"}]},{\"type\":\"text\",\"text\":\"Answer\"}]"),
            _ => wire.into(),
        };
        fixture.respond(200, "Content-Type: text/event-stream\r\n", &wire);
        let count = fixture.count();
        let mut invalid = request(selection.clone());
        invalid.max_output_tokens = Some(0);
        assert!(runtime
            .generate(invalid, |_| Ok(()))
            .await
            .unwrap_err()
            .contains("positive"));
        assert_eq!(fixture.count(), count);
        let mut bounded = request(selection.clone());
        bounded.max_output_tokens = Some(17);
        let mut content = String::new();
        let mut reasoning = String::new();
        assert_eq!(
            runtime
                .generate(bounded, |delta| {
                    content.push_str(&delta.content);
                    reasoning.push_str(&delta.reasoning);
                    Ok(())
                })
                .await
                .unwrap(),
            "complete"
        );
        assert_eq!(content, "Answer");
        assert_eq!(reasoning, "Reason");
        let body = &fixture.requests.lock().unwrap().last().unwrap().1.clone();
        assert_eq!(body["max_tokens"], 17);
        for field in [
            "chat_template_kwargs",
            "id_slot",
            "cache_prompt",
            "timings_per_token",
        ] {
            assert!(body.get(field).is_none());
        }
        let temporary = Uuid::new_v4();
        runtime.begin_temporary(temporary).unwrap();
        let mut turn = request(selection);
        turn.temporary_id = Some(temporary);
        assert_eq!(
            runtime.generate(turn, |_| Ok(())).await.unwrap(),
            "complete"
        );
        runtime.finish_temporary(temporary, None, false).unwrap();
        assert_eq!(runtime.status().await.unwrap().phase, "stopped");
    }
}

#[tokio::test]
async fn openrouter_rejects_an_unsupported_explicit_output_limit_before_sending() {
    let root = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::new();
    fixture.respond(
        200,
        "Content-Type: application/json\r\n",
        r#"{"data":[{"id":"example","context_length":8192,"supported_parameters":["temperature"]}]}"#,
    );
    let runtime = runtime(root.path(), &fixture);
    let selection = configured(&runtime.cloud, "openrouter").await;
    let active = runtime
        .choose_cloud_model(selection.clone())
        .unwrap()
        .active
        .unwrap();
    assert!(!active.output_limit_supported);
    let mut preferences = runtime.preferences.read().unwrap();
    preferences
        .cloud_notice_seen
        .insert(selection.provider_id.clone(), active.base_url);
    runtime.preferences.save(&preferences).unwrap();

    let count = fixture.count();
    let mut bounded = request(selection.clone());
    bounded.max_output_tokens = Some(128);
    assert_eq!(
        runtime.generate(bounded, |_| Ok(())).await.unwrap_err(),
        "The selected cloud model does not support a response token limit."
    );
    assert_eq!(fixture.count(), count);

    fixture.respond(
        200,
        "Content-Type: text/event-stream\r\n",
        "data: [DONE]\n\n",
    );
    assert_eq!(
        runtime
            .generate(request(selection), |_| Ok(()))
            .await
            .unwrap(),
        "complete"
    );
    assert_eq!(fixture.count(), count + 1);
    assert!(fixture
        .requests
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .1
        .get("max_tokens")
        .is_none());
}

#[test]
fn provider_reasoning_adapters_strip_local_fields_and_keep_deepseek_tool_history() {
    for (id, kind) in [
        ("deepseek", ProviderKind::DeepSeek),
        ("openrouter", ProviderKind::OpenRouter),
        ("mistral", ProviderKind::Mistral),
    ] {
        let mut details = models::unknown_details();
        details.reasoning_supported = Some(true);
        details.effort_levels = vec!["high".into()];
        let destination = CloudDestination {
            key: Uuid::new_v4().to_string(),
            active: ActiveCloud {
                selection: Selection {
                    provider_id: id.into(),
                    model_id: "example".into(),
                },
                provider_name: id.into(),
                base_url: "https://example.org".into(),
                kind,
                output_limit_supported: true,
                model: CloudModel {
                    id: "example".into(),
                    name: "Example".into(),
                    details,
                    supported_parameters: None,
                },
            },
        };
        let mut body = json!({"messages":[{"role":"user","content":"Question"},{"role":"assistant","content":"Earlier","reasoning_content":"Earlier reasoning"},{"role":"assistant","content":"Tool round"}],"tools":[],"id_slot":0,"cache_prompt":true,"chat_template_kwargs":{},"timings_per_token":true});
        requests::reasoning(&mut body, &destination, "on", "high").unwrap();
        assert!(body
            .get(if kind == ProviderKind::OpenRouter {
                "reasoning"
            } else {
                "reasoning_effort"
            })
            .is_some());
        let wire = requests::wire_body(&body, &destination);
        assert!(wire.get("id_slot").is_none());
        if kind == ProviderKind::DeepSeek {
            assert_eq!(
                wire["messages"][1]["reasoning_content"],
                "Earlier reasoning"
            );
            assert_eq!(wire["messages"][2]["reasoning_content"], "");
        } else {
            assert!(wire["messages"][1].get("reasoning_content").is_none());
        }
        body.as_object_mut().unwrap().remove("tools");
        assert!(requests::wire_body(&body, &destination)["messages"][1]
            .get("reasoning_content")
            .is_none());
    }
}

#[tokio::test]
async fn cancellation_keeps_partial_text_and_cloud_selection_only_stops_owned_processes() {
    let root = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::new();
    let runtime = runtime(root.path(), &fixture);
    let selection = configured(&runtime.cloud, "openrouter").await;
    let mut unrelated = std::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .unwrap();
    let owned = std::process::Command::new("sleep")
        .arg("60")
        .process_group(0)
        .spawn()
        .unwrap();
    runtime.server.lock().unwrap().child = Some(owned);
    runtime.choose_cloud_model(selection.clone()).unwrap();
    assert!(runtime.server.lock().unwrap().child.is_none());
    assert!(unrelated.try_wait().unwrap().is_none());
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
    let mut prefs = runtime.preferences.read().unwrap();
    prefs
        .cloud_notice_seen
        .insert("openrouter".into(), "https://openrouter.ai/api/v1".into());
    runtime.preferences.save(&prefs).unwrap();
    fixture.respond(
        200,
        "Content-Type: text/event-stream\r\nX-Fixture-Hold: true\r\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Partial\"}}]}\n\n",
    );
    let turn = request(selection.clone());
    let id = turn.request_id;
    let mut text = String::new();
    assert_eq!(
        runtime
            .generate(turn, |delta| {
                text.push_str(&delta.content);
                assert!(runtime.choose_cloud_model(selection.clone()).is_err());
                runtime.cancel(id)?;
                Ok(())
            })
            .await
            .unwrap(),
        "stopped"
    );
    assert_eq!(text, "Partial");
}

#[tokio::test]
async fn deepseek_tool_rounds_replay_all_reasoning_from_history() {
    let root = tempfile::tempdir().unwrap();
    let fixture = HttpFixture::new();
    let mut runtime = runtime(root.path(), &fixture);
    runtime.web_search = crate::web_search::WebSearchService::with_provider(Arc::new(
        crate::web_search::providers::mock::MockProvider::default(),
    ));
    let selection = configured(&runtime.cloud, "deepseek").await;
    runtime.choose_cloud_model(selection.clone()).unwrap();
    // Synthetic explicit metadata exercises the adapter; ID-only production lists stay unknown.
    runtime
        .cloud
        .active
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .model
        .details
        .tools_supported = Some(true);
    let mut prefs = runtime.preferences.read().unwrap();
    prefs
        .cloud_notice_seen
        .insert("deepseek".into(), "https://api.deepseek.com".into());
    runtime.preferences.save(&prefs).unwrap();
    fixture.respond(200, "Content-Type: text/event-stream\r\nX-Fixture-Tools: true\r\n", "data: {\"choices\":[{\"delta\":{\"content\":\"Final answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
    let mut turn = request(selection);
    turn.web_search = true;
    turn.messages.insert(
        0,
        ChatMessage {
            role: "assistant".into(),
            content: "Earlier answer".into(),
            reasoning_content: Some("Earlier reasoning".into()),
        },
    );
    assert_eq!(
        runtime.generate(turn, |_| Ok(())).await.unwrap(),
        "complete"
    );
    let calls = fixture.requests.lock().unwrap();
    let posts: Vec<_> = calls
        .iter()
        .filter(|(path, _)| path.starts_with("POST"))
        .collect();
    assert_eq!(posts.len(), 2);
    for (_, body) in &posts {
        assert_eq!(
            body["messages"][0]["reasoning_content"],
            "Earlier reasoning"
        );
    }
    let tool_turn = posts[1].1["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message.get("tool_calls").is_some())
        .unwrap();
    assert_eq!(tool_turn["reasoning_content"], "Tool reasoning");
}
