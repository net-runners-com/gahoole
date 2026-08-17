import fs from 'fs';

try {
  const data = fs.readFileSync('bench-tmp/nums.txt', 'utf8');
  const nums = data.trim().split('\n').map(Number);
  nums.sort((a, b) => a - b);
  fs.writeFileSync('bench-tmp/sorted.txt', nums.join('\n') + '\n');
} catch (err) {
  console.error(err);
  process.exit(1);
}