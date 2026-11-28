pub mod credentials;
pub mod models;
pub(crate) mod requests;

use crate::{files::write_atomic, model::ServerDetails, Result};
use credentials::{CloudKeys, SystemCloudKeys};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    DeepSeek,
    OpenRouter,
    Mistral,
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudModel {
    pub id: String,
    pub name: String,
    pub details: ServerDetails,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_parameters: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub kind: ProviderKind,
    #[serde(default)]
    pub models: Vec<CloudModel>,
    #[serde(default)]
    pub shown: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveCloud {
    pub selection: Selection,
    pub provider_name: String,
    pub base_url: String,
    pub kind: ProviderKind,
    pub output_limit_supported: bool,
    pub model: CloudModel,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    #[serde(flatten)]
    pub provider: Provider,
    pub saved: bool,
    pub key_error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub generation_parameters: std::collections::BTreeMap<String, Vec<&'static str>>,
    pub providers: Vec<ProviderStatus>,
    pub active: Option<ActiveCloud>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    providers: Vec<Provider>,
}

pub fn registry() -> Vec<Provider> {
    [
        (
            "deepseek",
            "DeepSeek",
            "https://api.deepseek.com",
            ProviderKind::DeepSeek,
        ),
        (
            "openrouter",
            "OpenRouter",
            "https://openrouter.ai/api/v1",
            ProviderKind::OpenRouter,
        ),
        (
            "mistral",
            "Mistral",
            "https://api.mistral.ai/v1",
            ProviderKind::Mistral,
        ),
    ]
    .into_iter()
    .map(|(id, name, base_url, kind)| Provider {
        id: id.into(),
        name: name.into(),
        base_url: base_url.into(),
        kind,
        models: Vec::new(),
        shown: Vec::new(),
    })
    .collect()
}

pub fn validate_base_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value).map_err(|_| "Enter a valid cloud service base URL.")?;
    let loopback = match url.host() {
        Some(url::Host::Domain(name)) => name == "localhost",
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host().is_none()
    {
        return Err("Use HTTPS, or HTTP on loopback, without URL credentials, query parameters or fragments.".into());
    }
    Ok(url.as_str().trim_end_matches('/').into())
}

// Credentials stay in this request-only object and never implement Debug/Serialize.
pub(crate) struct CloudDestination {
    pub active: ActiveCloud,
    pub key: String,
}

pub struct CloudService {
    path: PathBuf,
    writer: Mutex<()>,
    operation: tokio::sync::Mutex<()>,
    keys: Arc<dyn CloudKeys>,
    client: reqwest::Client,
    active: Mutex<Option<ActiveCloud>>,
    limited: Mutex<HashMap<String, Instant>>,
    #[cfg(any(test, all(feature = "native-tests", debug_assertions)))]
    fixture_only: bool,
    #[cfg(any(test, all(feature = "native-tests", debug_assertions)))]
    fixture_base: Option<String>,
}

