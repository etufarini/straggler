//! Request generation settings and the cloud parameter contract have one owner.
use crate::{cloud::ProviderKind, configuration::settings::SAMPLING_FIELDS, Result, Settings};
use serde_json::{Map, Number, Value};
use std::collections::BTreeMap;

pub fn fields() -> impl Iterator<Item = &'static str> {
    SAMPLING_FIELDS
        .iter()
        .copied()
        .chain(["seed", "max_tokens"])
}

pub fn chat_default_fields() -> impl Iterator<Item = &'static str> {
    ["chat_system_prompt", "chat_reasoning", "chat_auto_compact"]
        .into_iter()
        .chain(fields())
}

pub fn wire_name(kind: ProviderKind, field: &str) -> Option<&str> {
    match (kind, field) {
        (ProviderKind::OpenRouter, "repeat_penalty") => Some("repetition_penalty"),
        (ProviderKind::Mistral, "seed") => Some("random_seed"),
        (_, "temperature" | "top_p" | "presence_penalty" | "frequency_penalty" | "max_tokens") => {
            Some(field)
        }
        (ProviderKind::OpenRouter, "top_k" | "min_p" | "seed") => Some(field),
        // Mistral's official Chat Completion schema advertises top_k (checked 2026-11-21).
        (ProviderKind::Mistral, "top_k") | (ProviderKind::Custom, "seed") => Some(field),
        _ => None,
    }
}

pub fn provider_parameters() -> BTreeMap<String, Vec<&'static str>> {
    [
        ProviderKind::OpenRouter,
        ProviderKind::DeepSeek,
        ProviderKind::Mistral,
        ProviderKind::Custom,
    ]
    .into_iter()
    .map(|kind| {
        let name = serde_json::to_value(kind)
            .expect("Provider kinds serialize as names")
            .as_str()
            .unwrap()
            .to_owned();
        (
            name,
            fields()
                .filter(|field| wire_name(kind, field).is_some())
                .collect(),
        )
    })
    .collect()
}

fn supported_wire_name<'a>(
    provider: ProviderKind,
    supported: Option<&[String]>,
    field: &'a str,
) -> Option<&'a str> {
    let name = wire_name(provider, field)?;
    if provider == ProviderKind::OpenRouter
        && supported.is_some_and(|values| !values.iter().any(|value| value == name))
    {
        return None;
    }
    Some(name)
}

pub fn output_limit_supported(provider: ProviderKind, supported: Option<&[String]>) -> bool {
    supported_wire_name(provider, supported, "max_tokens").is_some()
}

pub fn parameters(
    settings: &Settings,
    provider: Option<ProviderKind>,
    supported: Option<&[String]>,
    limit: Option<u32>,
) -> Result<Map<String, Value>> {
    if limit == Some(0) {
        return Err("The response token limit must be positive.".into());
    }
    if limit.is_some() && provider.is_some_and(|kind| !output_limit_supported(kind, supported)) {
        return Err("The selected cloud model does not support a response token limit.".into());
    }
    let settings = settings.fields();
    let mut parameters = Map::new();
    for field in fields() {
        let name = match provider {
            Some(kind) => match supported_wire_name(kind, supported, field) {
                Some(name) => name,
                None => continue,
            },
            None => field,
        };
        let value = if field == "max_tokens" {
            limit
                .map(|value| value.to_string())
                .unwrap_or_else(|| settings[field].clone())
        } else {
            settings[field].clone()
        };
        if value == "auto" {
            continue;
        }
        let number: Number = serde_json::from_str(&value)
            .map_err(|error| format!("Invalid {field} generation value: {error}"))?;
        // Cloud token limits must be positive; -1/no-limit and 0 remain valid local settings.
        if provider.is_some()
            && field == "max_tokens"
            && number.as_i64().is_some_and(|value| value <= 0)
        {
            continue;
        }
        parameters.insert(name.into(), Value::Number(number));
    }
    Ok(parameters)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn local_values_omit_auto_and_compaction_overrides_the_default() {
        let mut settings = Settings::default();
        assert!(parameters(&settings, None, None, None).unwrap().is_empty());
        settings.temperature = "0.6".into();
        settings.seed = "-1".into();
        settings.max_tokens = "2048".into();
        assert_eq!(
            Value::Object(parameters(&settings, None, None, Some(512)).unwrap()),
            json!({"temperature":0.6,"seed":-1,"max_tokens":512})
        );
        assert!(parameters(&settings, None, None, Some(0)).is_err());
    }

    #[test]
    fn providers_rename_filter_and_intersect_advertised_parameters() {
        let mut values = Settings::default().fields();
        for field in fields() {
            values.insert(field.into(), "1".into());
        }
        let settings = Settings::from_fields(values).unwrap().validated().unwrap();
        let router = parameters(&settings, Some(ProviderKind::OpenRouter), None, None).unwrap();
        assert_eq!(router.len(), 9);
        assert_eq!(router["repetition_penalty"], 1);
        assert!(!router.contains_key("repeat_penalty"));
        let supported = vec![
            "temperature".into(),
            "repetition_penalty".into(),
            "max_tokens".into(),
        ];
        assert_eq!(
            Value::Object(
                parameters(
                    &settings,
                    Some(ProviderKind::OpenRouter),
                    Some(&supported),
                    Some(42)
                )
                .unwrap()
            ),
            json!({"temperature":1,"repetition_penalty":1,"max_tokens":42})
        );
        assert!(
            parameters(&settings, Some(ProviderKind::OpenRouter), Some(&[]), None)
                .unwrap()
                .is_empty()
        );
        let mistral = parameters(&settings, Some(ProviderKind::Mistral), None, None).unwrap();
        assert_eq!(mistral["random_seed"], 1);
        assert_eq!(mistral["top_k"], 1);
        assert!(!mistral.contains_key("min_p"));
        assert!(!mistral.contains_key("repeat_penalty"));
        for provider in [ProviderKind::DeepSeek, ProviderKind::Custom] {
            let result = parameters(&settings, Some(provider), None, None).unwrap();
            assert!(!result.contains_key("top_k"));
            assert!(!result.contains_key("min_p"));
            assert_eq!(
                result.contains_key("seed"),
                provider == ProviderKind::Custom
            );
        }
    }

    #[test]
    fn frontend_fixture_uses_the_native_provider_contract() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/generation-parameters.json"
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(provider_parameters()).unwrap(),
            fixture
        );
    }
}
