use crate::{stream, ChatRequest, Result, Runtime};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const CONTEXT_SIZE_ERROR: &str = "exceed_context_size_error";

enum Destination {
    Local {
        url: String,
        run: Uuid,
        failed: CancellationToken,
    },
    Cloud(Box<crate::cloud::CloudDestination>),
}

async fn local_request_error(response: reqwest::Response, temporary: bool) -> String {
    let status = response.status();
    let temporary_error = || {
        format!(
            "Temporary model request failed ({status}). The backend did not accept the request."
        )
    };
    if temporary && status != reqwest::StatusCode::BAD_REQUEST {
        return temporary_error();
    }

    let read_body = async {
        let mut chunks = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            body.extend_from_slice(&chunk[..chunk.len().min(16384 - body.len())]);
            if body.len() == 16384 {
                break;
            }
        }
        Ok::<_, reqwest::Error>(body)
    };
    let body = if temporary {
        // Recover the known error code without exposing private response text or waiting
        // indefinitely for an error body.
        match tokio::time::timeout(Duration::from_secs(3), read_body).await {
            Ok(Ok(body)) => body,
            _ => return temporary_error(),
        }
    } else {
        match read_body.await {
            Ok(body) => body,
            Err(error) => return error.to_string(),
        }
    };
    let parsed: Option<Value> = serde_json::from_slice(&body).ok();
    let error = parsed.as_ref().and_then(|value| value.get("error"));
    let context_rejected = error.is_some_and(|error| error["type"] == CONTEXT_SIZE_ERROR);
    if temporary {
        return if context_rejected {
            format!("{CONTEXT_SIZE_ERROR}: The prompt exceeds the available context size.")
        } else {
            temporary_error()
        };
    }

    let detail = match error.and_then(|error| error["message"].as_str()) {
        Some(message) if context_rejected => format!("{CONTEXT_SIZE_ERROR}: {message}"),
        Some(message) => message.to_owned(),
        None => String::from_utf8_lossy(&body).into_owned(),
    };
    format!("Model request failed ({status}): {detail}")
}

impl Runtime {
    pub fn cancel(&self, id: Uuid) -> Result<()> {
        let mut generation = self.active.lock().map_err(|e| e.to_string())?;
        if let Some((active, token)) = generation.current.as_ref() {
            if *active == id {
                token.cancel();
            }
        }
        // Cancellation may arrive before the async generate command is polled.
        generation.cancelled = Some(id);
        Ok(())
    }

