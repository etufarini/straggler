use super::environment::Environment;
use crate::{model::valid_effort, workspace::Settings, Result};
use serde_json::json;
use std::collections::BTreeMap;

pub const PROFILE_FIELDS: &[&str] = &[
    "model",
    "chat_template_file",
    "mtp",
    "mtp_file",
    "context",
    "port",
    "device",
    "threads",
    "gpu_layers",
    "prompt_processing",
    "cache_type_k",
    "cache_type_v",
    "split_mode",
    "tensor_split",
    "fit_target",
    "chat_system_prompt",
    "chat_reasoning",
    "chat_reasoning_effort",
    "chat_auto_compact",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "repeat_penalty",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    "max_tokens",
];
pub const SAMPLING_FIELDS: &[&str] = &[
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "repeat_penalty",
    "presence_penalty",
    "frequency_penalty",
];

pub fn presets() -> BTreeMap<String, Vec<String>> {
    [
        ("default", "auto auto auto auto auto auto auto"),
        ("focused", "0.6 0.95 20 0 1 0 0"),
        ("exploratory", "1 0.95 20 0 1 0 0"),
        ("min-p", "1 1 0 0.05 1 0 0"),
    ]
    .into_iter()
    .map(|(name, values)| {
        (
            name.into(),
            values.split_whitespace().map(str::to_owned).collect(),
        )
    })
    .collect()
}

pub fn field_error(field: &str, message: &str) -> String {
    json!({"stragglerValidation": true, "field": field, "message": message}).to_string()
}

pub fn literal(value: &str) -> bool {
    !value.contains(['\0', '\r', '\n'])
}

pub fn count(value: &str, maximum: u64) -> bool {
    !value.is_empty()
        && value.len() <= 10
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
        && value.parse::<u64>().is_ok_and(|number| number <= maximum)
}

