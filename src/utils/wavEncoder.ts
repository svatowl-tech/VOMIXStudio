/**
 * ============================================================================
 * HIGH-PERFORMANCE STREAMING WAV ENCODER (CHUNKED & MEMORY-SAFE)
 * ============================================================================
 * Безопасное кодирование WAV для любых длительностей (включая 24+ минутные сессии).
 * Предотвращает RangeError: offset is out of bounds и OOM переполнение памяти:
 * - Чанковая генерация (chunked Uint8Array buffers)
 * - Потоковое формирование Blob из независимых чанков без единого гигантского ArrayBuffer
 * - Поддержка 16-bit PCM, 24-bit PCM и 32-bit Float
 * ============================================================================
 */

export type WavBitDepth = 16 | 24 | 32;

/**
 * Создание стандартного 44-байтного RIFF/WAVE заголовка
 */
export function createWavHeader(
  numFrames: number,
  sampleRate: number = 48000,
  numChannels: number = 2,
  bitDepth: WavBitDepth = 24
): Uint8Array {
  const bytesPerSample = bitDepth === 32 ? 4 : bitDepth === 24 ? 3 : 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const totalFileSize = 44 + dataSize;

  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);

  // RIFF chunk descriptor
  header[0] = 0x52; // 'R'
  header[1] = 0x49; // 'I'
  header[2] = 0x46; // 'F'
  header[3] = 0x46; // 'F'

  // ChunkSize = 36 + dataSize (зажимаем в 0xFFFFFFFF если переполнение 4ГБ)
  const chunkSize = totalFileSize > 8 ? Math.min(0xffffffff, totalFileSize - 8) : 36;
  view.setUint32(4, chunkSize, true);

  header[8] = 0x57;  // 'W'
  header[9] = 0x41;  // 'A'
  header[10] = 0x56; // 'V'
  header[11] = 0x45; // 'E'

  // "fmt " sub-chunk
  header[12] = 0x66; // 'f'
  header[13] = 0x6d; // 'm'
  header[14] = 0x74; // 't'
  header[15] = 0x20; // ' '

  view.setUint32(16, 16, true); // Subchunk1Size = 16 for PCM
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 1 = PCM, 3 = IEEE Float
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // "data" sub-chunk
  header[36] = 0x64; // 'd'
  header[37] = 0x61; // 'a'
  header[38] = 0x74; // 't'
  header[39] = 0x61; // 'a'

  view.setUint32(40, Math.min(0xffffffff, dataSize), true);

  return header;
}

/**
 * Чанковое кодирование стереоканалов в Blob WAV без риска переполнения кучи и RangeError
 */
