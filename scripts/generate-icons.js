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

// Генератор Windows ICO (3.00 Format) для совместимости с Microsoft RC.EXE и Windows Resource Compiler
function createDIB(width, height, drawPixel) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize (40 bytes BITMAPINFOHEADER)
  header.writeInt32LE(width, 4); // biWidth
  header.writeInt32LE(height * 2, 8); // biHeight * 2 (XOR mask + AND mask)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount (32-bit BGRA)
  header.writeUInt32LE(0, 16); // biCompression (BI_RGB)

  const xorSize = width * height * 4;
  const andRowBytes = Math.ceil(width / 32) * 4;
  const andSize = andRowBytes * height;
  header.writeUInt32LE(xorSize + andSize, 20); // biSizeImage

  // XOR mask (bottom-to-top, BGRA)
  const xorData = Buffer.alloc(xorSize);
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawPixel(x, srcY, width, height);
      const offset = (y * width + x) * 4;
      xorData[offset] = b;
      xorData[offset + 1] = g;
      xorData[offset + 2] = r;
      xorData[offset + 3] = a;
    }
  }

  // AND mask (bottom-to-top, 1-bit per pixel, 0 = opaque, 1 = transparent)
  const andData = Buffer.alloc(andSize);
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawPixel(x, srcY, width, height);
      if (a === 0) {
        const byteOffset = y * andRowBytes + Math.floor(x / 8);
        const bitOffset = 7 - (x % 8);
        andData[byteOffset] |= (1 << bitOffset);
      }
    }
  }

  return Buffer.concat([header, xorData, andData]);
}

function buildWindowsIco(dibImages) {
  const count = dibImages.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 for icon
  header.writeUInt16LE(count, 4); // count of icon images

  const entries = [];
  const datas = [];

  for (const img of dibImages) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.width >= 256 ? 0 : img.width, 0); // bWidth
    entry.writeUInt8(img.height >= 256 ? 0 : img.height, 1); // bHeight
    entry.writeUInt8(0, 2); // bColorCount
    entry.writeUInt8(0, 3); // bReserved
    entry.writeUInt16LE(1, 4); // wPlanes
    entry.writeUInt16LE(32, 6); // wBitCount
    entry.writeUInt32LE(img.data.length, 8); // dwBytesInRes
    entry.writeUInt32LE(offset, 12); // dwImageOffset

    entries.push(entry);
    datas.push(img.data);
    offset += img.data.length;
  }

  return Buffer.concat([header, ...entries, ...datas]);
}

const icoImages = [
  { width: 16, height: 16, data: createDIB(16, 16, drawVomixLogo) },
  { width: 32, height: 32, data: createDIB(32, 32, drawVomixLogo) },
  { width: 48, height: 48, data: createDIB(48, 48, drawVomixLogo) },
  { width: 64, height: 64, data: createDIB(64, 64, drawVomixLogo) },
  { width: 128, height: 128, data: createDIB(128, 128, drawVomixLogo) },
  { width: 256, height: 256, data: createDIB(256, 256, drawVomixLogo) },
];

const icoBuffer = buildWindowsIco(icoImages);
fs.writeFileSync(path.join(tauriIconsDir, 'icon.ico'), icoBuffer);
console.log(`  ✓ Создан Windows 3.00 совместимый icon.ico (${icoBuffer.length} байт, 6 разрешений)`);

// Создаем macOS Apple ICNS контейнер для Tauri и macOS / Linux
function makeIcnsChunk(type, data) {
  const buf = Buffer.alloc(8 + data.length);
  buf.write(type, 0, 4, 'ascii');
  buf.writeUInt32BE(8 + data.length, 4);
  data.copy(buf, 8);
  return buf;
}

const png128 = createPNG(128, 128, drawVomixLogo);
const png256 = createPNG(256, 256, drawVomixLogo);
const png512 = createPNG(512, 512, drawVomixLogo);

const chunk128 = makeIcnsChunk('ic07', png128);
const chunk256 = makeIcnsChunk('ic08', png256);
const chunk512 = makeIcnsChunk('ic09', png512);

const totalIcnsLen = 8 + chunk128.length + chunk256.length + chunk512.length;
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns', 0, 4, 'ascii');
icnsHeader.writeUInt32BE(totalIcnsLen, 4);

const icnsBuffer = Buffer.concat([icnsHeader, chunk128, chunk256, chunk512]);
fs.writeFileSync(path.join(tauriIconsDir, 'icon.icns'), icnsBuffer);
console.log('  ✓ Создан macOS контейнер icon.icns');

console.log('✨ Все иконки VOMIXStudio успешно сформированы!');
