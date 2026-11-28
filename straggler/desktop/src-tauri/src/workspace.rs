use crate::{
    configuration::storage::{executable, server_path, Paths},
    platform,
};
use crate::{Result, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub chat_system_prompt: String,
    pub chat_reasoning: String,
    pub chat_reasoning_effort: String,
    pub chat_auto_compact: String,
    pub model: String,
    pub chat_template_file: String,
    pub mtp: String,
    pub mtp_file: String,
    pub context: String,
    pub port: String,
    pub device: String,
    pub threads: String,
    pub gpu_layers: String,
    pub prompt_processing: String,
    pub cache_type_k: String,
    pub cache_type_v: String,
    pub split_mode: String,
    pub tensor_split: String,
    pub fit_target: String,
    pub temperature: String,
    pub top_p: String,
    pub top_k: String,
    pub min_p: String,
    pub repeat_penalty: String,
    pub presence_penalty: String,
    pub frequency_penalty: String,
    pub seed: String,
    pub max_tokens: String,
}

impl Settings {
    pub fn select_model(&mut self, model: String) {
        if self.model != model {
            self.chat_template_file.clear();
            self.mtp = "off".into();
            self.mtp_file.clear();
            self.model = model;
        }
    }

    pub fn same_server_configuration(&self, other: &Self) -> bool {
        let left = self.fields();
        let right = other.fields();
        left.iter().all(|(field, value)| {
            field == "chat_reasoning_effort"
                || crate::generation::chat_default_fields().any(|key| key == field)
                || right.get(field) == Some(value)
        })
    }
}

/// Native validation carries its field identifier intact through IPC.
#[derive(Debug, Serialize)]
pub struct ConfigurationError {
    pub field: Option<String>,
    pub message: String,
}

