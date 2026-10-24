import { useApp, useDoc } from '../../core/app';
import { type MessageKey, t } from '../../i18n';
import { ACTIVITY_KINDS, DAILY_HOURS, resolveNotify } from '../../shared/notify';
import type { ActivityKind, PersonalNotify } from '../../shared/types';
import { PushRow } from './PushRow';

const KIND_LABEL: Record<ActivityKind, MessageKey> = {
  shopping: 'nav.shopping',
  event: 'nav.calendar',
  task: 'nav.tasks',
  menu: 'nav.menu',
  expense: 'nav.expenses',
  date: 'nav.dates',
  note: 'nav.notes',
};

/** Which notifications the signed-in person gets (each person chooses their own). */
export function NotificationSettings() {
  const { backend, household, user } = useApp();
  const prefs = useDoc('prefs', user.uid);
  const n = resolveNotify(household, prefs?.notify);

  const save = (notify: PersonalNotify) => backend.merge('prefs', user.uid, { notify, updatedAt: Date.now() });

  return (
    <div className="card stack gap-4">
      <PushRow />

      <div className="field mt-8 mb-8">
        <span id="notify-kinds">{t('notify.othersAdd')}</span>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own border and legend */}
        <div className="chips" role="group" aria-labelledby="notify-kinds">
          {ACTIVITY_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`chip sm neutral${n.activity[kind] ? ' on' : ''}`}
              aria-pressed={n.activity[kind]}
              disabled={prefs === undefined}
              onClick={() => save({ activity: { [kind]: !n.activity[kind] } })}
            >
              {t(KIND_LABEL[kind])}
            </button>
          ))}
        </div>
      </div>

      <label className="switch">
        {t('notify.reminders')}
        <input
          type="checkbox"
          checked={n.reminders}
          disabled={prefs === undefined}
          onChange={(e) => save({ reminders: e.target.checked })}
        />
      </label>
      <label className="switch">
        {t('notify.keyDates')}
        <input
          type="checkbox"
          checked={n.keyDates}
          disabled={prefs === undefined}
          onChange={(e) => save({ keyDates: e.target.checked })}
        />
      </label>
      <label className="switch">
        {t('settings.dailySummary')}
        <input
          type="checkbox"
          checked={n.daily}
          disabled={prefs === undefined}
          onChange={(e) => save({ daily: e.target.checked })}
        />
      </label>
      {n.daily && (
        <label className="field mb-8">
          <span>{t('settings.summaryTime')}</span>
          <select value={n.dailyHour} onChange={(e) => save({ dailyHour: Number(e.target.value) })}>
            {DAILY_HOURS.map((h) => (
              <option key={h} value={h}>
                {h}:00
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="tiny muted pb-6">{t('notify.personalHint')}</p>
    </div>
  );
}
