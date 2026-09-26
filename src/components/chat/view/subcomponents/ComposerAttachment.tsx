import { useEffect, useState } from 'react';
import { FileIcon, Loader2, XIcon } from 'lucide-react';

import { ImageLightbox } from './ChatMessageImages';

interface ComposerAttachmentProps {
  file: File;
  onRemove: () => void;
  uploadProgress?: number;
  error?: string;
}

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const ComposerAttachment = ({ file, onRemove, uploadProgress, error }: ComposerAttachmentProps) => {
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const isImage = file.type.startsWith('image/');

  useEffect(() => {
    if (!isImage) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div className="group relative max-w-full">
      {isImage ? (
        <button
          type="button"
          onClick={() => preview && setExpanded(true)}
          aria-label={`Expand ${file.name}`}
          className="block overflow-hidden rounded-xl border border-border/50 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
        >
          {preview
            ? <img src={preview} alt={file.name} className="h-20 w-20 cursor-zoom-in object-cover" />
            : <div className="h-20 w-20 animate-pulse bg-muted" />}
        </button>
      ) : (
        <div className="flex h-20 w-56 max-w-full items-center gap-3 rounded-xl border border-border/50 bg-background/80 px-3 shadow-sm">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileIcon className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={file.name}>{file.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
          </div>
        </div>
      )}
      {uploadProgress !== undefined && uploadProgress < 100 && (
        // Ход загрузки (ITO-468): затемнение, крутилка и полоска поверх
        // карточки, пока файл уходит на сервер.
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 overflow-hidden rounded-xl bg-black/55"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={uploadProgress}
          aria-label={`${file.name}: ${uploadProgress}%`}
        >
          <Loader2 className="h-5 w-5 animate-spin text-white" aria-hidden />
          <div className="text-xs font-medium tabular-nums text-white">{uploadProgress}%</div>
          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
            <div className="h-full bg-white transition-[width] duration-200" style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}
      {error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-red-500/50">
          <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      )}
      {/* Во время загрузки убрать файл уже нельзя: он всё равно уйдёт с сообщением. */}
      {uploadProgress === undefined && (
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-background focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={`Remove ${file.name}`}
      >
        <XIcon className="h-3 w-3" aria-hidden />
      </button>
      )}
      {expanded && preview && (
        <ImageLightbox src={preview} alt={file.name} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
};

export default ComposerAttachment;
