import { useEffect, useRef, useState } from 'react';
import { OrbRenderer } from './renderers/OrbRenderer';
import type { PresenceRenderer } from './renderer';
import type { PresenceState } from '../../domain/presence';
import type { GenerationMetrics } from '../../domain/types';
import { presenceLabels } from '../../domain/presence';
import { watchWindowVisibility } from '../../services/desktop';

export default function AssistantPresence({
  state,
  metrics,
  size,
  provider,
  cloud = false,
}: {
  state: PresenceState;
  metrics?: GenerationMetrics;
  size: number;
  provider?: string;
  cloud?: boolean;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const renderer = useRef<PresenceRenderer | null>(null);
  const [visualError, setVisualError] = useState('');
  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    const visual = new OrbRenderer();
    renderer.current = visual;
    let windowVisible = true;
    let disposed = false;
    let stopWatching: (() => void) | undefined;
    const visibility = () => visual.setPaused(document.hidden || !windowVisible);
    const observer = new ResizeObserver(() => visual.resize(host.clientWidth));
    try {
      visual.mount(host);
      observer.observe(host);
      visibility();
      document.addEventListener('visibilitychange', visibility);
      void watchWindowVisibility(
        (visible) => {
          windowVisible = visible;
          visibility();
        },
        () => {
          if (!disposed) setVisualError('Window visibility could not be monitored.');
        },
      )
        .then((unlisten) => {
          if (disposed) unlisten();
          else stopWatching = unlisten;
        })
        .catch(() => {
          if (!disposed) setVisualError('Window visibility could not be monitored.');
        });
    } catch {
      setVisualError('Visualization unavailable.');
    }
    return () => {
      disposed = true;
      stopWatching?.();
      document.removeEventListener('visibilitychange', visibility);
      observer.disconnect();
      visual.destroy();
      renderer.current = null;
    };
  }, []);
  useEffect(() => {
    renderer.current?.setState(state);
  }, [state]);
  useEffect(() => {
    const style = getComputedStyle(document.body);
    renderer.current?.setPalette(
      cloud
        ? {
            primary: style.getPropertyValue('--ui-orb-primary').trim(),
            secondary: style.getPropertyValue('--ui-orb-secondary').trim(),
          }
        : null,
    );
  }, [cloud]);
  const value = (number: number | undefined, unit: string, scale = 1) =>
    number === undefined
      ? '—'
      : `${(number / scale).toLocaleString('en-US', { maximumFractionDigits: 1 })}${unit}`;
  return (
    <div className="assistant-presence" data-state={state}>
      <div
        className="presence-stage"
        ref={stage}
        aria-hidden="true"
        style={{ width: size, height: size }}
      />
      <div className="presence-caption">
        <strong>Straggler</strong>
        <span>{presenceLabels[state].label}</span>
      </div>
      <div className="presence-rail-status">{presenceLabels[state].short}</div>
      {visualError && <p className="presence-note">{visualError}</p>}
      {state !== 'offline' && (
        <section className="presence-section" aria-label="Response statistics">
          <h2>This response</h2>
          <dl className="presence-stats">
            <div>
              <dt>Speed</dt>
              <dd title={`Tokens per second, reported by ${provider ?? 'llama-server'}`}>
                {value(metrics?.tokensPerSecond, ' t/s')}
              </dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>{value(metrics?.outputTokens, '')}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd title={`Generation time, reported by ${provider ?? 'llama-server'}`}>
                {value(metrics?.generationMs, ' s', 1000)}
              </dd>
            </div>
            {metrics?.cost !== undefined && (
              <div>
                <dt>Cost</dt>
                <dd
                  title={
                    metrics.costCurrency
                      ? 'Reported by the service'
                      : 'Reported by the service; currency not listed'
                  }
                >
                  {metrics.cost.toLocaleString('en-US', { maximumSignificantDigits: 6 })}
                  {metrics.costCurrency ? ` ${metrics.costCurrency}` : ''}
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </div>
  );
}
