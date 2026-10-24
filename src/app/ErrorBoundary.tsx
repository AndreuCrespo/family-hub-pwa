import { RotateCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { clearRemoteCache } from '../core/remote';
import { t } from '../i18n';

interface State {
  error: Error | null;
}

/**
 * Shows a way out instead of a blank screen when something fails to render,
 * including screens that can't be downloaded after a new version was deployed.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h1>{t('error.title')}</h1>
        <p className="muted">{t('error.text')}</p>
        {/* Downloaded copies (weather, prices) are fetched again: a bad one can't break the app twice. */}
        <button
          type="button"
          className="btn accent"
          onClick={() => {
            clearRemoteCache();
            location.reload();
          }}
        >
          <RotateCw size={18} aria-hidden="true" /> {t('error.reload')}
        </button>
        <details className="crash-details">
          <summary>{t('error.details')}</summary>
          <code>{this.state.error.message}</code>
        </details>
      </div>
    );
  }
}
