import {
  Bell,
  ChevronRight,
  Languages,
  LayoutGrid,
  LogOut,
  MapPin,
  Moon,
  Plus,
  Share2,
  Trash2,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../core/app';
import { getTheme, setTheme, THEMES, type ThemePref } from '../../core/theme';
import { APP_VERSION } from '../../core/version';
import { t } from '../../i18n';
import { LangSwitch } from '../../i18n/LangSwitch';
import { LIMITS } from '../../shared/limits';
import type { Member } from '../../shared/types';
import { PageHead, Segmented } from '../../ui/primitives';
import { DashboardEditor } from '../dashboard/DashboardEditor';
import { useDashboardLayout } from '../dashboard/useDashboardLayout';
import { Avatar } from '../members/members';
import { InstallHint } from '../more/InstallHint';
import { updatePushLang } from '../notifications/push';
import { LocationSearch } from '../weather/LocationSearch';
import { InviteSection } from './InviteSection';
import { MemberEditor } from './MemberEditor';
import { NotificationSettings } from './NotificationSettings';

const THEME_LABEL = { auto: 'settings.themeAuto', light: 'settings.themeLight', dark: 'settings.themeDark' } as const;

export default function SettingsPage() {
  const { household, backend, members, user, demo, signOut } = useApp();
  const layout = useDashboardLayout();
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const [theme, setThemeState] = useState<ThemePref>(getTheme);
  const [changingLoc, setChangingLoc] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  // Accounts that joined but haven't said which member they are yet.
  const unclaimed = household.memberUids.filter((uid) => !members.some((m) => m.uid === uid));

  const memberStatus = (m: Member) => {
    if (m.kind === 'child') return t('settings.memberChild');
    if (!m.uid) return t('settings.memberPending');
    return m.uid === user.uid ? t('settings.memberYou') : t('settings.memberAccount');
  };

  return (
    <>
      <PageHead title={t('nav.settings')} sub={demo ? t('settings.demoMode') : (user.email ?? '')} />
      <InstallHint />

      {/* In both languages, so anyone can find it */}
      <h2 className="section-title">
        <Languages size={14} aria-hidden="true" /> Idioma · Language
      </h2>
      <div className="card">
        <LangSwitch
          long
          onChanged={() => {
            // This device's notifications follow the app language
            if (!demo) updatePushLang(backend).catch((e: unknown) => console.warn(e));
          }}
        />
        <p className="tiny muted mt-8">{t('settings.languageHint')}</p>
      </div>

      <h2 className="section-title">
        <Users size={14} aria-hidden="true" /> {t('settings.family')}
      </h2>
      <ul className="list">
        {members.map((m) => (
          <li key={m.id}>
            <button type="button" className="list-item clickable" onClick={() => setEditing(m)}>
              <Avatar member={m} />
              <span className="grow">
                <span className="item-title block">{m.name}</span>
                <span className="item-sub block">{memberStatus(m)}</span>
              </span>
            </button>
          </li>
        ))}
        {unclaimed.map((uid) => (
          <li key={uid} className="list-item">
            <span className="grow">
              <span className="item-title block">{t('settings.unclaimedAccount')}</span>
              <span className="item-sub block">{t('settings.unclaimedHint')}</span>
            </span>
            {uid !== user.uid && (
              <button
                type="button"
                className="icon-btn sm"
                aria-label={t('settings.removeAccount')}
                onClick={() => backend.updateHousehold({ memberUids: household.memberUids.filter((u) => u !== uid) })}
              >
                <Trash2 size={17} />
              </button>
            )}
          </li>
        ))}
        {members.length < LIMITS.members && (
          <li>
            <button type="button" className="list-item clickable muted-strong" onClick={() => setEditing('new')}>
              <Plus size={20} aria-hidden="true" /> <b>{t('settings.addMember')}</b>
            </button>
          </li>
        )}
      </ul>

      {!demo && (
        <>
          <h2 className="section-title">
            <Share2 size={14} aria-hidden="true" /> {t('settings.invite')}
          </h2>
          <InviteSection />
        </>
      )}

      <h2 className="section-title">
        <MapPin size={14} aria-hidden="true" /> {t('settings.weatherLocation')}
      </h2>
      <div className="card stack gap-10">
        {household.location && !changingLoc ? (
          <div className="row">
            <b className="grow">{household.location.name}</b>
            <button type="button" className="btn ghost sm" onClick={() => setChangingLoc(true)}>
              {t('common.change')}
            </button>
          </div>
        ) : (
          <LocationSearch
            onPick={(r) => {
              backend.updateHousehold({ location: { name: r.name, lat: r.lat, lon: r.lon } });
              setChangingLoc(false);
            }}
          />
        )}
      </div>

      <h2 className="section-title">
        <Bell size={14} aria-hidden="true" /> {t('settings.notifications')}
      </h2>
      <NotificationSettings />

      <h2 className="section-title">
        <LayoutGrid size={14} aria-hidden="true" /> {t('nav.home')}
      </h2>
      <div className="list">
        <button
          type="button"
          className="list-item clickable"
          disabled={!layout.loaded}
          onClick={() => setCustomizing(true)}
        >
          <span className="grow">
            <span className="item-title block">{t('dash.customize')}</span>
            <span className="item-sub block">{t('settings.customizeHint')}</span>
          </span>
          <ChevronRight size={18} className="muted" aria-hidden="true" />
        </button>
      </div>

      <h2 className="section-title">
        <Moon size={14} aria-hidden="true" /> {t('settings.appearance')}
      </h2>
      <div className="card">
        <Segmented
          block
          label={t('settings.appearance')}
          value={theme}
          onChange={(th) => {
            setTheme(th);
            setThemeState(th);
          }}
          options={THEMES.map((id) => ({ id, label: t(THEME_LABEL[id]) }))}
        />
      </div>

      <h2 className="section-title">{t('settings.household')}</h2>
      <div className="card stack">
        <HouseholdName />
      </div>

      <div className="mt-24">
        <button type="button" className="btn soft block" onClick={signOut}>
          <LogOut size={18} aria-hidden="true" /> {demo ? t('settings.exitDemo') : t('settings.signOut')}
        </button>
      </div>
      <p className="tiny muted text-center mt-16">Casa {t('settings.version', { version: APP_VERSION })}</p>

      {editing && <MemberEditor member={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {customizing && <DashboardEditor layout={layout} onClose={() => setCustomizing(false)} />}
    </>
  );
}

/** Saved on blur; shows a rename by someone else unless it's being edited here. */
function HouseholdName() {
  const { household, backend } = useApp();
  const [draft, setDraft] = useState(household.name);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(household.name);
  }, [household.name]);

  return (
    <label className="field">
      <span>{t('onboarding.houseName')}</span>
      <input
        value={draft}
        maxLength={LIMITS.householdName}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          editing.current = false;
          const name = draft.trim();
          if (name && name !== household.name) backend.updateHousehold({ name });
          else setDraft(household.name);
        }}
      />
    </label>
  );
}
