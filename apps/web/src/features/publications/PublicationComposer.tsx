import { useEffect, useState } from 'react';
import type { PublicationStatusResponse, PublishingAccount } from './publication-api';
import type { PublicationIntentResponse } from '@sovara-studio/contracts';
import {
  createIntent,
  listAccounts,
  listPublicationStatus,
  removePreview,
  retryPublication,
  uploadPreview,
} from './publication-api';

/** datetime-local is a wall-clock value in the browser's local timezone; the API receives UTC. */
export function localScheduleToUtc(value: string) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error('Choose a valid local date and time.');
  }
  return date.toISOString();
}

export function vkMetadataLinkForSave(value: string): string | null {
  return value.trim() || null;
}

function statusText(status: PublicationStatusResponse) {
  if (status.state === 'published') return 'Published';
  if (status.state === 'retry_wait') {
    return `Retry scheduled${status.nextAttemptAt ? ` for ${new Date(status.nextAttemptAt).toLocaleString()}` : ''}`;
  }
  if (status.state === 'failed') return 'Failed';
  return status.state.replace('_', ' ');
}
export function PublicationComposer() {
  const [accounts, setAccounts] = useState<PublishingAccount[]>([]);
  const [videoId, setVideoId] = useState('');
  const [platform, setPlatform] = useState<'youtube' | 'vk'>('youtube');
  const [accountId, setAccountId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('https://vk.com/sovara_news');
  const [mode, setMode] = useState<'DRAFT' | 'PUBLISH_NOW' | 'SCHEDULED'>('DRAFT');
  const [scheduledAt, setScheduledAt] = useState('');
  const [community, setCommunity] = useState(false);
  const [preview, setPreview] = useState<File>();
  const [message, setMessage] = useState('');
  const [statuses, setStatuses] = useState<PublicationStatusResponse[]>([]);
  const [savedIntent, setSavedIntent] = useState<PublicationIntentResponse | null>(null);
  useEffect(() => {
    void listAccounts()
      .then((value) => setAccounts(value.filter((account) => account.status === 'active')))
      .catch(() => setMessage('Publishing accounts are unavailable.'));
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void listPublicationStatus()
        .then((value) => active && setStatuses(value))
        .catch(() => active && setMessage('Publication status is temporarily unavailable.'));
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const available = accounts.filter((account) => account.platform === platform);
  const submit = async () => {
    try {
      setMessage('');
      const account = available.find((value) => value.id === accountId);
      if (!account) throw new Error('Select an active publishing account.');
      const scheduled = mode === 'SCHEDULED' ? localScheduleToUtc(scheduledAt) : null;
      const created = await createIntent({
        videoId,
        platform,
        publishingAccountId: account.id,
        mode,
        scheduledAt: scheduled,
        title,
        description: description || null,
        link: platform === 'vk' ? vkMetadataLinkForSave(link) : null,
        createCommunityPost: community,
      });
      const intent = preview ? await uploadPreview(created.id, preview, created.revision) : created;
      setSavedIntent(intent);
      setMessage(
        `${platform === 'youtube' ? 'YouTube' : 'VK'} intent saved. No publication has been started.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save publication intent.');
    }
  };
  const removeSavedPreview = async () => {
    if (!savedIntent?.preview) return;
    try {
      setMessage('');
      setSavedIntent(await removePreview(savedIntent.id, savedIntent.revision));
      setPreview(undefined);
      setMessage('Preview removed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not remove preview.');
    }
  };
  const retryFailedPublication = async (status: PublicationStatusResponse) => {
    try {
      setMessage('');
      const retried = await retryPublication(status.id, status.revision);
      setStatuses((current) => current.map((item) => (item.id === retried.id ? retried : item)));
      setMessage('Publication retry queued.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not retry publication.');
    }
  };
  return (
    <section aria-labelledby="publication-composer">
      <h2 id="publication-composer">Publication composer</h2>
      <p>Only READY video IDs can be saved. Saving an intent never starts a publication.</p>
      <label>
        Ready video ID{' '}
        <input value={videoId} onChange={(event) => setVideoId(event.target.value)} required />
      </label>
      <label>
        Platform{' '}
        <select
          value={platform}
          onChange={(event) => {
            setPlatform(event.target.value as 'youtube' | 'vk');
            setAccountId('');
          }}
        >
          <option value="youtube">YouTube</option>
          <option value="vk">VK Video</option>
        </select>
      </label>
      <label>
        Account{' '}
        <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          <option value="">Select account</option>
          {available.map((account) => (
            <option key={account.id} value={account.id}>
              {account.displayName ?? account.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title{' '}
        <input
          maxLength={100}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
      </label>
      <label>
        Description{' '}
        <textarea
          maxLength={platform === 'vk' ? 5000 : undefined}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        Intent{' '}
        <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="DRAFT">Draft</option>
          <option value="PUBLISH_NOW">Publish now</option>
          <option value="SCHEDULED">Scheduled</option>
        </select>
      </label>
      {mode === 'SCHEDULED' && (
        <label>
          Local schedule (your browser timezone; saved as UTC){' '}
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
          />
        </label>
      )}
      {platform === 'vk' && (
        <>
          <label>
            VK metadata link (optional){' '}
            <input
              type="url"
              maxLength={2048}
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://vk.com/sovara_news"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={community}
              onChange={(event) => setCommunity(event.target.checked)}
            />{' '}
            Create post in configured VK community
          </label>
        </>
      )}
      <label>
        Private preview{' '}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => setPreview(event.target.files?.[0])}
        />
      </label>
      <button type="button" onClick={() => void submit()}>
        Save draft
      </button>
      {savedIntent?.preview && (
        <button type="button" onClick={() => void removeSavedPreview()}>
          Remove preview
        </button>
      )}
      {message && <p role="status">{message}</p>}
      <section aria-labelledby="publication-status">
        <h3 id="publication-status">Publication status</h3>
        <p>Updates every 10 seconds. Statuses are grouped by platform and publishing account.</p>
        {statuses.length === 0 ? (
          <p>No publication jobs yet.</p>
        ) : (
          <ul>
            {statuses.map((status) => (
              <li key={status.id}>
                <strong>{status.platform === 'youtube' ? 'YouTube' : 'VK Video'}</strong> account{' '}
                {status.publishingAccountId}: {statusText(status)}
                {status.error && (
                  <span role="alert">
                    {' '}
                    — {status.error.code}: {status.error.message ?? 'No additional error detail'}
                  </span>
                )}
                {status.result && (
                  <span>
                    {' '}
                    — Result:{' '}
                    {status.result.remoteUrl ? (
                      <a href={status.result.remoteUrl}>View published video</a>
                    ) : (
                      status.result.remoteMediaId
                    )}
                  </span>
                )}
                {status.state === 'failed' && (
                  <button type="button" onClick={() => void retryFailedPublication(status)}>
                    Retry publication
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
