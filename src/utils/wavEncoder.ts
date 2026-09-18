/**
 * ============================================================================
 * RIFF / WAVE HIGH-PERFORMANCE AUDIO ENCODER
 * ============================================================================
 * Высокопроизводительный энкодер PCM буферов (Float32Array) в канонический
 * формат RIFF WAV (16-bit PCM, 24-bit PCM, 32-bit IEEE Float).
 * Полностью автономен, не требует сторонних библиотек, работает с чистой памятью.
 * ============================================================================
 */

export type WavBitDepth = 16 | 24 | 32;

export interface WavEncoderOptions {
  sampleRate: number;
  bitDepth: WavBitDepth;
  numChannels: 1 | 2;
}

/**
 * Создает WAV Blob из одного (моно) или двух (стерео) Float32Array каналов.
 */
export function encodeWAV(
  leftChannel: Float32Array,
  rightChannel?: Float32Array,
  options: Partial<WavEncoderOptions> = {}
): Blob {
  const sampleRate = options.sampleRate || 48000;
  const bitDepth = options.bitDepth || 16;
  const numChannels = rightChannel ? 2 : (options.numChannels || 1);
  const numSamples = leftChannel.length;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const headerSize = 44;
  const totalFileSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalFileSize);
  const view = new DataView(buffer);

  // --- Запись заголовка RIFF WAV ---
  // 1. "RIFF" Chunk Descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalFileSize - 8, true); // File size - 8
  writeString(view, 8, 'WAVE');

  // 2. "fmt " Sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 для PCM)
  // AudioFormat: 1 = PCM (Integer), 3 = IEEE Float
  const audioFormat = bitDepth === 32 ? 3 : 1;
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // 3. "data" Sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // --- Запись аудиоданных (PCM сэмплы) ---
  let offset = 44;

  if (bitDepth === 16) {
    // 16-bit Signed Integer (-32768 .. 32767)
    for (let i = 0; i < numSamples; i++) {
      // Left channel with soft clipping / clamping
      const sL = Math.max(-1, Math.min(1, leftChannel[i]));
      view.setInt16(offset, sL < 0 ? sL * 0x8000 : sL * 0x7FFF, true);
      offset += 2;

      if (numChannels === 2 && rightChannel) {
        const sR = Math.max(-1, Math.min(1, rightChannel[i]));
        view.setInt16(offset, sR < 0 ? sR * 0x8000 : sR * 0x7FFF, true);
        offset += 2;
      }
    }
  } else if (bitDepth === 24) {
    // 24-bit Signed Integer (-8388608 .. 8388607)
    for (let i = 0; i < numSamples; i++) {
      const sL = Math.max(-1, Math.min(1, leftChannel[i]));
      const valL = sL < 0 ? sL * 0x800000 : sL * 0x7FFFFF;
      const intL = Math.floor(valL);
      view.setUint8(offset, intL & 0xFF);
      view.setUint8(offset + 1, (intL >> 8) & 0xFF);
      view.setUint8(offset + 2, (intL >> 16) & 0xFF);
      offset += 3;

      if (numChannels === 2 && rightChannel) {
        const sR = Math.max(-1, Math.min(1, rightChannel[i]));
        const valR = sR < 0 ? sR * 0x800000 : sR * 0x7FFFFF;
        const intR = Math.floor(valR);
        view.setUint8(offset, intR & 0xFF);
        view.setUint8(offset + 1, (intR >> 8) & 0xFF);
        view.setUint8(offset + 2, (intR >> 16) & 0xFF);
        offset += 3;
      }
    }
  } else if (bitDepth === 32) {
    // 32-bit IEEE 754 Floating Point (-1.0 .. 1.0)
    for (let i = 0; i < numSamples; i++) {
      view.setFloat32(offset, leftChannel[i], true);
      offset += 4;

      if (numChannels === 2 && rightChannel) {
        view.setFloat32(offset, rightChannel[i], true);
        offset += 4;
      }
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Записывает ASCII строку в DataView
 */
function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Инициирует браузерное скачивание Blob файла
 */
export function triggerFileDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
