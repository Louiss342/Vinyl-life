// 生成 3 秒 440Hz 正弦波 WAV（测试音频，无依赖）
const fs = require('fs');

function genWav(seconds, freq) {
  const rate = 44100;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  const fade = Math.floor(rate * 0.05);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, i / fade, (n - i) / fade);
    const v = Math.round(Math.sin(2 * Math.PI * freq * t) * 0.4 * 32767 * env);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const target = process.argv[2];
if (!target) {
  console.error('usage: node gen-audio.cjs <output.wav>');
  process.exit(1);
}
fs.writeFileSync(target, genWav(3, 440));
console.log('wrote', target, (fs.statSync(target).size / 1024).toFixed(0) + 'KB');
