import { useEffect, useState } from 'react';
import type { PublicationStatusResponse, PublishingAccount } from './publication-api';
import type { PublicationIntentResponse } from '@sovara-studio/contracts';
import {
  createIntent,
  listAccounts,
  listPublicationStatus,
  publishIntent,
  removePreview,
  retryPublication,
  startVkOAuth,
  startYouTubeOAuth,
  uploadPreview,
} from './publication-api';

export function vkMetadataLinkForSave(value: string): string | null {
  return value.trim() || null;
}

function statusText(status: PublicationStatusResponse) {
  if (status.state === 'published') return 'Опубликовано';
  if (status.state === 'publishing' || status.state === 'reconciling') return 'Публикуется';
  if (status.state === 'failed' || status.state === 'manual_review' || status.state === 'cancelled') return 'Ошибка';
  return 'Ожидает';
}

function statusClass(status: PublicationStatusResponse) {
  if (status.state === 'published') return '';
  if (status.state === 'publishing' || status.state === 'reconciling') return 'publishing';
  if (status.state === 'failed' || status.state === 'manual_review' || status.state === 'cancelled') return 'error';
  return 'pending';
}

export function PublicationComposer({ readyVideoId }: { readyVideoId?: string }) {
  const [accounts, setAccounts] = useState<PublishingAccount[]>([]);
  const [videoId, setVideoId] = useState('');
  const [platform, setPlatform] = useState<'youtube' | 'vk'>('youtube');
  const [accountId, setAccountId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('https://vk.com/sovara_news');
  const [community, setCommunity] = useState(false);
  const [preview, setPreview] = useState<File>();
  const [message, setMessage] = useState('');
  const [statuses, setStatuses] = useState<PublicationStatusResponse[]>([]);
  const [savedIntent, setSavedIntent] = useState<PublicationIntentResponse | null>(null);
  const [publishing, setPublishing] = useState(false);
  useEffect(() => {
    if (readyVideoId) setVideoId(readyVideoId);
  }, [readyVideoId]);
  useEffect(() => {
    void listAccounts()
      .then((value) => setAccounts(value.filter((account) => account.status === 'active')))
      .catch(() => setMessage('Аккаунты для публикации временно недоступны.'));
  }, []);
  const refreshAccounts = async () => {
    try {
      setAccounts((await listAccounts()).filter((account) => account.status === 'active'));
    } catch {
      setMessage('Аккаунты для публикации временно недоступны.');
    }
  };
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void listPublicationStatus()
        .then((value) => active && setStatuses(value))
        .catch(() => active && setMessage('Статусы публикаций временно недоступны.'));
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const available = accounts.filter((account) => account.platform === platform);
  const accountsFor = (value: 'youtube' | 'vk') => accounts.filter((account) => account.platform === value);
  const connect = async (value: 'youtube' | 'vk') => {
    try {
      setMessage('');
      const { authorizationUrl } = value === 'youtube' ? await startYouTubeOAuth() : await startVkOAuth();
      const popup = window.open(authorizationUrl, `sovara-${value}-oauth`, 'popup,width=600,height=700');
      if (!popup) throw new Error('Разрешите всплывающие окна, чтобы подключить аккаунт.');
      const refreshAfterOAuth = () => {
        window.removeEventListener('focus', refreshAfterOAuth);
        void refreshAccounts();
      };
      window.addEventListener('focus', refreshAfterOAuth);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось начать подключение аккаунта.');
    }
  };
  const selectPlatform = (value: 'youtube' | 'vk') => {
    setPlatform(value);
    setAccountId('');
  };
  const submit = async () => {
    try {
      setMessage('');
      const account = available.find((value) => value.id === accountId);
      if (!account) throw new Error('Выберите аккаунт в настройках.');
      const created = await createIntent({
        videoId,
        platform,
        publishingAccountId: account.id,
        mode: 'DRAFT',
        scheduledAt: null,
        title,
        description: description || null,
        link: platform === 'vk' ? vkMetadataLinkForSave(link) : null,
        createCommunityPost: community,
      });
      const intent = preview ? await uploadPreview(created.id, preview, created.revision) : created;
      setSavedIntent(intent);
      setMessage(`${platform === 'youtube' ? 'YouTube' : 'VK Video'}: черновик сохранён. Публикация не запускалась.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось сохранить черновик.');
    }
  };
  const publishNow = async () => {
    if (!savedIntent || publishing) return;
    try {
      setPublishing(true);
      setMessage('');
      await publishIntent(savedIntent.id, savedIntent.revision);
      setStatuses(await listPublicationStatus());
      setMessage('Публикация поставлена в очередь.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось запустить публикацию.');
    } finally {
      setPublishing(false);
    }
  };
  const removeSavedPreview = async () => {
    if (!savedIntent?.preview) return;
    try {
      setMessage('');
      setSavedIntent(await removePreview(savedIntent.id, savedIntent.revision));
      setPreview(undefined);
      setMessage('Обложка удалена из черновика.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось удалить обложку.');
    }
  };
  const retryFailedPublication = async (status: PublicationStatusResponse) => {
    try {
      setMessage('');
      const retried = await retryPublication(status.id, status.revision);
      setStatuses((current) => current.map((item) => (item.id === retried.id ? retried : item)));
      setMessage('Повторная публикация поставлена в очередь.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось повторить публикацию.');
    }
  };
  const published = statuses.filter((status) => status.state === 'published').length;
  const publishingCount = statuses.filter((status) => status.state === 'publishing' || status.state === 'reconciling').length;
  const failed = statuses.filter((status) => status.state === 'failed' || status.state === 'manual_review' || status.state === 'cancelled').length;
  return (
    <section className="panel" aria-labelledby="publication-composer">
      <div className="panel-header">
        <div><h2 id="publication-composer">Публикация</h2><p>Сохранение черновика никогда не запускает публикацию.</p></div>
        <span className="badge pending">{videoId ? 'Видео выбрано' : 'Нужно READY видео'}</span>
      </div>
      <div className="panel-body composer">
        <div className="card">
          <div className="section-title"><div><h2>Что сделать с видео</h2><p>Аккаунты и технический ID находятся в настройках.</p></div></div>
          <fieldset className="field"><legend>Куда отправить</legend><div className="destinations">
            <button className={`destination ${platform === 'youtube' ? 'active' : ''}`} type="button" onClick={() => selectPlatform('youtube')}>YouTube</button>
            <button className={`destination ${platform === 'vk' ? 'active' : ''}`} type="button" onClick={() => selectPlatform('vk')}>VK Video</button>
          </div></fieldset>
          <div className="form-grid" style={{ marginTop: 14 }}>
            <label className="field wide"><span>Заголовок</span><input maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
            <label className="field wide"><span>Описание</span><textarea maxLength={platform === 'vk' ? 5000 : undefined} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            {platform === 'vk' && <>
              <label className="field wide"><span>Ссылка в метаданных VK (необязательно)</span><input type="url" maxLength={2048} value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://vk.com/sovara_news" /></label>
              <label><input type="checkbox" checked={community} onChange={(event) => setCommunity(event.target.checked)} /> Создать пост в настроенном сообществе VK</label>
            </>}
            <label className="field wide"><span>Обложка (необязательно)</span><div className="preview-control"><div className="preview-placeholder">16:9</div><div><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setPreview(event.target.files?.[0])} />{preview && <p className="muted">{preview.name}</p>}</div></div></label>
          </div>
          <div className="actions"><button type="button" onClick={() => void submit()}>Сохранить черновик</button>{savedIntent && <button className="primary" type="button" disabled={publishing} onClick={() => void publishNow()}>{publishing ? 'Публикуем…' : 'Опубликовать сейчас'}</button>}{savedIntent?.preview && <button className="danger" type="button" onClick={() => void removeSavedPreview()}>Удалить обложку</button>}</div>
          {message && <p className="notice" role="status">{message}</p>}
        </div>
        <aside className="card status-card" aria-labelledby="publication-status">
          <div className="status-head"><div><h3 id="publication-status">Статус публикаций</h3><p>Обновляется каждые 10 секунд.</p></div></div>
          <div className="status-summary"><div className="stat"><span>Готово</span><b>{published}</b></div><div className="stat"><span>В работе</span><b>{publishingCount}</b></div><div className="stat"><span>Ошибки</span><b>{failed}</b></div></div>
          {statuses.length === 0 ? <p className="notice">Пока нет задач публикации.</p> : <ul className="status-list">{statuses.map((status) => <li className="status-item" key={status.id}><div className="status-top"><span className="provider">{status.platform === 'youtube' ? 'YouTube' : 'VK Video'}</span><span className={`badge ${statusClass(status)}`}>{statusText(status)}</span></div><div className="status-sub">Аккаунт: {status.publishingAccountId}</div>{status.error && <div className="status-detail" role="alert">Причина: {status.error.code}: {status.error.message ?? 'без деталей'}</div>}{status.result && <div className={`status-detail ${status.state === 'published' ? 'success' : ''}`}>{status.result.remoteUrl ? <a href={status.result.remoteUrl}>Открыть опубликованное видео</a> : status.result.remoteMediaId}</div>}{status.state === 'failed' && <div className="actions"><button type="button" onClick={() => void retryFailedPublication(status)}>Повторить публикацию</button></div>}</li>)}</ul>}
        </aside>
      </div>
      <dialog id="studio-settings" aria-labelledby="settings-title"><div className="dialog-head"><h2 id="settings-title">Настройки SOVARA Studio</h2><button type="button" onClick={(event) => event.currentTarget.closest('dialog')?.close()}>Закрыть</button></div><div className="settings-grid">
        {(['youtube', 'vk'] as const).map((value) => <section className="setting-card" key={value}><h3>{value === 'youtube' ? 'YouTube' : 'VK Video'}</h3><label className="field"><span>Аккаунт</span><div className="account-row"><select aria-label={`Аккаунт ${value === 'youtube' ? 'YouTube' : 'VK'}`} value={platform === value ? accountId : ''} onChange={(event) => { setPlatform(value); setAccountId(event.target.value); }}><option value="">Выберите аккаунт</option>{accountsFor(value).map((account) => <option key={account.id} value={account.id}>{account.displayName ?? account.id}</option>)}</select><button className="connect-button" type="button" onClick={() => void connect(value)}>Подключить</button></div></label></section>)}
        <section className="setting-card"><h3>Технические данные</h3><label className="field"><span>Ready Video ID</span><input className="technical" value={videoId} onChange={(event) => setVideoId(event.target.value)} placeholder="UUID готового видео" /></label><p className="muted">Автоматически заполняется после готовности только что загруженного видео.</p></section>
      </div></dialog>
    </section>
  );
}