export function encodeWavToBlob(
  leftChannel: Float32Array,
  rightChannel?: Float32Array | null,
  sampleRate: number = 48000,
  bitDepth: WavBitDepth = 24
): Blob {
  const numFrames = leftChannel.length;
  const isStereo = !!rightChannel && rightChannel.length > 0;
  const numChannels = isStereo ? 2 : 1;

  const header = createWavHeader(numFrames, sampleRate, numChannels, bitDepth);
  const chunks: Uint8Array[] = [header];

  // Размер одного обрабатываемого блока фреймов (65 536 фреймов ~ 393 КБ в 24-бит стерео)
  const CHUNK_FRAMES = 65536;
  const bytesPerSample = bitDepth === 32 ? 4 : bitDepth === 24 ? 3 : 2;
  const blockAlign = numChannels * bytesPerSample;

  for (let frameOffset = 0; frameOffset < numFrames; frameOffset += CHUNK_FRAMES) {
    const currentFrames = Math.min(CHUNK_FRAMES, numFrames - frameOffset);
    const chunkBytes = currentFrames * blockAlign;
    const chunkU8 = new Uint8Array(chunkBytes);

    if (bitDepth === 16) {
      const view16 = new Int16Array(chunkU8.buffer);
      if (isStereo && rightChannel) {
        for (let i = 0; i < currentFrames; i++) {
          const idx = frameOffset + i;
          let l = leftChannel[idx];
          let r = rightChannel[idx];
          if (l < -1) l = -1; else if (l > 1) l = 1;
          if (r < -1) r = -1; else if (r > 1) r = 1;
          view16[i * 2] = l < 0 ? Math.round(l * 0x8000) : Math.round(l * 0x7fff);
          view16[i * 2 + 1] = r < 0 ? Math.round(r * 0x8000) : Math.round(r * 0x7fff);
        }
      } else {
        for (let i = 0; i < currentFrames; i++) {
          let s = leftChannel[frameOffset + i];
          if (s < -1) s = -1; else if (s > 1) s = 1;
          view16[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        }
      }
    } else if (bitDepth === 24) {
      let byteIdx = 0;
      if (isStereo && rightChannel) {
        for (let i = 0; i < currentFrames; i++) {
          const idx = frameOffset + i;
          let l = leftChannel[idx];
          let r = rightChannel[idx];
          if (l < -1) l = -1; else if (l > 1) l = 1;
          if (r < -1) r = -1; else if (r > 1) r = 1;
          const valL = Math.round(l < 0 ? l * 0x800000 : l * 0x7fffff);
          const valR = Math.round(r < 0 ? r * 0x800000 : r * 0x7fffff);

          chunkU8[byteIdx++] = valL & 0xff;
          chunkU8[byteIdx++] = (valL >> 8) & 0xff;
          chunkU8[byteIdx++] = (valL >> 16) & 0xff;

          chunkU8[byteIdx++] = valR & 0xff;
          chunkU8[byteIdx++] = (valR >> 8) & 0xff;
          chunkU8[byteIdx++] = (valR >> 16) & 0xff;
        }
      } else {
        for (let i = 0; i < currentFrames; i++) {
          let s = leftChannel[frameOffset + i];
          if (s < -1) s = -1; else if (s > 1) s = 1;
          const val = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
          chunkU8[byteIdx++] = val & 0xff;
          chunkU8[byteIdx++] = (val >> 8) & 0xff;
          chunkU8[byteIdx++] = (val >> 16) & 0xff;
        }
      }
    } else {
      // 32-bit IEEE Float
      const viewF32 = new Float32Array(chunkU8.buffer);
      if (isStereo && rightChannel) {
        for (let i = 0; i < currentFrames; i++) {
          const idx = frameOffset + i;
          viewF32[i * 2] = leftChannel[idx];
          viewF32[i * 2 + 1] = rightChannel[idx];
        }
      } else {
        for (let i = 0; i < currentFrames; i++) {
          viewF32[i] = leftChannel[frameOffset + i];
        }
      }
    }

    chunks.push(chunkU8);
  }

  return new Blob(chunks as unknown as BlobPart[], { type: 'audio/wav' });
}

/**
 * Чанковое кодирование интерливнутого стерео/моно Float32Array в Blob WAV
 */
export function encodeInterleavedToWavBlob(
  interleaved: Float32Array,
  sampleRate: number = 48000,
  channels: number = 2,
  bitDepth: WavBitDepth = 24
): Blob {
  const numFrames = Math.floor(interleaved.length / channels);
  const header = createWavHeader(numFrames, sampleRate, channels, bitDepth);
  const chunks: Uint8Array[] = [header];

  const CHUNK_FRAMES = 65536;
  const bytesPerSample = bitDepth === 32 ? 4 : bitDepth === 24 ? 3 : 2;
  const blockAlign = channels * bytesPerSample;

  for (let frameOffset = 0; frameOffset < numFrames; frameOffset += CHUNK_FRAMES) {
    const currentFrames = Math.min(CHUNK_FRAMES, numFrames - frameOffset);
    const chunkBytes = currentFrames * blockAlign;
    const chunkU8 = new Uint8Array(chunkBytes);

    if (bitDepth === 16) {
      const view16 = new Int16Array(chunkU8.buffer);
      const totalSamples = currentFrames * channels;
      const startSample = frameOffset * channels;
      for (let i = 0; i < totalSamples; i++) {
        let s = interleaved[startSample + i];
        if (s < -1) s = -1; else if (s > 1) s = 1;
        view16[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      }
    } else if (bitDepth === 24) {
      let byteIdx = 0;
      const totalSamples = currentFrames * channels;
      const startSample = frameOffset * channels;
      for (let i = 0; i < totalSamples; i++) {
        let s = interleaved[startSample + i];
        if (s < -1) s = -1; else if (s > 1) s = 1;
        const val = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        chunkU8[byteIdx++] = val & 0xff;
        chunkU8[byteIdx++] = (val >> 8) & 0xff;
        chunkU8[byteIdx++] = (val >> 16) & 0xff;
      }
    } else {
      // 32-bit Float
      const viewF32 = new Float32Array(chunkU8.buffer);
      const totalSamples = currentFrames * channels;
      const startSample = frameOffset * channels;
      for (let i = 0; i < totalSamples; i++) {
        viewF32[i] = interleaved[startSample + i];
      }
    }

    chunks.push(chunkU8);
  }

  return new Blob(chunks as unknown as BlobPart[], { type: 'audio/wav' });
}