    pub async fn generate(
        &self,
        request: ChatRequest,
        mut emit: impl FnMut(stream::Delta) -> Result<()>,
    ) -> Result<String> {
        self.validate_temporary_request(request.temporary_id, request.conversation_id)?;
        if request.messages.is_empty()
            || request
                .messages
                .iter()
                .any(|m| !matches!(m.role.as_str(), "system" | "user" | "assistant"))
        {
            return Err("A chat request needs valid messages.".into());
        }
        let token = CancellationToken::new();
        let cloud = match &request.cloud {
            Some(selection) => Some(self.cloud.destination(selection).await?),
            None => None,
        };
        if let Some(cloud) = &cloud {
            let preferences = self.preferences.read()?;
            if preferences
                .cloud_notice_seen
                .get(&cloud.active.selection.provider_id)
                != Some(&cloud.active.base_url)
            {
                return Err(format!(
                    "Review and continue the first-send notice for {} before sending this chat.",
                    cloud.active.provider_name
                ));
            }
        }
        let destination = {
            let mut active = self.active.lock().map_err(|e| e.to_string())?;
            if active.cancelled == Some(request.request_id) {
                active.cancelled = None;
                return Ok("stopped".into());
            }
            if active.current.is_some() {
                return Err("A response is already being generated.".into());
            }
            if let Some(id) = request.conversation_id {
                let _guard = self
                    .history
                    .writer
                    .lock()
                    .map_err(|error| error.to_string())?;
                self.history.recover()?;
                let conversation = self.history.read_one(id)?;
                if let Some(project) = conversation.project_id {
                    crate::projects::ensure_active_at(&self.history.project_directory()?, project)?;
                }
            }
            let destination = if let Some(cloud) = cloud {
                Destination::Cloud(Box::new(cloud))
            } else {
                let state = self.server.lock().map_err(|e| e.to_string())?;
                if state.diagnostics.issue.is_some() {
                    return Err(
                        "The local server needs to be restarted before another request.".into(),
                    );
                }
                if state.phase != "ready" {
                    return Err("Wait until the local model is Ready.".into());
                }
                if request.temporary_id.is_some() && !state.temporary {
                    return Err("Restart the backend in temporary mode before sending.".into());
                }
                Destination::Local {
                    url: state
                        .url
                        .clone()
                        .ok_or("The server address is unavailable.")?,
                    run: state.run,
                    failed: state.diagnostics.failed.clone(),
                }
            };
            active.current = Some((request.request_id, token.clone()));
            active.conversation_id = request.conversation_id;
            destination
        };
        let result = match &destination {
            Destination::Local { failed, .. } => tokio::select! {
                biased;
                _ = failed.cancelled() => Err("The inference backend cannot continue. Check the server log and restart it.".into()),
                _ = token.cancelled() => Ok("stopped".into()),
                result = self.receive(&destination, &request, &mut emit) => result,
            },
            Destination::Cloud(_) => tokio::select! {
                biased;
                _ = token.cancelled() => Ok("stopped".into()),
                result = self.receive(&destination, &request, &mut emit) => result,
            },
        };
        if let Destination::Local { run, .. } = &destination {
            let mut state = self.server.lock().map_err(|e| e.to_string())?;
            if state.run == *run {
                match &result {
                    Err(detail) => state.diagnostics.request_failed(detail),
                    Ok(status) if matches!(status.as_str(), "complete" | "length") => {
                        state.diagnostics.request_succeeded()
                    }
                    _ => {}
                }
            }
        }
        let mut active = self.active.lock().map_err(|e| e.to_string())?;
        active.current = None;
        active.conversation_id = None;
        result
    }

    async fn receive(
        &self,
        destination: &Destination,
        request: &ChatRequest,
        emit: &mut impl FnMut(stream::Delta) -> Result<()>,
    ) -> Result<String> {
        let mut body = json!({
            "messages": request.messages,
            "stream": true,
            "stream_options": {"include_usage": true},
        });
        let settings = self.generation_settings()?;
        let (provider, supported) = match destination {
            Destination::Local { .. } => (None, None),
            Destination::Cloud(cloud) => (
                Some(cloud.active.kind),
                cloud.active.model.supported_parameters.as_deref(),
            ),
        };
        body.as_object_mut()
            .expect("Chat bodies are objects")
            .extend(crate::generation::parameters(
                &settings,
                provider,
                supported,
                request.max_output_tokens,
            )?);
        match destination {
            Destination::Local { .. } => body["timings_per_token"] = json!(true),
            Destination::Cloud(cloud) => body["model"] = json!(cloud.active.model.id),
        }
        if !request.image_ids.is_empty() {
            if self
                .destination_details(destination)
                .await?
                .vision_supported
                != Some(true)
            {
                return Err(
                    "This model can’t read images. Choose a vision model or remove the images."
                        .into(),
                );
            }
            let originals = self.image_originals(request)?;
            let index = request
                .messages
                .iter()
                .rposition(|message| message.role == "user")
                .ok_or("Images need a user message.")?;
            let mut parts = vec![json!({"type": "text", "text": request.messages[index].content})];
            for original in originals {
                let data = tokio::task::spawn_blocking(move || {
                    crate::image_attachments::prepare(&original)
                })
                .await
                .map_err(|error| error.to_string())??
                .1;
                parts.push(json!({"type": "image_url", "image_url": {"url": data}}));
            }
            body["messages"][index]["content"] = json!(parts);
        }
        if let (Some(id), Destination::Local { url, run, .. }) = (request.temporary_id, destination)
        {
            body["id_slot"] = json!(self.temporary_slot(id, url, *run).await?);
            body["cache_prompt"] = json!(false);
        }
        let reasoning = request.options.reasoning.as_deref().unwrap_or("auto");
        let effort = request.options.effort.as_deref().unwrap_or("auto");
        if !matches!(reasoning, "auto" | "on" | "off") {
            return Err("Reasoning must use the model default, on or off.".into());
        }
        match destination {
            Destination::Cloud(cloud) => {
                crate::cloud::requests::reasoning(&mut body, cloud, reasoning, effort)?
            }
            Destination::Local { .. } => {
                let has_system_prompt = request.messages.iter().any(|m| m.role == "system");
                if reasoning != "auto" || effort != "auto" || has_system_prompt {
                    let details = self.destination_details(destination).await?;
                    if has_system_prompt && details.system_role_supported == Some(false) {
                        return Err(
                            "The loaded chat template does not support a system prompt.".into()
                        );
                    }
                    if reasoning != "auto" && details.reasoning_supported != Some(true) {
                        return Err(
                            "Reasoning controls are unavailable for this server and chat template."
                                .into(),
                        );
                    }
                    if reasoning != "off"
                        && effort != "auto"
                        && !details.effort_levels.iter().any(|level| level == effort)
                    {
                        return Err("The selected reasoning effort is not advertised by the loaded chat template. Choose its default or a supported level.".into());
                    }
                }
                if reasoning != "auto" {
                    body["chat_template_kwargs"] = json!({"enable_thinking": reasoning == "on"});
                }
                if reasoning == "off" {
                    body["reasoning_effort"] = json!("none");
                } else if effort != "auto" {
                    body["reasoning_effort"] = json!(effort);
                }
            }
        }
        if request.web_search {
            return self
                .receive_with_search(destination, request, body, emit)
                .await;
        }
        let (status, calls, _, _) = self.receive_step(destination, request, &body, emit).await?;
        if !calls.is_empty() {
            return Err("The model returned tools that were not enabled for this message.".into());
        }
        Ok(status)
    }

