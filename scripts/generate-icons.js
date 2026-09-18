import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

console.log('🎨 Генерируем полный набор ассетов иконы VOMIXStudio для Windows / Tauri v2...');

// Директории
const tauriIconsDir = path.resolve('./src-tauri/icons');
const publicDir = path.resolve('./public');

if (!fs.existsSync(tauriIconsDir)) {
  fs.mkdirSync(tauriIconsDir, { recursive: true });
}
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Простой генератор сырых RGBA PNG изображений без внешних npm зависимостей
function createPNG(width, height, drawPixel) {
  const bytesPerPixel = 4;
  const rowSize = width * bytesPerPixel + 1; // +1 для фильтра нулевого типа (Filter 0)
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter type 0 (None)

    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * bytesPerPixel;
      const [r, g, b, a] = drawPixel(x, y, width, height);
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawData);

  // CRC32 Таблица
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
  }

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);

    const typeBuf = Buffer.from(type, 'ascii');
    const typeAndData = Buffer.concat([typeBuf, data]);

    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(typeAndData), 0);

    return Buffer.concat([lenBuf, typeAndData, crcBuf]);
  }

  // PNG Header (Signature)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR Chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth: 8
  ihdr[9] = 6; // Color type: 6 (RGBA)
  ihdr[10] = 0; // Compression
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // IDAT Chunk
  const idatChunk = makeChunk('IDAT', compressedData);

  // IEND Chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Градиент VOMIXStudio (Фиолетово-изумрудная волна)
function drawVomixLogo(x, y, w, h) {
  const nx = x / w;
  const ny = y / h;

  // Радиальный градиент фона
  const dx = nx - 0.5;
  const dy = ny - 0.5;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Базовый скругленный квадрат
  const cornerRadius = 0.2;
  const inX = Math.abs(nx - 0.5);
  const inY = Math.abs(ny - 0.5);
  const isInsideCard = inX < 0.46 && inY < 0.46;

  if (!isInsideCard) {
    return [0, 0, 0, 0]; // Прозрачные углы
  }

  // Эквалайзер волна VOMIX
  const wave1 = Math.sin(nx * Math.PI * 4) * 0.15 + 0.5;
  const wave2 = Math.cos(nx * Math.PI * 3) * 0.1 + 0.5;

  const isWavePixel = Math.abs(ny - wave1) < 0.06 || Math.abs(ny - wave2) < 0.04;

  if (isWavePixel) {
    // Яркая неоновая волна
    return [52, 211, 153, 255]; // emerald-400
  }

  // Фиолетовый градиент фона
  const r = Math.round(15 + nx * 60);
  const g = Math.round(20 + ny * 30);
  const b = Math.round(40 + (1 - dist) * 120);

  return [r, g, b, 255];
}

// Размеры икон для сгенерирования
const sizes = [
  { name: '32x32.png', width: 32, height: 32, dir: tauriIconsDir },
  { name: '128x128.png', width: 128, height: 128, dir: tauriIconsDir },
  { name: '128x128@2x.png', width: 256, height: 256, dir: tauriIconsDir },
  { name: 'Square30x30Logo.png', width: 30, height: 30, dir: tauriIconsDir },
  { name: 'Square44x44Logo.png', width: 44, height: 44, dir: tauriIconsDir },
  { name: 'Square71x71Logo.png', width: 71, height: 71, dir: tauriIconsDir },
  { name: 'Square89x89Logo.png', width: 89, height: 89, dir: tauriIconsDir },
  { name: 'Square107x107Logo.png', width: 107, height: 107, dir: tauriIconsDir },
  { name: 'Square142x142Logo.png', width: 142, height: 142, dir: tauriIconsDir },
  { name: 'Square150x150Logo.png', width: 150, height: 150, dir: tauriIconsDir },
  { name: 'Square284x284Logo.png', width: 284, height: 284, dir: tauriIconsDir },
  { name: 'Square310x310Logo.png', width: 310, height: 310, dir: tauriIconsDir },
  { name: 'StoreLogo.png', width: 50, height: 50, dir: tauriIconsDir },
  { name: 'icon.png', width: 512, height: 512, dir: publicDir },
];

for (const iconSpec of sizes) {
  const pngBuffer = createPNG(iconSpec.width, iconSpec.height, drawVomixLogo);
  const targetPath = path.join(iconSpec.dir, iconSpec.name);
  fs.writeFileSync(targetPath, pngBuffer);
  console.log(`  ✓ Сгенерирована икона: ${targetPath} (${iconSpec.width}x${iconSpec.height})`);
}

// Копируем икону в icon.ico для совместимости с Windows
const icoBuffer = createPNG(256, 256, drawVomixLogo);
fs.writeFileSync(path.join(tauriIconsDir, 'icon.ico'), icoBuffer);
console.log('  ✓ Создан Windows контейнер icon.ico');

console.log('✨ Все иконки VOMIXStudio успешно сформированы!');
