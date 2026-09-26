import { IS_PLATFORM } from '../../../shared/utils';

import { expireAuthSession, getStoredAuthToken, storeAuthToken } from '../../../utils/api';
import {
  type AttachmentUploadProgress,
  computeAttachmentProgress,
  startAttachmentProgress,
} from './attachmentProgress';

/*
  Загрузка вложений чата с ходом в процентах (ITO-468, 26.09.26).

  Раньше файлы уходили обычным fetch: у него нет хода отправки, и человек,
  нажавший «отправить» со скриншотом на телефоне, секундами видел поле без
  единого признака жизни. Индикатор на карточке вложения в разметке был, но
  карта процентов нигде не наполнялась — он не показывался никогда.

  XMLHttpRequest отдаёт ход отправки тела (upload.onprogress); проценты по
  файлам считает attachmentProgress.ts.
*/

const readJson = (xhr: XMLHttpRequest): Record<string, unknown> | null => {
  if (!xhr.responseText) return null;
  try {
    const parsed = JSON.parse(xhr.responseText);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Загрузить вложения на /api/assets/files. Ответ и ошибки — те же, что у
 * прежней версии через fetch; дополнительно зовёт onProgress по ходу отправки.
 */
export const uploadAttachmentFiles = (
  files: File[],
  onProgress?: (progress: AttachmentUploadProgress) => void,
): Promise<unknown[]> => {
  if (files.length === 0) {
    return Promise.resolve([]);
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  return new Promise<unknown[]>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/assets/files');

    // Тот же заголовок, что ставит authenticatedFetch.
    const token = getStoredAuthToken();
    if (!IS_PLATFORM && token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    if (onProgress) {
      onProgress(startAttachmentProgress(files));
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || event.total <= 0) return;
        onProgress(computeAttachmentProgress(files, event.loaded, event.total));
      };
    }

    xhr.onload = () => {
      const refreshedToken = xhr.getResponseHeader('X-Refreshed-Token');
      if (refreshedToken) {
        storeAuthToken(refreshedToken);
      }
      if (token && xhr.getResponseHeader('X-Auth-Error')) {
        expireAuthSession();
      }

      const body = readJson(xhr);
      if (xhr.status < 200 || xhr.status >= 300) {
        const message = typeof body?.error === 'string' ? body.error : 'Failed to upload files';
        reject(new Error(message));
        return;
      }
      const attachments = body?.attachments;
      if (!Array.isArray(attachments) || attachments.length !== files.length) {
        reject(new Error('File upload returned an incomplete result'));
        return;
      }
      resolve(attachments);
    };

    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload canceled.'));

    xhr.send(formData);
  });
};