    async fn destination_details(
        &self,
        destination: &Destination,
    ) -> Result<crate::model::ServerDetails> {
        match destination {
            Destination::Local { .. } => self.server_details().await,
            Destination::Cloud(cloud) => Ok(cloud.active.model.details.clone()),
        }
    }

    fn image_originals(&self, request: &ChatRequest) -> Result<Vec<Vec<u8>>> {
        if let Some(id) = request.temporary_id {
            let session = self.temporary.lock().map_err(|error| error.to_string())?;
            let session = session
                .as_ref()
                .filter(|session| session.id == id && !session.ending)
                .ok_or("The temporary chat is no longer available.")?;
            return request
                .image_ids
                .iter()
                .map(|id| {
                    session
                        .originals
                        .get(id)
                        .filter(|file| file.attachment.image.is_some())
                        .map(|file| file.original.clone())
                        .ok_or_else(|| "This image is no longer in the chat.".into())
                })
                .collect();
        }
        let id = request
            .conversation_id
            .ok_or("Images need a saved chat identifier.")?;
        let _guard = self
            .history
            .writer
            .lock()
            .map_err(|error| error.to_string())?;
        self.history.recover()?;
        let chat = self.history.read_one(id)?;
        request
            .image_ids
            .iter()
            .map(|id| {
                let attachment = chat
                    .attachments
                    .iter()
                    .find(|attachment| attachment.id == *id && attachment.image.is_some())
                    .ok_or("This image is no longer in the chat.")?;
                use std::io::Read;
                let file = std::fs::File::open(self.history.original_path(chat.id, attachment))
                    .map_err(|error| format!("Cannot read the stored image: {error}"))?;
                let mut bytes = Vec::new();
                file.take(crate::attachments::MAX_FILE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| error.to_string())?;
                if bytes.len() as u64 > crate::attachments::MAX_FILE_BYTES {
                    return Err("This image exceeds the attachment size limit.".into());
                }
                Ok(bytes)
            })
            .collect()
    }

