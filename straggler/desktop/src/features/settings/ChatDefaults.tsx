import { useId, useState } from 'react';
import { Info } from 'lucide-react';
import { InsertPreset } from '../prompts/PromptPresets';
import NumberField from '../../components/NumberField';
import FieldError from '../../components/FieldError';
import Select from '../../components/Select';
import Feedback from '../../components/Feedback';
import { samplingKeys, samplingPreset } from '../../domain/types';
import { fieldScope } from '../../domain/chatDefaults';
import { compactionThresholdPercent } from '../../domain/chat';
import type { SettingsController } from './useSettings';
import type { CloudController } from '../cloud/useCloudModels';
import useChatDefaults from './useChatDefaults';

const sampling = {
  temperature: ['Temperature', 'Higher is more varied, lower more predictable.'],
  top_p: ['Top-P', 'Keeps the most likely words that add up to this share.'],
  top_k: ['Top-K', 'Keeps only this many of the most likely words.'],
  min_p: ['Min-P', 'Drops words far less likely than the best one.'],
  repeat_penalty: ['Repeat penalty', 'Discourages repeating recent words.'],
  presence_penalty: ['Presence penalty', 'Encourages words not used yet.'],
  frequency_penalty: ['Frequency penalty', 'Discourages words that appear often.'],
};

export default function ChatDefaults({
  controller,
  cloud,
  defaults,
}: {
  controller: SettingsController;
  cloud: CloudController;
  defaults: ReturnType<typeof useChatDefaults>;
}) {
  const id = useId();
  const { values, errors, failure, change, flush } = defaults;
  const [expanded, setExpanded] = useState(false);
  const preset = samplingPreset(
    { ...controller.config.settings, ...values },
    controller.config.presets,
  );
  return (
    <>
      {failure && (
        <Feedback title="Couldn’t save your chat defaults." details={failure}>
          Your edits are kept. Try again.
        </Feedback>
      )}
      <h3>System prompt</h3>
      <InsertPreset onInsert={(text) => change({ chat_system_prompt: text }, true)} />
      <label className="setting-field">
        <span>Default system prompt</span>
        <textarea
          className="settings-textarea"
          aria-label="Default system prompt"
          aria-describedby={`${id}-prompt-help${errors.chat_system_prompt ? ` ${id}-prompt-error` : ''}`}
          aria-invalid={!!errors.chat_system_prompt || undefined}
          rows={4}
          value={values.chat_system_prompt}
          onChange={(event) => change({ chat_system_prompt: event.target.value })}
          onBlur={flush}
        />
        <small id={`${id}-prompt-help`}>
          Used in every new chat. Leave empty for the model’s default.
        </small>
        <FieldError id={`${id}-prompt-error`} message={errors.chat_system_prompt} />
      </label>
      <div className="setting-switch">
        <div className="settings-note-group">
          <label htmlFor={`${id}-compact`}>Summarize long chats automatically</label>
          <p id={`${id}-compact-help`} className="field-help">
            Summarizes earlier messages before sending at {compactionThresholdPercent}% context
            usage or higher.
          </p>
        </div>
        <button
          type="button"
          id={`${id}-compact`}
          className="toggle-switch"
          role="switch"
          aria-checked={values.chat_auto_compact === 'on'}
          aria-describedby={`${id}-compact-help`}
          onClick={() =>
            change({ chat_auto_compact: values.chat_auto_compact === 'on' ? 'off' : 'on' }, true)
          }
        />
      </div>
      <div className="settings-note-group">
        <fieldset className="choice-group" aria-describedby={`${id}-reasoning-help`}>
          <legend>Reasoning</legend>
          <div className="segmented">
            {(['auto', 'on', 'off'] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`${id}-reasoning`}
                  checked={values.chat_reasoning === value}
                  onChange={() => change({ chat_reasoning: value }, true)}
                />
                <span>{value === 'auto' ? 'Model default' : value === 'on' ? 'On' : 'Off'}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p id={`${id}-reasoning-help`} className="field-help">
          Applies where the model supports it. Choose the effort per chat, or set a default for the
          model on this computer in Model settings.
        </p>
      </div>
      <h3>Replies</h3>
      <label className="setting-field">
        <span>
          Reply style <code className="tech-term">Sampling preset</code>
        </span>
        <Select
          aria-label="Reply style"
          aria-describedby={`${id}-preset-help`}
          value={preset}
          onChange={(value) => {
            if (value === 'custom') setExpanded(true);
            const selected = controller.config.presets[value];
            if (selected)
              change(
                Object.fromEntries(samplingKeys.map((key, index) => [key, selected[index]])),
                true,
              );
          }}
          options={['default', 'focused', 'exploratory', 'min-p', 'custom'].map((value) => ({
            value,
            label: value === 'min-p' ? 'Min-P' : value.charAt(0).toUpperCase() + value.slice(1),
          }))}
        />
        <small id={`${id}-preset-help`}>
          Presets for the values below. Seed, reply length, context and performance don’t change.
        </small>
      </label>
      <details
        className="sampling-details"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
        open={expanded || samplingKeys.some((key) => errors[key]) ? true : undefined}
      >
        <summary>Fine-tune reply style</summary>
        <p className="field-help">Leave a field empty to use the model’s default.</p>
        {samplingKeys.map((key) => (
          <NumberField
            key={key}
            label={sampling[key][0]}
            hint={sampling[key][1]}
            value={values[key]}
            error={errors[key]}
            scope={fieldScope(key, cloud.status)}
            onChange={(value) => change({ [key]: value })}
            onBlur={flush}
          />
        ))}
      </details>
      <div className="field-grid related-fields">
        <NumberField
          label="Seed"
          value={values.seed}
          error={errors.seed}
          scope={fieldScope('seed', cloud.status)}
          onChange={(value) => change({ seed: value })}
          onBlur={flush}
          hint="The same seed repeats a result where the model supports it. -1 is random."
        />
        <NumberField
          label="Longest reply (tokens)"
          value={values.max_tokens}
          error={errors.max_tokens}
          scope={fieldScope('max_tokens', cloud.status)}
          onChange={(value) => change({ max_tokens: value })}
          onBlur={flush}
          hint="Auto, a number, or -1 for no limit."
        />
      </div>
      <p className="scope-note">
        <Info size={16} aria-hidden="true" />
        <span>
          <strong>Sent with every message.</strong> A value a service doesn’t accept isn’t sent; the
          field says which.
          {cloud.status.providers.some(
            (provider) => provider.saved && provider.kind === 'deepseek',
          ) && ' DeepSeek ignores temperature and penalties while thinking.'}
        </span>
      </p>
    </>
  );
}