impl CloudService {
    pub fn new(directory: PathBuf) -> Result<Self> {
        Self::with_keys(directory, Arc::new(SystemCloudKeys))
    }
    pub fn with_keys(directory: PathBuf, keys: Arc<dyn CloudKeys>) -> Result<Self> {
        Ok(Self {
            path: directory.join("cloud-models.json"),
            writer: Mutex::new(()),
            operation: tokio::sync::Mutex::new(()),
            keys,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| "Couldn’t prepare the cloud connection.")?,
            active: Mutex::new(None),
            limited: Mutex::default(),
            #[cfg(any(test, all(feature = "native-tests", debug_assertions)))]
            fixture_only: false,
            #[cfg(any(test, all(feature = "native-tests", debug_assertions)))]
            fixture_base: None,
        })
    }
    #[cfg(any(test, all(feature = "native-tests", debug_assertions)))]
    pub fn loopback_fixture(directory: PathBuf, endpoint: Option<&str>) -> Result<Self> {
        let mut service =
            Self::with_keys(directory, Arc::new(credentials::MemoryCloudKeys::default()))?;
        service.fixture_only = true;
        service.fixture_base = endpoint
            .map(|value| -> Result<String> {
                let value = validate_base_url(value)?;
                let url = url::Url::parse(&value).map_err(|_| "Invalid cloud fixture endpoint.")?;
                let loopback = match url.host() {
                    Some(url::Host::Domain(name)) => name == "localhost",
                    Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                    Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                    None => false,
                };
                if !loopback {
                    return Err("Cloud fixtures must use loopback.".into());
                }
                Ok(value)
            })
            .transpose()?;
        Ok(service)
    }
    fn request_base(&self, base: &str) -> Result<String> {
        #[cfg(any(test, all(feature = "native-tests", debug_assertions)))]
        if self.fixture_only {
            return self
                .fixture_base
                .clone()
                .ok_or("The local cloud fixture endpoint is not configured.".into());
        }
        Ok(base.into())
    }
    fn read(&self) -> Result<Vec<Provider>> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(registry()),
            Err(_) => return Err("Couldn’t read cloud settings. The file was kept.".into()),
        };
        let stored: Stored = serde_json::from_slice(&bytes)
            .map_err(|_| "Couldn’t read cloud settings. The file was kept.")?;
        if stored.version != 1 {
            return Err("Unsupported cloud settings version. The file was kept.".into());
        }
        self.validate(&stored.providers)?;
        Ok(stored.providers)
    }
    fn validate(&self, providers: &[Provider]) -> Result<()> {
        let defaults = registry();
        let mut ids = HashSet::new();
        for provider in providers {
            if !ids.insert(&provider.id)
                || provider.name.trim().is_empty()
                || provider.name.chars().count() > 80
                || provider.name.chars().any(char::is_control)
                || validate_base_url(&provider.base_url)? != provider.base_url
            {
                return Err("Invalid cloud provider settings. The file was kept.".into());
            }
            if let Some(fixed) = defaults.iter().find(|fixed| fixed.id == provider.id) {
                if fixed.kind != provider.kind || fixed.base_url != provider.base_url {
                    return Err("A registered cloud provider cannot change its address or protocol. The file was kept.".into());
                }
            } else if provider.kind != ProviderKind::Custom
                || provider
                    .id
                    .strip_prefix("custom-")
                    .and_then(|id| Uuid::parse_str(id).ok())
                    .is_none()
            {
                return Err("Invalid custom provider identifier. The file was kept.".into());
            }
            let mut models = HashSet::new();
            for model in &provider.models {
                if model.id.is_empty()
                    || model.id.len() > 1024
                    || model.id.contains('\0')
                    || !models.insert(&model.id)
                {
                    return Err("Invalid cached cloud model. The file was kept.".into());
                }
            }
        }
        if defaults.iter().any(|fixed| !ids.contains(&fixed.id)) {
            return Err("Missing registered cloud providers. The file was kept.".into());
        }
        Ok(())
    }
    fn update(&self, action: impl FnOnce(&mut Vec<Provider>) -> Result<()>) -> Result<()> {
        let _guard = self.writer.lock().map_err(|e| e.to_string())?;
        let mut providers = self.read()?;
        action(&mut providers)?;
        self.validate(&providers)?;
        let bytes = serde_json::to_vec_pretty(&Stored {
            version: 1,
            providers,
        })
        .map_err(|_| "Couldn’t encode cloud settings.")?;
        write_atomic(&self.path, &bytes)
    }
    fn provider(&self, id: &str) -> Result<Provider> {
        self.read()?
            .into_iter()
            .find(|provider| provider.id == id)
            .ok_or("The cloud provider is unavailable.".into())
    }
    pub fn active(&self) -> Result<Option<ActiveCloud>> {
        Ok(self.active.lock().map_err(|e| e.to_string())?.clone())
    }
    pub fn clear_active(&self) -> Result<()> {
        *self.active.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    }
    pub fn status(&self) -> Result<CloudStatus> {
        Ok(Self::status_with_keys(
            self.read(),
            self.active()?,
            self.keys.as_ref(),
        ))
    }
    async fn status_async(&self) -> Result<CloudStatus> {
        let providers = self.read();
        let active = self.active()?;
        let keys = self.keys.clone();
        tokio::task::spawn_blocking(move || {
            Self::status_with_keys(providers, active, keys.as_ref())
        })
        .await
        .map_err(|_| "The system keychain task failed.".into())
    }
    fn status_with_keys(
        providers: Result<Vec<Provider>>,
        active: Option<ActiveCloud>,
        keys: &dyn CloudKeys,
    ) -> CloudStatus {
        let providers = match providers {
            Ok(providers) => providers,
            Err(error) => {
                return CloudStatus {
                    generation_parameters: crate::generation::provider_parameters(),
                    providers: Vec::new(),
                    active,
                    error: Some(error),
                }
            }
        };
        let providers = providers
            .into_iter()
            .map(|provider| {
                let (saved, key_error) = match keys.store(&provider.id).read() {
                    Ok(key) => (key.is_some(), None),
                    Err(error) => (false, Some(error)),
                };
                ProviderStatus {
                    provider,
                    saved,
                    key_error,
                }
            })
            .collect();
        CloudStatus {
            generation_parameters: crate::generation::provider_parameters(),
            providers,
            active,
            error: None,
        }
    }
    async fn read_key(&self, id: &str) -> Result<Option<String>> {
        let keys = self.keys.store(id);
        // Linux's synchronous keychain API drives a runtime of its own.
        tokio::task::spawn_blocking(move || keys.read())
            .await
            .map_err(|_| "The system keychain task failed.")?
    }
    pub fn add_custom(&self, name: String, base_url: String) -> Result<CloudStatus> {
        let base_url = validate_base_url(&base_url)?;
        self.update(|providers| {
            providers.push(Provider {
                id: format!("custom-{}", Uuid::new_v4()),
                name: name.trim().into(),
                base_url,
                kind: ProviderKind::Custom,
                models: Vec::new(),
                shown: Vec::new(),
            });
            Ok(())
        })?;
        self.status()
    }
    pub fn show_models(&self, id: &str, shown: Vec<String>) -> Result<CloudStatus> {
        self.update(|providers| {
            let provider = providers
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or("The cloud provider is unavailable.")?;
            let mut unique = HashSet::new();
            if shown.iter().any(|id| {
                !unique.insert(id) || !provider.models.iter().any(|model| &model.id == id)
            }) {
                return Err("Choose models from the cached service list.".into());
            }
            provider.shown = shown;
            Ok(())
        })?;
        self.status()
    }
    pub async fn save_key(&self, id: &str, key: Option<String>) -> Result<CloudStatus> {
        let _operation = self.operation.lock().await;
        let provider = self.provider(id)?;
        let models = if let Some(key) = &key {
            if key.is_empty() || key.len() > 8192 || key.chars().any(char::is_control) {
                return Err("Enter a valid API key without control characters.".into());
            }
            Some(
                self.fetch_models(&provider, key)
                    .await
                    .map_err(|error| format!("{error} The previous key was kept."))?,
            )
        } else {
            None
        };
        let keys = self.keys.store(id);
        tokio::task::spawn_blocking(move || keys.write(key.as_deref()))
            .await
            .map_err(|_| "The system keychain task failed.")??;
        if let Some(models) = models {
            if self
                .update(|providers| {
                    providers
                        .iter_mut()
                        .find(|p| p.id == id)
                        .ok_or("The cloud provider is unavailable.")?
                        .models = models;
                    Ok(())
                })
                .is_err()
            {
                return Err("The key was verified and saved, but the model list could not be saved. Refresh the models after resolving the storage error.".into());
            }
        }
        self.status_async().await
    }
    pub async fn refresh(&self, id: &str) -> Result<CloudStatus> {
        let _operation = self.operation.lock().await;
        let provider = self.provider(id)?;
        let key = self
            .read_key(id)
            .await?
            .ok_or("Save and verify a cloud API key first.")?;
        let models = self.fetch_models(&provider, &key).await?;
        self.update(|providers| {
            providers
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or("The cloud provider is unavailable.")?
                .models = models;
            Ok(())
        })?;
        self.status_async().await
    }
    async fn fetch_models(&self, provider: &Provider, key: &str) -> Result<Vec<CloudModel>> {
        self.check_rate_limit(&provider.id)?;
        let response = self
            .client
            .get(format!("{}/models", self.request_base(&provider.base_url)?))
            .bearer_auth(key)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| {
                "Couldn’t contact the cloud service. Check your connection and try again."
            })?;
        if !response.status().is_success() {
            return Err(self.http_error(&provider.id, &response)?);
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            bytes.extend_from_slice(&chunk.map_err(|_| "The cloud model list was interrupted.")?);
            if bytes.len() > 16 * 1024 * 1024 {
                return Err("The cloud model list exceeds 16 MiB.".into());
            }
        }
        let value = serde_json::from_slice(&bytes)
            .map_err(|_| "The cloud service returned an invalid model list.")?;
        models::parse(provider.kind, value)
    }
    pub fn choose(&self, selection: &Selection) -> Result<ActiveCloud> {
        let provider = self.provider(&selection.provider_id)?;
        if !provider.shown.contains(&selection.model_id) {
            return Err("Choose a cloud model enabled in Settings.".into());
        }
        let model = provider
            .models
            .iter()
            .find(|model| model.id == selection.model_id)
            .ok_or("The selected cloud model is unavailable. Refresh models in Settings.")?
            .clone();
        if self.keys.store(&provider.id).read()?.is_none() {
            return Err("Save and verify this service’s API key first.".into());
        }
        Ok(ActiveCloud {
            selection: selection.clone(),
            provider_name: provider.name,
            base_url: provider.base_url,
            kind: provider.kind,
            output_limit_supported: crate::generation::output_limit_supported(
                provider.kind,
                model.supported_parameters.as_deref(),
            ),
            model,
        })
    }
    pub(crate) async fn destination(&self, selection: &Selection) -> Result<CloudDestination> {
        let active = self
            .active()?
            .filter(|active| &active.selection == selection)
            .ok_or("Choose this cloud model before sending.")?;
        self.check_rate_limit(&selection.provider_id)?;
        let key = self
            .read_key(&selection.provider_id)
            .await?
            .ok_or("Save and verify this service’s API key first.")?;
        Ok(CloudDestination { active, key })
    }
    pub(crate) fn chat_request(
        &self,
        destination: &CloudDestination,
    ) -> Result<reqwest::RequestBuilder> {
        self.check_rate_limit(&destination.active.selection.provider_id)?;
        Ok(self
            .client
            .post(format!(
                "{}/chat/completions",
                self.request_base(&destination.active.base_url)?
            ))
            .bearer_auth(&destination.key))
    }

    pub fn check_rate_limit(&self, id: &str) -> Result<()> {
        if self
            .limited
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .is_some_and(|until| *until > Instant::now())
        {
            return Err(
                "The cloud service is receiving too many requests. Try again in a moment.".into(),
            );
        }
        Ok(())
    }
    pub fn http_error(&self, id: &str, response: &reqwest::Response) -> Result<String> {
        Ok(match response.status().as_u16() {
            401 | 403 => "The cloud service rejected the API key. Review the key in Settings.".into(),
            402 => "The cloud service has no credit left. Add credit with the service before trying again.".into(),
            429 => {
                let seconds = response.headers().get(reqwest::header::RETRY_AFTER).and_then(|value| value.to_str().ok()).and_then(|value| value.parse::<u64>().ok().or_else(|| httpdate::parse_http_date(value).ok().map(|date| date.duration_since(std::time::SystemTime::now()).unwrap_or_default().as_secs()))).unwrap_or(1).min(86400);
                self.limited.lock().map_err(|e| e.to_string())?.insert(id.into(), Instant::now() + Duration::from_secs(seconds));
                "The cloud service is receiving too many requests. Try again in a moment.".into()
            }
            500..=599 => "The cloud service is temporarily unavailable. Try again in a moment.".into(),
            status => format!("The cloud service rejected this chat request ({status}). Review the selected model and supported features."),
        })
    }
}

impl crate::Runtime {
    pub fn choose_cloud_model(&self, selection: Selection) -> Result<CloudStatus> {
        if self
            .active
            .lock()
            .map_err(|e| e.to_string())?
            .current
            .is_some()
        {
            return Err("Stop the response before changing models.".into());
        }
        let chosen = self.cloud.choose(&selection)?;
        self.stop()?;
        if let Some(session) = self.temporary.lock().map_err(|e| e.to_string())?.as_mut() {
            session.resume_model = None;
            session.slot = None;
        }
        *self.cloud.active.lock().map_err(|e| e.to_string())? = Some(chosen);
        self.cloud.status()
    }
}

#[cfg(test)]
mod tests;