    async fn receive_step(
        &self,
        destination: &Destination,
        request: &ChatRequest,
        body: &Value,
        emit: &mut impl FnMut(stream::Delta) -> Result<()>,
    ) -> Result<(String, Vec<stream::ToolCall>, String, String)> {
        let mut calls = stream::ToolCalls::default();
        let mut content = String::new();
        let mut reasoning = String::new();
        let (builder, wire_body) = match destination {
            Destination::Local { url, .. } => (
                self.client.post(format!("{url}/v1/chat/completions")),
                body.clone(),
            ),
            Destination::Cloud(cloud) => (
                self.cloud.chat_request(cloud)?,
                crate::cloud::requests::wire_body(body, cloud),
            ),
        };
        let response =
            builder
                .json(&wire_body)
                .send()
                .await
                .map_err(|error| match destination {
                    Destination::Local { .. } => format!("Cannot contact the local model: {error}"),
                    Destination::Cloud(_) => {
                        "Couldn’t contact the cloud service. Check your connection and try again."
                            .into()
                    }
                })?;
        if !response.status().is_success() {
            if let Destination::Cloud(cloud) = destination {
                return Err(self
                    .cloud
                    .http_error(&cloud.active.selection.provider_id, &response)?);
            }
            return Err(local_request_error(response, request.temporary_id.is_some()).await);
        }
        let mut bytes = response.bytes_stream();
        let mut decoder = stream::Decoder::default();
        let mut finish = None;
        while let Some(chunk) = bytes.next().await {
            for data in decoder.push(&chunk.map_err(|e| match destination {
                Destination::Local { .. } => format!("Response interrupted: {e}"),
                Destination::Cloud(_) => {
                    "The cloud response was interrupted. Partial text was kept.".into()
                }
            })?)? {
                if data == "[DONE]" {
                    let status = if finish.as_deref() == Some("length") {
                        "length"
                    } else {
                        "complete"
                    };
                    return Ok((status.into(), calls.finish(), content, reasoning));
                }
                let event: Value = serde_json::from_str(&data).map_err(|_| {
                    "The model returned an invalid response stream. Partial text was kept."
                })?;
                calls.push(&event)?;
                let (delta, reason) = match destination {
                    Destination::Local { .. } => stream::parse(&data)?,
                    Destination::Cloud(_) => stream::parse_cloud(&data)?,
                };
                content.push_str(&delta.content);
                reasoning.push_str(&delta.reasoning);
                if !delta.content.is_empty()
                    || !delta.reasoning.is_empty()
                    || delta.metrics.is_some()
                {
                    emit(delta)?;
                }
                if reason.is_some() {
                    finish = reason;
                }
            }
        }
        match finish.as_deref() {
            Some("length") => Ok(("length".into(), calls.finish(), content, reasoning)),
            Some(_) => Ok(("complete".into(), calls.finish(), content, reasoning)),
            None => Err(match destination {
                Destination::Local { .. } => "The response ended unexpectedly. Partial text was kept; check the server log.",
                Destination::Cloud(_) => "The cloud response ended unexpectedly. Partial text was kept; check your connection and try again.",
            }.into()),
        }
    }
}