fn decimal(value: &str) -> bool {
    let (integer, fraction) = value
        .split_once('.')
        .map_or((value, None), |(a, b)| (a, Some(b)));
    count(integer, i32::MAX as u64)
        && fraction.is_none_or(|part| {
            !part.is_empty() && part.len() <= 9 && part.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn gpu_list(value: &str, ratios: bool) -> bool {
    value == "auto"
        || (value.split(',').all(|item| {
            if ratios {
                decimal(item)
            } else {
                count(item, i32::MAX as u64)
            }
        }) && (!ratios
            || value
                .split(',')
                .any(|item| item.bytes().any(|byte| matches!(byte, b'1'..=b'9')))))
}

pub fn token(value: &str, extras: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || extras.contains(byte as char))
}

pub(super) fn cache_type(value: &str) -> bool {
    value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && token(value, "_", 32)
        && !value.bytes().any(|byte| byte.is_ascii_uppercase())
}

fn generation(field: &str, value: &str) -> bool {
    if value == "auto" {
        return true;
    }
    match field {
        "seed" => value == "-1" || count(value, u32::MAX as u64),
        "max_tokens" => value == "-1" || count(value, i32::MAX as u64),
        "top_k" => count(value, i32::MAX as u64),
        _ => {
            if !decimal(value.strip_prefix('-').unwrap_or(value)) {
                return false;
            }
            match field {
                "top_p" | "min_p" => {
                    !value.starts_with('-')
                        && value.parse::<f64>().is_ok_and(|number| number <= 1.0)
                }
                "temperature" => !value.starts_with('-'),
                "repeat_penalty" => {
                    !value.starts_with('-') && value.parse::<f64>().is_ok_and(|number| number > 0.0)
                }
                "presence_penalty" | "frequency_penalty" => true,
                _ => false,
            }
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        serde_json::from_str(include_str!("defaults.json"))
            .expect("Documented configuration defaults must match Settings")
    }
}

impl Settings {
    pub fn fields(&self) -> BTreeMap<String, String> {
        serde_json::from_value(serde_json::to_value(self).expect("Settings are text fields"))
            .expect("Settings are text fields")
    }

    pub fn from_fields(fields: BTreeMap<String, String>) -> Result<Self> {
        serde_json::from_value(serde_json::to_value(fields).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    }

    pub fn from_environment(environment: &Environment) -> Result<Self> {
        let mut fields = Self::default().fields();
        let preset = environment.control(
            "GENERATION_PRESET",
            environment
                .value("LLAMA_GENERATION_PRESET")
                .filter(|value| !value.is_empty())
                .unwrap_or("default".into()),
        );
        let values = presets()
            .remove(&preset)
            .ok_or("STRAGGLER_GENERATION_PRESET must be default, focused, exploratory or min-p.")?;
        for (name, value) in SAMPLING_FIELDS.iter().zip(values) {
            fields.insert((*name).into(), value);
        }
        for name in PROFILE_FIELDS {
            if matches!(
                *name,
                "chat_system_prompt"
                    | "chat_reasoning"
                    | "chat_reasoning_effort"
                    | "chat_auto_compact"
                    | "model"
            ) {
                continue;
            }
            let control = if *name == "context" {
                "CTX_SIZE".into()
            } else {
                name.to_uppercase()
            };
            let fallback = fields[*name].clone();
            let fallback = if name.starts_with("cache_type_") {
                environment
                    .value(&format!("LLAMA_ARG_{control}"))
                    .unwrap_or(fallback)
            } else if matches!(*name, "split_mode" | "tensor_split" | "fit_target") {
                fallback
            } else {
                let legacy = environment.value(&format!("LLAMA_{control}"));
                if SAMPLING_FIELDS.contains(name) || matches!(*name, "seed" | "max_tokens") {
                    legacy.unwrap_or(fallback)
                } else {
                    legacy.filter(|value| !value.is_empty()).unwrap_or(fallback)
                }
            };
            fields.insert((*name).into(), environment.control(&control, fallback));
        }
        Self::from_fields(fields)?.validated()
    }

    pub fn validated(mut self) -> Result<Self> {
        let fields = self.fields();
        for (name, value) in &fields {
            if name != "chat_system_prompt" && !literal(value) {
                return Err(field_error(
                    name,
                    "Settings must be single-line text values.",
                ));
            }
        }
        let checks = [
            ("chat_template_file", self.chat_template_file.is_empty() || std::path::Path::new(&self.chat_template_file).is_absolute(), "Choose a chat template with an absolute path."),
            ("mtp", matches!(self.mtp.as_str(), "off" | "model" | "file"), "MTP must be Off, Use model's MTP or Use external MTP file."),
            ("mtp_file", self.mtp_file.is_empty() || std::path::Path::new(&self.mtp_file).is_absolute(), "Choose an MTP file with an absolute path."),
            ("port", !self.port.is_empty() && self.port.len() <= 5 && self.port.bytes().all(|byte| byte.is_ascii_digit()) && self.port.parse::<u16>().is_ok_and(|port| port != 0), "Port must be an integer between 1 and 65535."),
            ("context", self.context == "auto" || count(&self.context, i32::MAX as u64), "Use Auto or an integer from 0 to 2147483647 for context (0 requests the full model context)."),
            ("device", self.device.split(',').all(|name| token(name, "_.:-", usize::MAX)), "Use Auto, none or a comma-separated list of device names."),
            ("threads", self.threads == "auto" || (self.threads != "0" && count(&self.threads, i32::MAX as u64)), "CPU threads must be Auto or a positive integer (up to 2147483647)."),
            ("gpu_layers", matches!(self.gpu_layers.as_str(), "auto" | "all") || count(&self.gpu_layers, i32::MAX as u64), "GPU layers must be Auto, all or a nonnegative integer (up to 2147483647)."),
            ("split_mode", matches!(self.split_mode.as_str(), "auto" | "none" | "layer" | "row" | "tensor"), "Split mode must be Auto, none, layer, row or tensor."),
            ("tensor_split", gpu_list(&self.tensor_split, true), "Use Auto or comma-separated nonnegative proportions, with at least one positive value."),
            ("fit_target", gpu_list(&self.fit_target, false), "Use Auto or comma-separated nonnegative MiB integers (up to 2147483647)."),
            ("cache_type_k", cache_type(&self.cache_type_k), "Use a lowercase KV cache K type advertised by llama-server."),
            ("cache_type_v", cache_type(&self.cache_type_v), "Use a lowercase KV cache V type advertised by llama-server."),
            ("prompt_processing", matches!(self.prompt_processing.as_str(), "auto" | "low-memory" | "large-batch"), "STRAGGLER_PROMPT_PROCESSING must be auto, low-memory or large-batch."),
            ("chat_system_prompt", crate::system_prompts::valid_prompt(&self.chat_system_prompt), "System prompt must be valid text of at most 65536 UTF-8 bytes."),
            ("chat_reasoning", matches!(self.chat_reasoning.as_str(), "auto" | "on" | "off"), "Reasoning must use the model default, on or off."),
            ("chat_reasoning_effort", valid_effort(&self.chat_reasoning_effort), "Use a reasoning effort advertised by the loaded chat template or the model default."),
            ("chat_auto_compact", matches!(self.chat_auto_compact.as_str(), "on" | "off"), "Choose On or Off for automatic chat compaction."),
        ];
        for (name, valid, message) in checks {
            if !valid {
                return Err(field_error(name, message));
            }
        }
        for name in SAMPLING_FIELDS
            .iter()
            .copied()
            .chain(["seed", "max_tokens"])
        {
            if !generation(name, &fields[name]) {
                return Err(field_error(
                    name,
                    &format!(
                        "Invalid STRAGGLER_{}. Use auto or a valid generation value.",
                        name.to_uppercase()
                    ),
                ));
            }
        }
        self.port = self
            .port
            .parse::<u16>()
            .expect("Port was validated")
            .to_string();
        Ok(self)
    }

    pub fn generation_preset(&self) -> String {
        let fields = self.fields();
        presets()
            .into_iter()
            .find(|(_, values)| {
                SAMPLING_FIELDS
                    .iter()
                    .zip(values)
                    .all(|(name, value)| fields[*name] == *value)
            })
            .map(|(name, _)| name)
            .unwrap_or("custom".into())
    }

    pub fn profile_data(&self) -> Result<String> {
        let fields = self.fields();
        let mut data = String::new();
        for name in PROFILE_FIELDS {
            let value = if *name == "chat_system_prompt" {
                serde_json::to_string(&fields[*name]).map_err(|error| error.to_string())?
            } else {
                fields[*name].clone()
            };
            data.push_str(&format!("{name}={value}\n"));
        }
        Ok(data)
    }

    pub fn from_profile(data: &str) -> Result<Self> {
        let mut fields = Self::default().fields();
        let mut seen = std::collections::BTreeSet::new();
        for line in data.lines() {
            let (name, value) = line.split_once('=').ok_or("Invalid configuration line.")?;
            if !PROFILE_FIELDS.contains(&name) {
                continue;
            }
            if !seen.insert(name) {
                return Err(format!("Duplicate configuration field: {name}"));
            }
            let value = if name == "chat_system_prompt" {
                serde_json::from_str::<String>(value).map_err(|error| error.to_string())?
            } else {
                value.into()
            };
            fields.insert(name.into(), value);
        }
        if !seen.contains("model") {
            return Err("The saved configuration has no model.".into());
        }
        Self::from_fields(fields)?.validated()
    }
}
