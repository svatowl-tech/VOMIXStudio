import React, { useRef, useState } from 'react';
import { Upload, FileAudio, CheckCircle, AlertCircle, Music } from 'lucide-react';

interface AudioUploaderProps {
  trackId: number;
  trackName: string;
  onFileUpload: (file: File, trackId: number) => Promise<void>;
}

export const AudioUploader: React.FC<AudioUploaderProps> = ({ trackId, trackName, onFileUpload }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedFileName, setLoadedFileName] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    setLoading(true);
    setErrorMsg(null);

    try {
      await onFileUpload(file, trackId);
      setLoadedFileName(file.name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Ошибка загрузки файла';
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-slate-300 flex items-center gap-1.5 truncate">
          <Music size={14} className="text-emerald-400 shrink-0" />
          Загрузка WAV/MP3 ({trackName})
        </span>
        {loadedFileName && (
          <span className="text-[10px] text-emerald-400 font-mono flex items-center gap-1 shrink-0">
            <CheckCircle size={12} /> Загружено
          </span>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/wav,audio/mp3,audio/mpeg,audio/ogg,audio/flac"
        onChange={handleFileChange}
        className="hidden"
      />

      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={loading}
        className="w-full py-2 px-3 bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 text-slate-200 text-xs rounded-md transition-all flex items-center justify-center gap-2 cursor-pointer font-medium disabled:opacity-50"
      >
        <Upload size={14} className="text-emerald-400" />
        {loading ? 'Декодирование PCM...' : loadedFileName ? loadedFileName : 'Выберите аудиофайл (.wav, .mp3)'}
      </button>

      {errorMsg && (
        <div className="text-[10px] text-rose-400 font-mono flex items-center gap-1">
          <AlertCircle size={12} /> {errorMsg}
        </div>
      )}
    </div>
  );
};