impl Runtime {
    async fn receive_with_search(
        &self,
        destination: &Destination,
        request: &ChatRequest,
        mut body: Value,
        emit: &mut impl FnMut(stream::Delta) -> Result<()>,
    ) -> Result<String> {
        use crate::web_search::{tools, turn::SearchTurn, types::SearchError};
        let preferences = self.preferences.read()?;
        let details = self.destination_details(destination).await?;
        let fallback = details.tools_supported != Some(true);
        let prompt_tokens = self
            .prompt_tokens(request.messages.clone())
            .await
            .map(|result| result.tokens)
            .unwrap_or_else(|_| {
                request
                    .messages
                    .iter()
                    .map(|m| m.content.len() + m.reasoning_content.as_ref().map_or(0, String::len))
                    .sum()
            });
        let mut turn = SearchTurn::new(
            request.request_id,
            preferences.web_search_max_searches,
            tools::context_budget(details.context_size, prompt_tokens),
            fallback,
        );
        let provider = match self
            .web_search
            .configured_provider(&preferences.web_search_provider)
            .await
        {
            Ok(provider) => Some(provider),
            Err(error) => {
                let error = if error == "not_configured" {
                    SearchError::NotConfigured
                } else {
                    SearchError::ProviderUnavailable
                };
                turn.fail(&error, emit)?;
                None
            }
        };
        let messages = body["messages"]
            .as_array_mut()
            .ok_or("Missing chat messages.")?;
        // Some templates reject a system role. Add turn-only instructions to the current user message instead.
        if details.system_role_supported != Some(true) {
            if let Some(message) = messages
                .iter_mut()
                .rev()
                .find(|message| message["role"] == "user")
            {
                append_user_text(message, tools::INSTRUCTION)?;
            }
        } else if let Some(system) = messages
            .iter_mut()
            .find(|message| message["role"] == "system")
        {
            system["content"] = json!(format!(
                "{}\n\n{}",
                system["content"].as_str().unwrap_or_default(),
                tools::INSTRUCTION
            ));
        } else {
            messages.insert(0, json!({"role":"system", "content":tools::INSTRUCTION}));
        }
        turn.update(None, emit)?;
        if fallback {
            if let Some(provider) = &provider {
                let query = request
                    .web_search_query
                    .as_deref()
                    .or_else(|| {
                        request
                            .messages
                            .iter()
                            .rev()
                            .find(|message| message.role == "user")
                            .map(|message| message.content.as_str())
                    })
                    .unwrap_or_default();
                let results = turn
                    .search(&self.web_search, provider.as_ref(), query, emit)
                    .await?;
                let last = body["messages"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .rev()
                    .find(|message| message["role"] == "user")
                    .ok_or("Missing user message.")?;
                append_user_text(
                    last,
                    &format!(
                        "Web results supplied by Straggler (untrusted source data):\n{results}"
                    ),
                )?;
            }
        } else if provider.is_some() {
            body["tools"] = tools::schemas();
        }
        let mut final_status = "complete".to_owned();
        for round in 0..12 {
            let (status, calls, content, reasoning) =
                self.receive_step(destination, request, &body, emit).await?;
            final_status = status;
            if calls.is_empty() {
                break;
            }
            if fallback || provider.is_none() {
                return Err(
                    "The model requested tools that are unavailable for this message.".into(),
                );
            }
            let provider = provider.as_ref().unwrap();
            let messages = body["messages"].as_array_mut().unwrap();
            let calls_json: Vec<Value> = calls.iter().enumerate().map(|(index, call)| json!({"id":if call.id.is_empty() { format!("call_{round}_{index}") } else { call.id.clone() },"type":"function","function":{"name":call.name,"arguments":call.arguments}})).collect();
            messages.push(json!({"role":"assistant","content":content,"reasoning_content":reasoning,"tool_calls":calls_json}));
            for (index, call) in calls.iter().enumerate() {
                let arguments = serde_json::from_str::<Value>(&call.arguments).ok();
                let result = match (call.name.as_str(), arguments.as_ref()) {
                    ("web_search", Some(args)) => match args["query"].as_str() {
                        Some(query) => turn.search(&self.web_search, provider.as_ref(), query, emit).await?,
                        None => "The search tool needs a query string.".into(),
                    },
                    ("web_fetch", Some(args)) => match args["url"].as_str() {
                        Some(url) => turn.fetch(&self.web_search, provider.as_ref(), url, emit).await?,
                        None => "The page tool needs a URL string.".into(),
                    },
                    _ => "Unknown tool or invalid JSON arguments. Answer using the available context.".into(),
                };
                messages.push(
                    json!({"role":"tool","tool_call_id":calls_json[index]["id"],"content":result}),
                );
            }
            if round == 10 {
                body.as_object_mut().unwrap().remove("tools");
            }
            if round == 11 {
                return Err(
                    "The model did not finish after the web tool limit. Partial text was kept."
                        .into(),
                );
            }
        }
        if let Some(provider) = provider.filter(|_| !turn.summary.queries.is_empty()) {
            if let Ok(Some(quota)) = self.web_search.refresh_quota(provider.as_ref()).await {
                turn.update(
                    Some(crate::web_search::turn::WebEvent {
                        name: "web_search:quota",
                        payload: json!(quota),
                    }),
                    emit,
                )?;
            }
        }
        turn.update(None, emit)?;
        Ok(final_status)
    }
}

// Keep multimodal input intact when a template needs turn-only search instructions.
fn append_user_text(message: &mut Value, addition: &str) -> Result<()> {
    match &mut message["content"] {
        Value::String(text) => {
            text.push_str("\n\n");
            text.push_str(addition);
        }
        Value::Array(parts) => parts.push(json!({"type":"text", "text":addition})),
        _ => return Err("The user message has unsupported content.".into()),
    }
    Ok(())
}