impl From<String> for ConfigurationError {
    fn from(message: String) -> Self {
        for line in message.lines() {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                if value["stragglerValidation"] == true {
                    if let (Some(field), Some(detail)) =
                        (value["field"].as_str(), value["message"].as_str())
                    {
                        return Self {
                            field: Some(field.into()),
                            message: detail.into(),
                        };
                    }
                }
            }
        }
        Self {
            field: None,
            message,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Model {
    #[serde(default, rename = "sizeBytes")]
    pub size_bytes: Option<u64>,
    pub path: String,
    pub label: String,
    pub template: Option<String>,
    #[serde(default)]
    pub projector: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Device {
    pub name: String,
    pub label: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Listener {
    pub pid: u32,
    pub identity: String,
    pub details: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    pub llama_dir: String,
    pub models_dir: String,
    pub server_available: bool,
    pub bundled_available: bool,
    #[serde(default)]
    pub app_store: bool,
    pub port: u16,
    pub port_status: String,
    pub warning: String,
    pub settings: Settings,
    pub generation_preset: String,
    pub models: Vec<Model>,
    pub devices: Vec<Device>,
    pub listeners: Vec<Listener>,
    pub memory: Value,
    pub build: Value,
    pub profiles: Vec<String>,
    pub capabilities: Value,
    pub presets: std::collections::BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub current_profile: Option<String>,
    #[serde(default)]
    pub modified: bool,
    #[serde(default)]
    pub restart_required: bool,
    #[serde(default)]
    pub saved_settings: Option<Settings>,
}

#[derive(Default)]
pub(crate) struct Workspace {
    pub(crate) configuration: Option<Configuration>,
    profile: Option<String>,
    saved: Option<Settings>,
    term_targets: BTreeMap<u32, String>,
    paths: Option<Paths>,
}

impl Runtime {
    pub fn select_model_file(
        &self,
        kind: crate::configuration::model_files::ModelFileKind,
        path: &std::path::Path,
    ) -> Result<String> {
        let path = path
            .canonicalize()
            .map_err(|error| format!("Cannot resolve selected file: {error}"))?;
        self.native.model_access.remember_file(&path)?;
        kind.validate(&path)?;
        path.to_str()
            .map(str::to_owned)
            .ok_or("The selected file path must be valid UTF-8.".into())
    }

    pub fn allow_default_models_folder(&self, directory: &std::path::Path) -> Result<()> {
        self.native.model_access.allow_internal(directory)
    }

    pub fn create_models_folder(&self, directory: &std::path::Path) -> Result<Configuration> {
        std::fs::create_dir_all(directory)
            .map_err(|error| format!("Cannot create the models folder: {error}"))?;
        let directory = directory.canonicalize().map_err(|e| e.to_string())?;
        self.native.model_access.allow_internal(&directory)?;
        self.configure_action(
            "set-path",
            &["models".into(), directory.to_string_lossy().into_owned()],
            None,
        )
    }

    pub fn select_model_folder(&self, path: &std::path::Path) -> Result<Configuration> {
        let path = path.canonicalize().map_err(|error| error.to_string())?;
        self.native.model_access.remember(&path)?;
        self.configure_action(
            "set-path",
            &["models".into(), path.to_string_lossy().into_owned()],
            None,
        )
    }

    pub(crate) fn generation_settings(&self) -> Result<Settings> {
        let workspace = self.workspace.lock().map_err(|error| error.to_string())?;
        match &workspace.configuration {
            Some(configuration) => Ok(configuration.settings.clone()),
            None => self.native.store.initial_settings(),
        }
    }

    pub fn save_chat_defaults(&self, patch: BTreeMap<String, String>) -> Result<Configuration> {
        let mut workspace = self.workspace.lock().map_err(|error| error.to_string())?;
        let mut configuration = workspace
            .configuration
            .clone()
            .ok_or("Load Settings before saving chat defaults.")?;
        let settings = crate::configuration::chat_defaults::merge(&configuration.settings, patch)?;
        self.native.store.save_chat_defaults(&settings)?;
        configuration.settings = settings;
        configuration.generation_preset = configuration.settings.generation_preset();
        configuration.modified = workspace
            .saved
            .as_ref()
            .is_some_and(|saved| saved != &configuration.settings);
        workspace.configuration = Some(configuration.clone());
        Ok(configuration)
    }

    pub fn review_profile(&self, name: &str) -> Result<Configuration> {
        let profile = self.native.store.load_profile(name)?;
        let mut workspace = self.workspace.lock().map_err(|error| error.to_string())?;
        let mut next = workspace
            .configuration
            .clone()
            .ok_or("Load Settings before reviewing a configuration.")?;
        let fields = profile.fields();
        let patch = crate::generation::chat_default_fields()
            .map(|field| (field.into(), fields[field].clone()))
            .collect();
        let settings = crate::configuration::chat_defaults::merge(&next.settings, patch)?;
        self.native.store.save_chat_defaults(&settings)?;
        next.settings = settings;
        next.generation_preset = next.settings.generation_preset();
        workspace.profile = Some(name.into());
        workspace.saved = Some(profile.clone());
        next.current_profile = workspace.profile.clone();
        next.saved_settings = Some(profile);
        next.modified = next.saved_settings.as_ref() != Some(&next.settings);
        workspace.configuration = Some(next.clone());
        Ok(next)
    }

    pub fn preview_profile(&self, name: &str) -> Result<Settings> {
        self.native.store.load_profile(name)
    }

    pub fn inspect(&self) -> Result<Configuration> {
        self.configure_action("inspect", &[], None)
    }

    pub fn configure(&self, settings: Settings) -> Result<Configuration> {
        self.configure_action("inspect", &[], Some(settings))
    }

    pub fn workspace_action(
        &self,
        action: &str,
        arguments: Vec<String>,
        targets: Vec<Listener>,
    ) -> Result<Value> {
        match action {
            "review-profile" => {
                let [name] = arguments.as_slice() else {
                    return Err("Choose a saved configuration.".into());
                };
                serde_json::to_value(self.review_profile(name)?).map_err(|error| error.to_string())
            }
            "load-profile" | "save-profile" | "delete-profile" | "set-path" | "use-bundled" => {
                if (action == "use-bundled"
                    || (action == "set-path"
                        && arguments.first().map(String::as_str) == Some("llama")))
                    && self
                        .server
                        .lock()
                        .map_err(|error| error.to_string())?
                        .child
                        .is_some()
                {
                    return Err("Stop the server before changing its build.".into());
                }
                serde_json::to_value(self.configure_action(action, &arguments, None)?)
                    .map_err(|error| error.to_string())
            }
            "browse" => {
                if arguments.len() > 2
                    || arguments
                        .get(1)
                        .is_some_and(|value| !matches!(value.as_str(), "true" | "false"))
                {
                    return Err("Invalid folder browsing request.".into());
                }
                self.native.browse(
                    arguments.first().map_or("", String::as_str),
                    arguments.get(1).is_some_and(|value| value == "true"),
                )
            }
            "stop-listeners" => {
                if self
                    .server
                    .lock()
                    .map_err(|error| error.to_string())?
                    .child
                    .is_some()
                {
                    return Err("Use Stop server for the server started by this app.".into());
                }
                let signal = match arguments.as_slice() {
                    [signal] if signal == "TERM" => libc::SIGTERM,
                    [signal] if signal == "KILL" => libc::SIGKILL,
                    _ => return Err("Invalid listener shutdown request.".into()),
                };
                let config = self.inspect()?;
                {
                    let mut workspace = self.workspace.lock().map_err(|error| error.to_string())?;
                    if signal == libc::SIGKILL
                        && targets.iter().any(|target| {
                            workspace.term_targets.get(&target.pid) != Some(&target.identity)
                        })
                    {
                        return Err("Request a normal stop before confirming a force stop.".into());
                    }
                    platform::stop_listeners(config.port, &targets, signal)?;
                    if signal == libc::SIGTERM {
                        for target in targets {
                            workspace.term_targets.insert(target.pid, target.identity);
                        }
                    } else {
                        for target in targets {
                            workspace.term_targets.remove(&target.pid);
                        }
                    }
                }
                serde_json::to_value(self.inspect()?).map_err(|error| error.to_string())
            }
            _ => Err(
                "Unknown configuration operation. Backend updates are supplied with Straggler."
                    .into(),
            ),
        }
    }

    fn configure_action(
        &self,
        action: &str,
        arguments: &[String],
        settings: Option<Settings>,
    ) -> Result<Configuration> {
        let mut workspace = self.workspace.lock().map_err(|error| error.to_string())?;
        let mut paths = workspace
            .paths
            .clone()
            .unwrap_or_else(|| self.native.store.paths());
        let mut settings = match settings.or_else(|| {
            workspace
                .configuration
                .as_ref()
                .map(|configuration| configuration.settings.clone())
        }) {
            Some(settings) => settings.validated()?,
            None => self.native.store.initial_settings()?,
        };
        match action {
            "inspect" => {
                if !arguments.is_empty() {
                    return Err("Invalid configuration arguments.".into());
                }
            }
            "load-profile" => {
                let [name] = arguments else {
                    return Err("Choose a saved configuration.".into());
                };
                settings = self.native.store.load_profile(name)?;
            }
            "save-profile" => {
                let [name, confirmation] = arguments else {
                    return Err(
                        "Choose a configuration name and confirm replacement when needed.".into(),
                    );
                };
                self.native
                    .store
                    .save_profile(name, &settings, confirmation == "replace")?;
            }
            "delete-profile" => {
                let [name, confirmation] = arguments else {
                    return Err("Confirm configuration deletion.".into());
                };
                self.native
                    .store
                    .delete_profile(name, confirmation == "confirm")?;
            }
            "set-path" => {
                let [kind, path] = arguments else {
                    return Err("Choose a folder.".into());
                };
                if cfg!(feature = "app-store") && kind == "llama" {
                    return Err("The App Store edition uses only its included backend. Backend updates arrive with application updates.".into());
                }
                if !crate::configuration::settings::literal(path) {
                    return Err("Choose a directory without line breaks.".into());
                }
                let directory = std::path::Path::new(path)
                    .canonicalize()
                    .map_err(|error| format!("Choose a readable directory: {error}"))?;
                std::fs::read_dir(&directory)
                    .map_err(|error| format!("Choose a readable directory: {error}"))?;
                let value = directory
                    .to_str()
                    .ok_or("The folder path must be valid UTF-8.")?
                    .to_owned();
                match kind.as_str() {
                    "llama" => {
                        if !executable(&server_path(&value)) {
                            return Err("The llama.cpp folder must contain executable build/bin/llama-server or bin/llama-server.".into());
                        }
                        paths.llama = value;
                    }
                    "models" => {
                        if !self.native.model_access.permits(&directory) {
                            return Err(
                                "Choose this folder with the native picker to grant model access."
                                    .into(),
                            );
                        }
                        let models = crate::configuration::models::discover(&directory)?;
                        if !models.iter().any(|model| model.path == settings.model) {
                            settings.select_model(
                                models
                                    .first()
                                    .map(|model| model.path.clone())
                                    .unwrap_or_default(),
                            );
                        }
                        paths.models = value;
                    }
                    _ => return Err("Invalid folder setting.".into()),
                }
                self.native.store.save_paths(&paths)?;
                paths.warning.clear();
            }
            "use-bundled" => {
                if !arguments.is_empty()
                    || !self
                        .native
                        .store
                        .environment
                        .bundled_server
                        .as_ref()
                        .is_some_and(|path| executable(path))
                {
                    return Err(
                        "The bundled llama-server is unavailable in this installation.".into(),
                    );
                }
                paths.llama.clear();
                self.native.store.save_paths(&paths)?;
                paths.warning.clear();
            }
            _ => return Err("Unknown configuration operation.".into()),
        }
        let mut next = self.native.snapshot(&paths, settings)?;
        match action {
            "load-profile" | "save-profile" => {
                workspace.profile = arguments.first().cloned();
                workspace.saved = Some(next.settings.clone());
            }
            "delete-profile" if workspace.profile.as_ref() == arguments.first() => {
                workspace.profile = None;
                workspace.saved = None;
            }
            _ => {}
        }
        next.current_profile = workspace.profile.clone();
        next.saved_settings = workspace.saved.clone();
        next.modified = workspace
            .saved
            .as_ref()
            .is_some_and(|saved| saved != &next.settings);
        let server = self.server.lock().map_err(|error| error.to_string())?;
        next.restart_required = server.child.is_some()
            && server
                .settings
                .as_ref()
                .is_some_and(|running| !running.same_server_configuration(&next.settings));
        workspace.paths = Some(paths);
        workspace.configuration = Some(next.clone());
        Ok(next)
    }
}

pub(crate) fn configuration_paths(configuration: &Configuration) -> Paths {
    Paths {
        llama: configuration.llama_dir.clone(),
        models: configuration.models_dir.clone(),
        warning: String::new(),
    }
}
